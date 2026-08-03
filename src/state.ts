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
	// Endless loop: the model cannot close it. "done" is converted into an
	// advance, so only /loop-stop or Ctrl+Shift+X ends it. This is a flag on
	// goal mode rather than a third LoopMode, so every `mode === "passes"`
	// branch stays untouched.
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
					: `This is the **final pass**. Do a final polish, then call loop_control with status "done".`,
			`\nWhen this pass is complete, call loop_control with status "next" (or "done" on the final pass).`,
		].join("\n");
	}

	if (state.forever) {
		return [
			`## Loop — Iteration ${step + 1} (forever)`,
			`Task: ${state.goal}`,
			`Keep working on the task. This loop does not end on its own.`,
			`When this iteration is complete, call loop_control with status "next" to continue into the next one.`,
			`Status "done" is ignored here — only the user can stop this loop.`,
		].join("\n");
	}

	// Goal mode — open-ended
	return [
		`## Loop — Iteration ${step + 1}`,
		`Goal: ${state.goal}`,
		`Work toward the goal. When the goal is fully met, call loop_control with status "done" and explain why.`,
		`If more work is needed, call loop_control with status "next" describing what's left.`,
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

// Steer message sent when the model ends its turn with the loop still
// open. It tells the model to keep working — not to call loop_control —
// because a turn that ends without closing the loop is usually a bug-end,
// not a deliberate completion.
export function buildNudgePrompt(state: LoopState): string {
	const label =
		state.mode === "passes"
			? `pass ${state.currentStep + 1}/${state.maxSteps}`
			: `iteration ${state.currentStep + 1}`;
	return [
		`The loop is still active — you ended your turn before finishing ${label}.`,
		`Continue working on: ${state.goal}`,
		"Do not end your turn until this iteration is complete.",
		...(state.forever
			? ["This loop runs until the user stops it; it has no final iteration."]
			: []),
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

	const label =
		state.mode === "passes"
			? `pass ${state.currentStep + 1}/${state.maxSteps}`
			: `iter ${state.currentStep + 1}`;
	const forever = state.forever ? " · forever" : "";

	ctx.ui.setStatus("loop", `loop · ${label}${forever}`);
	ctx.ui.setWidget("loop", [
		`${label}${forever} · ${state.goal}`,
		"Ctrl+Shift+X to stop",
	]);
}

// System prompt injection logic
export function getSystemPromptAddition(state: LoopState): string {
	return [
		"",
		"",
		"## Active Loop",
		`Mode: ${state.mode}${state.forever ? " (forever)" : ""} | Step: ${state.currentStep + 1}/${state.maxSteps === null ? "∞" : state.maxSteps}`,
		`Goal: ${state.goal}`,
		"You MUST call `loop_control` when you finish your work for this iteration.",
		state.forever
			? 'Use status "next" to advance. This loop never ends on its own — "done" is ignored, only the user can stop it.'
			: 'Use status "next" to advance or "done" when the goal is fully met.',
	].join("\n");
}
