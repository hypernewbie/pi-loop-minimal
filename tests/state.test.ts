import { describe, expect, it } from "vitest";
import {
	buildEvaluationPrompt,
	buildNudgePrompt,
	buildPrompt,
	buildResumePrompt,
	emptyState,
	getSystemPromptAddition,
	parseForeverArgs,
	parseGoalArgs,
	updateWidget,
} from "../src/state.ts";
import type { LoopState } from "../src/state.ts";
import {
	captureUi,
	claimingState,
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
			evaluating: false,
			claimReason: "",
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
			evaluating: false,
		});
	});

	it("requires a task description", () => {
		expect(parseForeverArgs(["forever"])).toBe("Provide a task description");
		expect(parseForeverArgs([])).toBe("Provide a task description");
	});

	it("leaves the goal form unflagged", () => {
		expect(parseOk(parseGoalArgs(["goal", "x"])).forever).toBe(false);
		expect(emptyState().forever).toBe(false);
		expect(parseOk(parseGoalArgs(["goal", "x"])).evaluating).toBe(false);
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

describe("buildEvaluationPrompt", () => {
	it("asks whether the goal has actually been reached", () => {
		const p = buildEvaluationPrompt(claimingState(2));
		expect(p).toContain("## Loop — Confirmation check");
		expect(p).toContain("Goal: green tests");
		expect(p).toContain("A claim was made that the goal is met: all tests are green");
		expect(p).toContain("Has the goal actually been reached?");
		expect(p).toContain('verdict "reached"');
		expect(p).toContain('verdict "not_reached"');
	});

	it("tells the model to judge the goal, not the claim", () => {
		const p = buildEvaluationPrompt(claimingState(0));
		expect(p).toContain("Judge it against the goal itself, not against the claim");
	});
});

describe("buildResumePrompt", () => {
	it("sends the model back to work with the reason it stayed open", () => {
		const p = buildResumePrompt(claimingState(1), "the build fails");
		expect(p).toContain("## Loop — Iteration 2 (not confirmed)");
		expect(p).toContain("Goal: green tests");
		expect(p).toContain("The loop is still open: the build fails");
		expect(p).toContain("The claim was: all tests are green");
		expect(p).toContain("Keep working on the goal");
	});

	it("pushes on even when the goal looks unreachable", () => {
		const p = buildResumePrompt(claimingState(1), "impossible to reach");
		expect(p).toContain("impossible to reach");
		expect(p).toContain("If part of it looks unreachable, do what is achievable and keep going");
		expect(p).toContain("the loop only closes when a claim is confirmed");
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

	it("tells the model to claim completion only with a reason", () => {
		const p = getSystemPromptAddition(goalState());
		expect(p).toContain("Call `loop_done` only when the goal is fully met");
	});

	it("never mentions an advance action", () => {
		const p = getSystemPromptAddition(goalState());
		expect(p).not.toMatch(/status\s+"?(next|done)/i);
		expect(p).not.toMatch(/advance or/i);
	});

	it("tells the model a claim is confirmed before the loop closes", () => {
		const p = getSystemPromptAddition(goalState());
		expect(p).toContain("a claim is confirmed in a follow-up check");
	});

	it("switches to check instructions while a claim is pending", () => {
		const p = getSystemPromptAddition(claimingState(1));
		expect(p).toContain("## Active Loop — Confirmation check");
		expect(p).toContain("Call `loop_approve` with your verdict");
		expect(p).not.toContain("loop_done");
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

	it("shows the check phase instead of an iteration", () => {
		const u = captureUi();
		updateWidget(claimingState(4), u.ctx);
		expect(u.status).toBe("loop · evaluating");
		expect(u.widget).toEqual([
			"evaluating · green tests",
			"Ctrl+Shift+X to stop",
		]);
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
