// loop-state.ts — Types and utilities for the loop extension
//
// Ported from pi-agent-loop@0.1.1 (MIT): pipeline mode and its `stages`
// field are removed; the count mode is now invoked as `/loop <N> <task>`;
// `maxSteps` is `null` for goal mode instead of `Infinity`, because
// Infinity becomes null when tool-result details are serialized as JSON
// (reconstruction of a goal loop used to see `maxSteps: null`).

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type LoopMode = "goal" | "passes";

export interface LoopState {
	active: boolean;
	mode: LoopMode;
	currentStep: number;
	maxSteps: number | null; // null = unbounded (goal mode), N for count mode
	goal: string; // User's description of what we're doing
	done: boolean; // LLM signaled completion
	reasonDone: string; // Why the LLM stopped
	// Endless loop: continuation happens at agent_end, without exposing
	// loop_control to the model. Only /loop-stop or Ctrl+Shift+X ends it.
	// This is a flag on goal mode rather than a third LoopMode, so every
	// `mode === "passes"` branch stays untouched.
	forever: boolean;
}

export function emptyState(): LoopState {
	return {
		active: false,
		mode: "goal",
		currentStep: 0,
		maxSteps: 0,
		goal: "",
		done: false,
		reasonDone: "",
		forever: false,
	};
}

// Build the steer message for the current iteration
export function buildPrompt(state: LoopState): string {
	const step = state.currentStep;

	if (state.mode === "passes") {
		const max = state.maxSteps ?? 0;
		return [
			`## Loop — Pass ${step + 1} of ${max}`,
			`Task: ${state.goal}`,
			step === 0
				? `This is the first pass. Do an initial implementation/analysis.`
				: step < max - 1
					? `This is a refinement pass. Review and improve on the previous pass.`
					: `This is the **final pass**. Do a final polish, then end your turn — the loop completes on its own.`,
			`\nEach pass ends when you end your turn. Call loop_control only to end the loop early, with your reason.`,
		].join("\n");
	}

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
		`When the goal is fully met, call loop_control and give the reason why.`,
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
		mode: "goal",
		currentStep: 0,
		maxSteps: null,
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
		mode: "goal",
		currentStep: 0,
		maxSteps: null,
		goal: task,
		done: false,
		reasonDone: "",
		forever: true,
	};
}

export function parsePassesArgs(parts: string[]): LoopState | string {
	// parts[0] is the count: /loop <N> <task>
	const n = Number(parts[0]);
	if (!Number.isInteger(n) || n < 1) {
		return "Provide a valid number of passes";
	}
	const task = parts.slice(1).join(" ");
	if (!task) {
		return "Provide a task description";
	}
	return {
		active: true,
		mode: "passes",
		currentStep: 0,
		maxSteps: n,
		goal: task,
		done: false,
		reasonDone: "",
		forever: false,
	};
}

// Continuation message for a forever loop: the model ended its turn, the
// work session stays open. Forever loops have no iteration counter — the
// same turn-end drives both the goal/count advance and this continuation.
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

	const label =
		state.mode === "passes"
			? `pass ${state.currentStep + 1}/${state.maxSteps}`
			: `iter ${state.currentStep + 1}`;

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
		`Mode: ${state.mode} | Step: ${state.currentStep + 1}/${state.maxSteps === null ? "∞" : state.maxSteps}`,
		`Goal: ${state.goal}`,
		"The loop advances automatically when you end your turn.",
		"Call `loop_control` only when the goal is fully met — it ends the loop and records your reason.",
	].join("\n");
}
