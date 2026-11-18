// state.ts — Types and utilities for the loop extension
//
// Two loop forms remain:
//   /loop goal <description>  — iterate until the model calls loop_done
//   /loop forever <task>      — iterate until the user stops it
//
// The count form (`/loop <N> <task>`) was removed: with the advance action
// gone from the model-facing tool, a pass had no meaning beyond "one model
// turn", and a loop that ends when the goal is met is the useful case.
//
// Ported from pi-agent-loop@0.1.1 (MIT): pipeline mode and its `stages`
// field are removed; the count mode is gone as well; `maxSteps` is gone with
// it, so no Infinity sentinel can survive a JSON round trip.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface LoopState {
	active: boolean;
	currentStep: number; // completed iterations
	goal: string; // User's description of what we're doing
	done: boolean; // the loop was closed
	reasonDone: string; // Why the loop stopped
	// Endless loop: continuation happens at agent_end, without exposing
	// loop_done to the model. Only /loop-stop or Ctrl+Shift+X ends it.
	forever: boolean;
}

export function emptyState(): LoopState {
	return {
		active: false,
		currentStep: 0,
		goal: "",
		done: false,
		reasonDone: "",
		forever: false,
	};
}

// Build the steer message for the current iteration
export function buildPrompt(state: LoopState): string {
	const step = state.currentStep;

	if (state.forever) {
		return [
			"## Forever Loop",
			`Task: ${state.goal}`,
			"This work session remains active until the user stops it.",
			"Continue working on the task. Use the available tools when they help.",
		].join("\n");
	}

	// Goal mode — open-ended
	return [
		`## Loop — Iteration ${step + 1}`,
		`Goal: ${state.goal}`,
		`Work toward the goal.`,
		`Each iteration ends when you end your turn — the loop continues automatically.`,
		`When the goal is fully met, call loop_done and give the reason why.`,
	].join("\n");
}

// Argument parsing helpers

export function parseGoalArgs(parts: string[]): LoopState | string {
	const goal = parts.slice(1).join(" ");
	if (!goal) {
		return "Provide a goal description";
	}
	return {
		active: true,
		currentStep: 0,
		goal,
		done: false,
		reasonDone: "",
		forever: false,
	};
}

// /loop forever <task> — runs until the user stops it
export function parseForeverArgs(parts: string[]): LoopState | string {
	const task = parts.slice(1).join(" ");
	if (!task) {
		return "Provide a task description";
	}
	return {
		active: true,
		currentStep: 0,
		goal: task,
		done: false,
		reasonDone: "",
		forever: true,
	};
}

// Continuation message for a forever loop: the model ended its turn, the work
// session stays open. Forever loops have no iteration counter — the same
// turn-end drives both the goal advance and this continuation.
export function buildNudgePrompt(state: LoopState): string {
	return [
		"The forever loop remains active.",
		`Continue working on: ${state.goal}`,
		"Only the user can stop this work session.",
	].join("\n");
}

// Widget update logic — compact two-line widget, no box, no emoji.
// Status (footer) carries the compact loop label; the widget above the
// editor shows the label plus the goal and the stop hint.
export function updateWidget(state: LoopState, ctx: ExtensionContext) {
	if (!state.active) {
		ctx.ui.setStatus("loop", undefined);
		ctx.ui.setWidget("loop", undefined);
		return;
	}

	if (state.forever) {
		ctx.ui.setStatus("loop", "loop · forever");
		ctx.ui.setWidget("loop", [
			`forever · ${state.goal}`,
			"Ctrl+Shift+X to stop",
		]);
		return;
	}

	const label = `iter ${state.currentStep + 1}`;

	ctx.ui.setStatus("loop", `loop · ${label}`);
	ctx.ui.setWidget("loop", [
		`${label} · ${state.goal}`,
		"Ctrl+Shift+X to stop",
	]);
}

// System prompt injection logic
export function getSystemPromptAddition(state: LoopState): string {
	if (state.forever) {
		return [
			"",
			"",
			"## Active Forever Loop",
			`Task: ${state.goal}`,
			"Continue working until the user stops this work session.",
		].join("\n");
	}

	return [
		"",
		"",
		"## Active Loop",
		`Goal: ${state.goal}`,
		`Iteration: ${state.currentStep + 1}`,
		"The loop advances automatically when you end your turn.",
		"Call `loop_done` only when the goal is fully met — it ends the loop and records your reason.",
	].join("\n");
}
