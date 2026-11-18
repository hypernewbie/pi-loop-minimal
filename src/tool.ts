// tool.ts — Tool definition, execution, and rendering for loop_done
//
// loop_done has exactly one job: end the loop, with a justification.
// It used to be `loop_control` with a "next" action that let the model
// advance the loop itself, which meant a badly behaving model could
// manufacture progress by calling next over and over. The extension now owns
// iteration boundaries: a turn that ends advances the loop, and the model can
// only close it.
//
// Ported from pi-agent-loop@0.1.1 (MIT). Changes from the original:
// the pipeline branch is removed, the advance action is gone, and the tool
// was renamed to loop_done so its single verb is obvious.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { LoopState } from "./state.js";

export const LOOP_DONE_TOOL = "loop_done";

export interface LoopDoneParams {
	reason?: string;
}

export function handleLoopDoneTool(
	params: LoopDoneParams,
	state: LoopState,
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

	// A forever loop never exposes this tool. This guard is defense in depth
	// for stale/direct calls: it must not advance, end, or persist loop state.
	if (state.forever) {
		return {
			content: [
				{
					type: "text",
					text: "loop_done is unavailable during a forever loop.",
				},
			],
			details: undefined,
			newState: state,
		};
	}

	// A missing or blank reason means the call was not a valid end-of-loop
	// signal (a legacy "next" call, for example). It must not change state.
	const reason =
		typeof params.reason === "string" ? params.reason.trim() : "";
	if (!reason) {
		return {
			content: [
				{
					type: "text",
					text: "loop_done needs a reason: state why the goal is met. The loop is still active.",
				},
			],
			details: undefined,
			newState: state,
		};
	}

	const newState = {
		...state,
		done: true,
		reasonDone: reason,
		active: false,
	};
	return {
		content: [
			{
				type: "text",
				text: `✓ Loop complete after ${state.currentStep + 1} iteration(s). Reason: ${newState.reasonDone}`,
			},
		],
		details: { ...newState } as LoopState,
		newState,
	};
}

export function getLoopDoneToolDefinition() {
	return {
		name: LOOP_DONE_TOOL,
		label: "Loop Done",
		description: [
			"End the active loop. Call this only when the goal is fully met.",
			"The loop continues by itself after each turn — this tool only closes it.",
			"reason: why the goal is met.",
		].join(" "),
		parameters: Type.Object({
			reason: Type.String({
				description: "Why the goal is met (recorded as the completion reason)",
			}),
		}),
		prepareArguments(args: unknown): { reason: string } {
			// Older sessions stored { status: "done", summary, reason } calls.
			// Fold them into the current shape; a legacy "next" call has no
			// equivalent any more, so it folds to an empty reason, which the
			// tool rejects — a stale call must not end the loop.
			const a = (args ?? {}) as {
				status?: string;
				reason?: string;
				summary?: string;
			};
			if (a.status === "done") {
				return { reason: a.reason ?? a.summary ?? "Goal met" };
			}
			return { reason: a.reason ?? "" };
		},
	};
}

export function renderLoopDoneCall(args: { reason?: string }, theme: unknown) {
	const t = theme as {
		fg: (k: string, s: string) => string;
		bold: (s: string) => string;
	};
	const reason = (args.reason ?? "").trim();
	const shown = reason.length > 60 ? `${reason.slice(0, 57)}…` : reason;
	return new Text(
		t.fg("toolTitle", t.bold("loop_done ")) +
			t.fg("success", shown || "(no reason)"),
		0,
		0,
	);
}

export function renderLoopDoneResult(
	result: { details?: LoopState },
	_opts: unknown,
	theme: unknown,
) {
	const d = result.details as LoopState | undefined;
	if (!d) return new Text("", 0, 0);
	const t = theme as { fg: (color: string, text: string) => string };
	// currentStep is the number of iterations already completed, so the widget
	// shows the one now running while a result shows what just finished.
	const label = d.done
		? "✓ loop complete"
		: d.forever
			? `→ iter ${d.currentStep} · forever`
			: `→ iter ${d.currentStep}`;
	return new Text(t.fg(d.done ? "success" : "accent", label), 0, 0);
}
