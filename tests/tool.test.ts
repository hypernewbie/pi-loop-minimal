import { describe, expect, it } from "vitest";
import {
	getLoopDoneToolDefinition,
	handleLoopDoneTool,
	renderLoopDoneCall,
	renderLoopDoneResult,
} from "../src/tool.ts";
import type { LoopState } from "../src/state.ts";
import { foreverState, goalState } from "./helpers.ts";

describe("handleLoopDoneTool — no active loop", () => {
	it("returns a no-op result without touching state", () => {
		const state: LoopState = {
			active: false,
			currentStep: 0,
			goal: "",
			done: false,
			reasonDone: "",
			forever: false,
		};
		const r = handleLoopDoneTool({ reason: "x" }, state);
		expect(r.content[0].text).toBe("No active loop. Start one with /loop.");
		expect(r.details).toBeUndefined();
		expect(r.newState).toBe(state);
	});
});

describe("handleLoopDoneTool — ending a loop", () => {
	it("completes with the justification", () => {
		const r = handleLoopDoneTool({ reason: "all green" }, goalState(2));
		expect(r.newState.done).toBe(true);
		expect(r.newState.active).toBe(false);
		expect(r.newState.reasonDone).toBe("all green");
		expect(r.content[0].text).toContain("Loop complete after 3 iteration(s)");
		expect(r.content[0].text).toContain("all green");
		expect(r.details).toMatchObject({ active: false, done: true });
	});

	it("trims the justification", () => {
		const r = handleLoopDoneTool({ reason: "  done  " }, goalState(0));
		expect(r.newState.reasonDone).toBe("done");
	});

	it("ends a goal loop", () => {
		const r = handleLoopDoneTool({ reason: "goal met" }, goalState(4));
		expect(r.newState.done).toBe(true);
		expect(r.newState.active).toBe(false);
		expect(r.content[0].text).toContain("Loop complete after 5 iteration(s)");
	});

	it("rejects a call without a justification and changes nothing", () => {
		const before = goalState(1);
		const r = handleLoopDoneTool({}, before);
		expect(r.newState).toBe(before);
		expect(r.details).toBeUndefined();
		expect(r.content[0].text).toContain("needs a reason");
		expect(r.content[0].text).toContain("still active");
	});

	it("rejects a blank justification and changes nothing", () => {
		const before = goalState(1);
		const r = handleLoopDoneTool({ reason: "   " }, before);
		expect(r.newState).toBe(before);
		expect(r.details).toBeUndefined();
	});

	it("never advances the loop — the extension owns iteration boundaries", () => {
		const before = goalState(0);
		const r = handleLoopDoneTool({ reason: "just because" }, before);
		expect(r.newState.currentStep).toBe(0);
		expect(r.newState.active).toBe(false);
	});
});

describe("handleLoopDoneTool — forever loops", () => {
	it.each(["next", "done"] as const)(
		"does not let a stale %s call change state",
		(status) => {
			const before = foreverState(5);
			const r = handleLoopDoneTool({ reason: status }, before);
			expect(r.newState).toBe(before);
			expect(r.details).toBeUndefined();
			expect(r.content[0].text).toBe(
				"loop_done is unavailable during a forever loop.",
			);
		},
	);
});

describe("tool definition", () => {
	it("registers the loop_control name and description", () => {
		const def = getLoopDoneToolDefinition();
		expect(def.name).toBe("loop_done");
		expect(def.label).toBe("Loop Done");
		expect(def.description).toContain("End the active loop");
	});

	it("offers no advance action at all", () => {
		const def = getLoopDoneToolDefinition();
		const description = def.description.toLowerCase();
		expect(description).not.toContain("next");
		expect(description).not.toContain("advance");
		expect(description).not.toContain("status");
	});

	it("requires a reason and nothing else", () => {
		const def = getLoopDoneToolDefinition();
		const props = def.parameters.properties as Record<string, unknown>;
		expect(Object.keys(props)).toEqual(["reason"]);
		expect(def.parameters.required).toEqual(["reason"]);
	});

	it("folds a legacy done call into the current shape", () => {
		const def = getLoopDoneToolDefinition();
		const fold = def.prepareArguments as (args: unknown) => { reason: string };
		expect(fold({ status: "done", summary: "shipped it" })).toEqual({
			reason: "shipped it",
		});
		expect(fold({ status: "done", reason: "because" })).toEqual({
			reason: "because",
		});
		expect(fold({ status: "done" })).toEqual({ reason: "Goal met" });
	});

	it("folds a legacy next call into a call the tool rejects", () => {
		const def = getLoopDoneToolDefinition();
		const fold = def.prepareArguments as (args: unknown) => { reason: string };
		expect(fold({ status: "next", summary: "keep going" })).toEqual({
			reason: "",
		});
	});
});

describe("renderers", () => {
	const theme = {
		fg: (c: string, t: string) => `<${c}>${t}</${c}>`,
		bold: (s: string) => `**${s}**`,
	};

	it("renders the call as an end-of-loop action", () => {
		const r = renderLoopDoneCall({ reason: "goal met" }, theme);
		expect(r.render(200)[0].startsWith(
			"<toolTitle>**loop_done **</toolTitle><success>goal met</success>",
		)).toBe(true);
	});

	it("renders a completion result", () => {
		const r = renderLoopDoneResult(
			{ details: { ...goalState(2), done: true, active: false } },
			{},
			theme,
		);
		expect(r.render(200)[0].startsWith("<success>✓ loop complete</success>")).toBe(
			true,
		);
	});

	it("keeps legacy forever result rendering for old session history", () => {
		const r = renderLoopDoneResult(
			{ details: { ...foreverState(3), currentStep: 3 } },
			{},
			theme,
		);
		expect(r.render(50)[0]).toContain("iter 3 · forever");
	});
});
