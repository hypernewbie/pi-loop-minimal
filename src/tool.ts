// loop-tool.ts — Tool definition, execution, and rendering for loop_control
//
// Ported from pi-agent-loop@0.1.1 (MIT). Changes from the original:
// the pipeline branch is removed, and the `setTimeout(..., 100)` before the
// advance message is dropped — `deliverAs: "steer"` already queues the
// message until after the current assistant turn finishes its tool calls,
// so sending synchronously is safe and removes the ordering race.

import { StringEnum } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { JudgeResult } from "./judge.js";
import { buildPrompt, type LoopState } from "./state.js";

export function handleLoopControlTool(
	params: { status: "next" | "done"; summary: string; reason?: string },
	state: LoopState,
	pi: ExtensionAPI,
	_ctx: ExtensionContext,
	// Judge outcome for a judged loop's "done"; undefined when unjudged.
	judge?: JudgeResult,
): {
	content: { type: "text"; text: string }[];
	details: LoopState | undefined;
	newState: LoopState;
} {
	if (!state.active) {
		return {
			content: [
				{ type: "text", text: "No active loop. Start one with /loop." },
			],
			details: undefined,
			newState: state,
		};
	}

	if (params.status === "done") {
		// A user abort during review must not close the loop, and must not be
		// mistaken for a judgement either way.
		if (judge?.kind === "aborted") {
			return {
				content: [
					{
						type: "text",
						text: "Judge review aborted. The loop is still active — nothing was accepted.",
					},
				],
				details: { ...state } as LoopState,
				newState: state,
			};
		}

		// Denied: the loop stays open at the same iteration and the model is
		// told what is missing. The tool result lands mid-turn, so the model
		// simply keeps working; if it ends its turn instead, the agent_end
		// nudge catches it.
		if (judge?.kind === "verdict" && !judge.pass) {
			const newState = { ...state, denials: state.denials + 1 };
			return {
				content: [
					{
						type: "text",
						text: [
							`✗ DENIED by judge (attempt ${newState.denials}). The goal is not met.`,
							judge.reasons ? `Not met: ${judge.reasons}` : "",
							'Keep working. Do not call loop_control with "done" again until this is addressed.',
						]
							.filter(Boolean)
							.join("\n"),
					},
				],
				details: { ...newState } as LoopState,
				newState,
			};
		}

		const newState = {
			...state,
			done: true,
			reasonDone: params.reason ?? params.summary,
			active: false,
		};
		const judged =
			judge?.kind === "verdict"
				? " Judge: passed."
				: judge?.kind === "unavailable"
					? ` (judge unavailable: ${judge.note})`
					: "";
		return {
			content: [
				{
					type: "text",
					text: `✓ Loop complete after ${state.currentStep + 1} iteration(s). Reason: ${newState.reasonDone}${judged}`,
				},
			],
			details: { ...newState } as LoopState,
			newState,
		};
	}

	// status === "next" — advance
	const newState = { ...state, currentStep: state.currentStep + 1 };

	const atEnd =
		state.mode === "passes" && newState.currentStep >= (state.maxSteps ?? 0);

	if (atEnd) {
		const finalState = {
			...newState,
			done: true,
			active: false,
			reasonDone: "Completed all passes",
		};
		return {
			content: [
				{
					type: "text",
					text: `✓ Loop complete — all ${state.maxSteps} iterations done.`,
				},
			],
			details: { ...finalState } as LoopState,
			newState: finalState,
		};
	}

	pi.sendMessage(
		{
			customType: "loop-iteration",
			content: buildPrompt(newState),
			display: false,
		},
		{ triggerTurn: true, deliverAs: "steer" },
	);

	return {
		content: [
			{
				type: "text",
				text: `→ Advancing to step ${newState.currentStep + 1}. Summary: ${params.summary}`,
			},
		],
		details: { ...newState } as LoopState,
		newState,
	};
}

export function getLoopControlToolDefinition() {
	return {
		name: "loop_control",
		label: "Loop Control",
		description: [
			"Signal loop progress. Call this when you finish a loop iteration.",
			"status 'next': advance to the next step/pass.",
			"status 'done': the goal is met or the final pass is complete.",
			"Only available when a loop is active.",
		].join(" "),
		parameters: Type.Object({
			status: StringEnum(["next", "done"] as const),
			summary: Type.String({
				description: "Brief summary of what was accomplished this iteration",
			}),
			reason: Type.Optional(
				Type.String({ description: "Why the goal is met (for 'done')" }),
			),
		}),
	};
}

export function renderLoopControlCall(
	args: { status: string },
	theme: unknown,
) {
	const t = theme as {
		fg: (k: string, s: string) => string;
		bold: (s: string) => string;
	};
	return new Text(
		t.fg("toolTitle", t.bold("loop_control ")) +
			t.fg(args.status === "done" ? "success" : "accent", args.status),
		0,
		0,
	);
}

export function renderLoopControlResult(
	result: { details?: LoopState },
	_opts: unknown,
	theme: unknown,
) {
	const d = result.details as LoopState | undefined;
	if (!d) return new Text("", 0, 0);
	const t = theme as { fg: (color: string, text: string) => string };
	// currentStep is the number of iterations already completed (0-based
	// index of the iteration that just finished), so "next" shows the pass
	// that just completed while the widget shows the one now running.
	if (d.denials > 0 && !d.done) {
		return new Text(t.fg("error", `✗ denied by judge (${d.denials})`), 0, 0);
	}
	const label = d.done
		? "✓ loop complete"
		: d.mode === "passes"
			? `→ pass ${d.currentStep}/${d.maxSteps}`
			: `→ iter ${d.currentStep}`;
	return new Text(t.fg(d.done ? "success" : "accent", label), 0, 0);
}
