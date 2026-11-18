import { describe, expect, it } from "vitest";
import {
	buildNudgePrompt,
	buildPrompt,
	emptyState,
	getSystemPromptAddition,
	parseForeverArgs,
	parseGoalArgs,
	updateWidget,
} from "../src/state.ts";
import type { LoopState } from "../src/state.ts";
import {
	captureUi,
	foreverState,
	goalState,
	parseOk,
} from "./helpers.ts";

describe("emptyState", () => {
	it("is inactive with a zeroed shape", () => {
		expect(emptyState()).toEqual({
			active: false,
			currentStep: 0,
			goal: "",
			done: false,
			reasonDone: "",
			forever: false,
		});
	});
});

describe("parseGoalArgs", () => {
	it("parses a goal with the full remaining text as description", () => {
		const state = parseOk(parseGoalArgs(["goal", "make", "all", "tests", "green"]));
		expect(state.active).toBe(true);
		expect(state.goal).toBe("make all tests green");
		expect(state.currentStep).toBe(0);
		expect(state.done).toBe(false);
	});

	it("keeps punctuation and multiple spaces inside the goal", () => {
		const state = parseOk(parseGoalArgs(["goal", "ship", "the", "thing,", "now!"]));
		expect(state.goal).toBe("ship the thing, now!");
	});

	it("rejects an empty goal", () => {
		expect(parseGoalArgs(["goal"])).toBe("Provide a goal description");
	});
});

describe("parseForeverArgs", () => {
	it("parses /loop forever <task> as an unbounded loop with the flag set", () => {
		const s = parseOk(parseForeverArgs(["forever", "watch", "the", "build"]));
		expect(s).toMatchObject({
			active: true,
			currentStep: 0,
			goal: "watch the build",
			done: false,
			forever: true,
		});
	});

	it("requires a task description", () => {
		expect(parseForeverArgs(["forever"])).toBe("Provide a task description");
		expect(parseForeverArgs([])).toBe("Provide a task description");
	});

	it("leaves the goal form unflagged", () => {
		expect(parseOk(parseGoalArgs(["goal", "x"])).forever).toBe(false);
		expect(emptyState().forever).toBe(false);
	});
});

describe("buildPrompt", () => {
	it("builds an open-ended goal iteration prompt", () => {
		const p = buildPrompt(goalState());
		expect(p).toContain("## Loop — Iteration 1");
		expect(p).toContain("Goal: green tests");
		expect(p).toContain("Each iteration ends when you end your turn");
		expect(p).toContain("call loop_done and give the reason why");
	});

	it("offers the model no advance action in any prompt", () => {
		for (const s of [goalState(), foreverState()]) {
			const p = buildPrompt(s);
			expect(p).not.toMatch(/status\s+"?(next|done)/i);
			expect(p).not.toMatch(/loop_done[^.]*\bnext\b/i);
		}
	});

	it("advances the iteration number with currentStep", () => {
		const p = buildPrompt(goalState(4));
		expect(p).toContain("## Loop — Iteration 5");
	});
});

describe("buildNudgePrompt", () => {
	it("continues a forever loop without mentioning loop_done", () => {
		const p = buildNudgePrompt(foreverState());
		expect(p).toContain("The forever loop remains active");
		expect(p).toContain("Continue working on: watch the build");
		expect(p).toContain("Only the user can stop");
		expect(p).not.toContain("loop_done");
	});
});

describe("getSystemPromptAddition", () => {
	it("shows the goal and the iteration", () => {
		const p = getSystemPromptAddition(goalState());
		expect(p).toContain("Goal: green tests");
		expect(p).toContain("Iteration: 1");
		expect(p).toContain("The loop advances automatically when you end your turn");
		expect(p).toContain("Call `loop_done` only when the goal is fully met");
	});

	it("tells the model to end the loop only with a reason", () => {
		const p = getSystemPromptAddition(goalState());
		expect(p).toContain("records your reason");
	});

	it("never mentions an advance action", () => {
		const p = getSystemPromptAddition(goalState());
		expect(p).not.toMatch(/status\s+"?(next|done)/i);
		expect(p).not.toMatch(/advance or/i);
	});
});

describe("updateWidget", () => {
	it("clears status and widget when inactive", () => {
		const u = captureUi();
		updateWidget(emptyState(), u.ctx);
		expect(u.status).toBeUndefined();
		expect(u.widget).toBeUndefined();
	});

	it("renders a compact goal label", () => {
		const u = captureUi();
		updateWidget(goalState(), u.ctx);
		expect(u.status).toBe("loop · iter 1");
		expect(u.widget).toEqual(["iter 1 · green tests", "Ctrl+Shift+X to stop"]);
	});

	it("advances the label with currentStep", () => {
		const u = captureUi();
		updateWidget(goalState(3), u.ctx);
		expect(u.widget).toEqual(["iter 4 · green tests", "Ctrl+Shift+X to stop"]);
	});

	it("uses no emoji or box-drawing characters", () => {
		const u = captureUi();
		updateWidget(goalState(), u.ctx);
		const all = JSON.stringify([u.status, u.widget]);
		expect(all).not.toMatch(/[🔄┌┐└┘│]/);
	});
});

// keep LoopState referenced for type-level completeness of helpers
export type { LoopState };

describe("forever loops", () => {
	it("uses a tool-free continuation prompt", () => {
		const p = buildPrompt(foreverState(2));
		expect(p).toContain("## Forever Loop");
		expect(p).toContain("Task: watch the build");
		expect(p).toContain("remains active until the user stops it");
		expect(p).toContain("Use the available tools");
		expect(p).not.toMatch(/loop_done|next|done|Iteration/i);
	});

	it("keeps the ordinary goal prompt for unflagged goal loops", () => {
		expect(buildPrompt(goalState())).not.toContain("forever");
	});

	it("marks the loop endless without manufacturing an iteration count", () => {
		const u = captureUi();
		updateWidget(foreverState(4), u.ctx);
		expect(u.status).toBe("loop · forever");
		expect(u.widget).toEqual([
			"forever · watch the build",
			"Ctrl+Shift+X to stop",
		]);
	});

	it("continues a bug-ended turn without control vocabulary", () => {
		const n = buildNudgePrompt(foreverState(1));
		expect(n).toContain("The forever loop remains active");
		expect(n).toContain("Continue working on: watch the build");
		expect(n).toContain("Only the user can stop");
		expect(n).not.toMatch(/loop_done|next|done|iteration/i);
	});

	it("keeps control vocabulary out of its system addition", () => {
		const p = getSystemPromptAddition(foreverState());
		expect(p).toContain("## Active Forever Loop");
		expect(p).toContain("Continue working until the user stops");
		expect(p).not.toMatch(/loop_done|next|done|step|iteration/i);
		expect(getSystemPromptAddition(goalState())).toContain(
			"when the goal is fully met",
		);
	});
});
