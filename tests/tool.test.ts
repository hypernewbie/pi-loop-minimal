import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getLoopControlToolDefinition,
	handleLoopControlTool,
	renderLoopControlCall,
	renderLoopControlResult,
} from "../src/tool.ts";
import type { LoopState } from "../src/state.ts";
import { countState, goalState } from "./helpers.ts";

type ToolParams = { status: "next" | "done"; summary: string; reason?: string };

function makePi() {
	const messages: { msg: { customType?: string; content?: string; display?: boolean }; opts: unknown }[] = [];
	const pi = {
		sendMessage: (msg: unknown, opts: unknown) =>
			messages.push({ msg: msg as never, opts }),
	} as unknown as ExtensionAPI;
	return { pi, messages };
}

describe("handleLoopControlTool — no active loop", () => {
	it("returns a no-op result without touching state", () => {
		const { pi, messages } = makePi();
		const state: LoopState = {
			active: false,
			mode: "goal",
			currentStep: 0,
			maxSteps: null,
			goal: "",
			done: false,
			reasonDone: "",
		};
		const r = handleLoopControlTool(
			{ status: "next", summary: "x" },
			state,
			pi,
			undefined as never,
		);
		expect(r.content[0].text).toBe(
			"No active loop. Start one with /loop.",
		);
		expect(r.details).toBeUndefined();
		expect(r.newState).toBe(state);
		expect(messages).toHaveLength(0);
	});
});

describe("handleLoopControlTool — done", () => {
	it("completes with the explicit reason", () => {
		const { pi, messages } = makePi();
		const r = handleLoopControlTool(
			{ status: "done", summary: "did it", reason: "all green" },
			countState(2, 5),
			pi,
			undefined as never,
		);
		expect(r.newState.done).toBe(true);
		expect(r.newState.active).toBe(false);
		expect(r.newState.reasonDone).toBe("all green");
		expect(r.content[0].text).toContain("Loop complete after 3 iteration(s)");
		expect(r.content[0].text).toContain("all green");
		expect(messages).toHaveLength(0);
	});

	it("falls back to the summary when no reason is given", () => {
		const { pi } = makePi();
		const r = handleLoopControlTool(
			{ status: "done", summary: "shipped" },
			goalState(4),
			pi,
			undefined as never,
		);
		expect(r.newState.reasonDone).toBe("shipped");
		expect(r.content[0].text).toContain("after 5 iteration(s)");
	});

	it("persists the completed state as tool details", () => {
		const { pi } = makePi();
		const r = handleLoopControlTool(
			{ status: "done", summary: "x" },
			countState(1, 3),
			pi,
			undefined as never,
		);
		expect(r.details).toEqual(r.newState);
	});
});

describe("handleLoopControlTool — next on count loops", () => {
	it("advances before the final pass", () => {
		const { pi, messages } = makePi();
		const r = handleLoopControlTool(
			{ status: "next", summary: "progress" },
			countState(1, 4),
			pi,
			undefined as never,
		);
		expect(r.newState.currentStep).toBe(2);
		expect(r.newState.active).toBe(true);
		expect(r.newState.done).toBe(false);
		expect(r.content[0].text).toBe(
			"→ Advancing to step 3. Summary: progress",
		);
		expect(messages).toHaveLength(1);
	});

	it("steers the next pass synchronously with the built prompt", () => {
		const { pi, messages } = makePi();
		handleLoopControlTool(
			{ status: "next", summary: "s" },
			countState(0, 2),
			pi,
			undefined as never,
		);
		expect(messages[0].msg).toMatchObject({
			customType: "loop-iteration",
			display: false,
		});
		expect(messages[0].msg.content).toContain("## Loop — Pass 2 of 2");
		expect(messages[0].opts).toEqual({
			triggerTurn: true,
			deliverAs: "steer",
		});
	});

	it("completes when advancing past the final pass", () => {
		const { pi, messages } = makePi();
		const r = handleLoopControlTool(
			{ status: "next", summary: "s" },
			countState(2, 3),
			pi,
			undefined as never,
		);
		expect(r.newState.done).toBe(true);
		expect(r.newState.active).toBe(false);
		expect(r.newState.reasonDone).toBe("Completed all passes");
		expect(r.content[0].text).toContain("all 3 iterations done");
		expect(messages).toHaveLength(0);
	});

	it("runs exactly N iterations: next on pass N-1 completes, pass N-2 does not", () => {
		const { pi: pi1, messages: m1 } = makePi();
		const r1 = handleLoopControlTool(
			{ status: "next", summary: "s" },
			countState(1, 3),
			pi1,
			undefined as never,
		);
		expect(r1.newState.done).toBe(false);
		expect(m1).toHaveLength(1);

		const { pi: pi2, messages: m2 } = makePi();
		const r2 = handleLoopControlTool(
			{ status: "next", summary: "s" },
			countState(2, 3),
			pi2,
			undefined as never,
		);
		expect(r2.newState.done).toBe(true);
		expect(m2).toHaveLength(0);
	});
});

describe("handleLoopControlTool — next on goal loops", () => {
	it("advances without ever completing on count", () => {
		const { pi, messages } = makePi();
		const r = handleLoopControlTool(
			{ status: "next", summary: "more" },
			goalState(9),
			pi,
			undefined as never,
		);
		expect(r.newState.done).toBe(false);
		expect(r.newState.active).toBe(true);
		expect(r.newState.currentStep).toBe(10);
		expect(messages).toHaveLength(1);
		expect(messages[0].msg.content).toContain("## Loop — Iteration 11");
	});
});

describe("getLoopControlToolDefinition", () => {
	const def = getLoopControlToolDefinition();

	it("registers the loop_control name and description", () => {
		expect(def.name).toBe("loop_control");
		expect(def.label).toBe("Loop Control");
		expect(def.description).toContain("status 'next'");
		expect(def.description).toContain("status 'done'");
	});

	it("defines status as an enum of next|done", () => {
		const props = def.parameters.properties as Record<string, unknown>;
		expect(Object.keys(props)).toEqual(["status", "summary", "reason"]);
		expect((props.status as { type: string }).type).toBe("string");
		expect((props.status as { enum: string[] }).enum).toEqual(["next", "done"]);
	});

	it("requires exactly status and summary", () => {
		expect(def.parameters.required).toEqual(["status", "summary"]);
		expect(
			(def.parameters.properties.reason as { type: string }).type,
		).toBe("string");
	});
});

describe("renderers", () => {
	const theme = {
		fg: (k: string, s: string) => `<${k}>${s}</${k}>`,
		bold: (s: string) => `**${s}**`,
	} as never;

	it("renders the loop_control call with status color", () => {
		const next = renderLoopControlCall({ status: "next" }, theme);
		expect(next.render(200)[0].startsWith(
			"<toolTitle>**loop_control **</toolTitle><accent>next</accent>",
		)).toBe(true);
		const done = renderLoopControlCall({ status: "done" }, theme);
		expect(done.render(200)[0].startsWith(
			"<toolTitle>**loop_control **</toolTitle><success>done</success>",
		)).toBe(true);
	});

	it("renders nothing when there are no details", () => {
		const r = renderLoopControlResult({}, {}, theme);
		expect(r.render(50)).toEqual([]);
	});

	it("renders completed loops as success", () => {
		const r = renderLoopControlResult(
			{
				details: {
					done: true,
					mode: "goal",
					currentStep: 4,
					maxSteps: null,
				} as LoopState,
			},
			{},
			theme,
		);
		expect(r.render(50)[0].startsWith("<success>✓ loop complete</success>")).toBe(true);
	});

	it("renders count-mode progress with the completed pass count", () => {
		const r = renderLoopControlResult(
			{
				details: {
					done: false,
					mode: "passes",
					currentStep: 2,
					maxSteps: 5,
				} as LoopState,
			},
			{},
			theme,
		);
		expect(r.render(50)[0].startsWith("<accent>→ pass 2/5</accent>")).toBe(true);
	});

	it("renders goal-mode progress as iteration count", () => {
		const r = renderLoopControlResult(
			{
				details: {
					done: false,
					mode: "goal",
					currentStep: 3,
					maxSteps: null,
				} as LoopState,
			},
			{},
			theme,
		);
		expect(r.render(50)[0].startsWith("<accent>→ iter 3</accent>")).toBe(true);
	});
});

export type { ToolParams };
