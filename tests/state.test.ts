import { describe, expect, it } from "vitest";
import {
	buildPrompt,
	emptyState,
	getSystemPromptAddition,
	parseGoalArgs,
	parsePassesArgs,
	updateWidget,
} from "../src/state.ts";
import type { LoopState } from "../src/state.ts";
import { captureUi, countState, goalState, parseOk } from "./helpers.ts";

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
		expect(p).toContain('status "next"');
	});

	it("labels a middle count pass as refinement", () => {
		const mid = buildPrompt(countState(1, 3));
		expect(mid).toContain("## Loop — Pass 2 of 3");
		expect(mid).toContain("This is a refinement pass.");
	});

	it("labels the final count pass and asks for done", () => {
		const last = buildPrompt(countState(2, 3));
		expect(last).toContain("## Loop — Pass 3 of 3");
		expect(last).toContain("This is the **final pass**.");
		expect(last).toContain('call loop_control with status "done"');
	});

	it("builds an open-ended goal iteration prompt", () => {
		const p = buildPrompt(goalState());
		expect(p).toContain("## Loop — Iteration 1");
		expect(p).toContain("Goal: green tests");
		expect(p).toContain('status "done" and explain why');
		expect(p).toContain('status "next" describing what\'s left');
	});

	it("advances the iteration number with currentStep", () => {
		const p = buildPrompt(goalState(4));
		expect(p).toContain("## Loop — Iteration 5");
	});
});

describe("getSystemPromptAddition", () => {
	it("shows ∞ for goal mode", () => {
		const p = getSystemPromptAddition(goalState());
		expect(p).toContain("Mode: goal | Step: 1/∞");
		expect(p).toContain("Goal: green tests");
		expect(p).toContain("You MUST call `loop_control`");
	});

	it("shows the count for passes mode", () => {
		const p = getSystemPromptAddition(countState(2, 7));
		expect(p).toContain("Mode: passes | Step: 3/7");
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
