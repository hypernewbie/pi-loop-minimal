import { describe, expect, it } from "vitest";
import {
	buildNudgePrompt,
	buildPrompt,
	emptyState,
	getSystemPromptAddition,
	parseForeverArgs,
	parseGoalArgs,
	parsePassesArgs,
	updateWidget,
} from "../src/state.ts";
import type { LoopState } from "../src/state.ts";
import {
	captureUi,
	countState,
	foreverState,
	goalState,
	parseOk,
} from "./helpers.ts";

describe("emptyState", () => {
	it("is inactive with a zeroed goal-mode shape", () => {
		expect(emptyState()).toEqual({
			active: false,
			mode: "goal",
			currentStep: 0,
			maxSteps: 0,
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
		expect(state.mode).toBe("goal");
		expect(state.goal).toBe("make all tests green");
		expect(state.maxSteps).toBeNull();
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

describe("parsePassesArgs", () => {
	it("parses /loop <N> <task> with the count at parts[0]", () => {
		const state = parseOk(parsePassesArgs(["3", "refine", "the", "renderer"]));
		expect(state.active).toBe(true);
		expect(state.mode).toBe("passes");
		expect(state.maxSteps).toBe(3);
		expect(state.goal).toBe("refine the renderer");
	});

	it("accepts 1", () => {
		expect(parseOk(parsePassesArgs(["1", "do", "it"])).maxSteps).toBe(1);
	});

	it("rejects 0", () => {
		expect(parsePassesArgs(["0", "task"])).toBe(
			"Provide a valid number of passes",
		);
	});

	it("rejects negative counts", () => {
		expect(parsePassesArgs(["-3", "task"])).toBe(
			"Provide a valid number of passes",
		);
	});

	it("rejects NaN and non-integer counts", () => {
		expect(parsePassesArgs(["abc", "task"])).toBe(
			"Provide a valid number of passes",
		);
		expect(parsePassesArgs(["3.5", "task"])).toBe(
			"Provide a valid number of passes",
		);
	});

	it("rejects sloppy integers like parseInt would accept", () => {
		expect(parsePassesArgs(["3abc", "task"])).toBe(
			"Provide a valid number of passes",
		);
	});

	it("rejects a missing task", () => {
		expect(parsePassesArgs(["3"])).toBe("Provide a task description");
	});
});

describe("buildPrompt", () => {
	it("labels the first count pass", () => {
		const s = parseOk(parsePassesArgs(["3", "polish", "the", "docs"]));
		const p = buildPrompt(s);
		expect(p).toContain("## Loop — Pass 1 of 3");
		expect(p).toContain("Task: polish the docs");
		expect(p).toContain("This is the first pass.");
		expect(p).toContain("Each pass ends when you end your turn");
	});

	it("labels a middle count pass as refinement", () => {
		const mid = buildPrompt(countState(1, 3));
		expect(mid).toContain("## Loop — Pass 2 of 3");
		expect(mid).toContain("This is a refinement pass.");
	});

	it("labels the final count pass as ending on turn end", () => {
		const last = buildPrompt(countState(2, 3));
		expect(last).toContain("## Loop — Pass 3 of 3");
		expect(last).toContain("This is the **final pass**.");
		expect(last).toContain("then end your turn — the loop completes on its own");
	});

	it("builds an open-ended goal iteration prompt", () => {
		const p = buildPrompt(goalState());
		expect(p).toContain("## Loop — Iteration 1");
		expect(p).toContain("Goal: green tests");
		expect(p).toContain("Each iteration ends when you end your turn");
		expect(p).toContain("call loop_control and give the reason why");
	});

	it("offers the model no advance action in any prompt", () => {
		for (const s of [goalState(), countState(1, 3)]) {
			const p = buildPrompt(s);
			expect(p).not.toMatch(/status\s+"?(next|done)/i);
			expect(p).not.toMatch(/loop_control[^.]*\bnext\b/i);
		}
	});

	it("advances the iteration number with currentStep", () => {
		const p = buildPrompt(goalState(4));
		expect(p).toContain("## Loop — Iteration 5");
	});
});

describe("buildNudgePrompt", () => {
	it("continues a forever loop without mentioning loop_control", () => {
		const p = buildNudgePrompt(foreverState());
		expect(p).toContain("The forever loop remains active");
		expect(p).toContain("Continue working on: watch the build");
		expect(p).toContain("Only the user can stop");
		expect(p).not.toContain("loop_control");
	});
});

describe("getSystemPromptAddition", () => {
	it("shows ∞ for goal mode", () => {
		const p = getSystemPromptAddition(goalState());
		expect(p).toContain("Mode: goal | Step: 1/∞");
		expect(p).toContain("Goal: green tests");
		expect(p).toContain("The loop advances automatically when you end your turn");
		expect(p).toContain("Call `loop_control` only when the goal is fully met");
	});

	it("shows the count for passes mode", () => {
		const p = getSystemPromptAddition(countState(2, 7));
		expect(p).toContain("Mode: passes | Step: 3/7");
	});

	it("tells the model to end the loop only with a reason", () => {
		const p = getSystemPromptAddition(goalState());
		expect(p).toContain("records your reason");
	});

	it("never mentions an advance action", () => {
		const p = getSystemPromptAddition(goalState()) + getSystemPromptAddition(countState(0, 3));
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

	it("renders a compact passes label with goal and stop hint", () => {
		const u = captureUi();
		updateWidget(countState(0, 5), u.ctx);
		expect(u.widget).toEqual([
			"pass 1/5 · task",
			"Ctrl+Shift+X to stop",
		]);
	});

	it("renders a compact goal label", () => {
		const u = captureUi();
		updateWidget(goalState(), u.ctx);
		expect(u.status).toBe("loop · iter 1");
		expect(u.widget).toEqual(["iter 1 · green tests", "Ctrl+Shift+X to stop"]);
	});

	it("advances the label with currentStep", () => {
		const u = captureUi();
		updateWidget(countState(3, 5), u.ctx);
		expect(u.widget).toEqual(["pass 4/5 · task", "Ctrl+Shift+X to stop"]);
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
	it("parses /loop forever <task> as an unbounded goal loop with the flag set", () => {
		const s = parseOk(parseForeverArgs(["forever", "watch", "the", "build"]));
		expect(s).toMatchObject({
			active: true,
			mode: "goal",
			currentStep: 0,
			maxSteps: null,
			goal: "watch the build",
			done: false,
			forever: true,
		});
	});

	it("requires a task description", () => {
		expect(parseForeverArgs(["forever"])).toBe("Provide a task description");
		expect(parseForeverArgs([])).toBe("Provide a task description");
	});

	it("leaves the other forms unflagged", () => {
		expect(parseOk(parseGoalArgs(["goal", "x"])).forever).toBe(false);
		expect(parseOk(parsePassesArgs(["3", "x"])).forever).toBe(false);
		expect(emptyState().forever).toBe(false);
	});

	it("uses a tool-free continuation prompt", () => {
		const p = buildPrompt(foreverState(2));
		expect(p).toContain("## Forever Loop");
		expect(p).toContain("Task: watch the build");
		expect(p).toContain("remains active until the user stops it");
		expect(p).toContain("Use the available tools");
		expect(p).not.toMatch(/loop_control|next|done|Iteration/i);
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
		expect(n).not.toMatch(/loop_control|next|done|iteration/i);
	});

	it("keeps control vocabulary out of its system addition", () => {
		const p = getSystemPromptAddition(foreverState());
		expect(p).toContain("## Active Forever Loop");
		expect(p).toContain("Continue working until the user stops");
		expect(p).not.toMatch(/loop_control|next|done|step|iteration/i);
		expect(getSystemPromptAddition(goalState())).toContain("when the goal is fully met");
	});
});
