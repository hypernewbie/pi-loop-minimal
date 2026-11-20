// tool.ts — Tool definition, execution, and rendering for the loop tools
//
// Two tools, never both at once:
//
//   loop_done     (working phase)  — "the goal is met, here is why"
//   loop_approve  (checking phase) — "yes, the goal is reached" / "no, it is not"
//
// loop_done used to be `loop_control` with a "next" action that let the model
// advance the loop itself, which meant a badly behaving model could
// manufacture progress by calling next over and over. The extension now owns
// iteration boundaries: a turn that ends advances the loop, and the model can
// only claim completion. A claim is checked in the next turn before the loop
// closes; an unconfirmed claim is ignored and the loop resumes.
//
// Ported from pi-agent-loop@0.1.1 (MIT). Changes from the original:
// the pipeline branch is removed, the advance action is gone, the tool was
// renamed, and a second tool now confirms the claim.

import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { advanceState, type LoopState } from "./state.js";

export const LOOP_DONE_TOOL = "loop_done";
export const LOOP_APPROVE_TOOL = "loop_approve";
export const LOOP_NEXT_TOOL = "loop_next";

export interface LoopDoneParams {
	reason?: string;
}

export interface LoopApproveParams {
	verdict?: "reached" | "not_reached";
	reason?: string;
}

export interface LoopNextParams {
	summary?: string;
}

export interface ToolOutcome {
	content: { type: "text"; text: string }[];
	details: LoopState | undefined;
	newState: LoopState;
}

/**
 * The model claims the goal is met. This does not close the loop: the claim
 * is checked in the next turn, and only a confirmed claim ends the loop.
 */
export function handleLoopDoneTool(
	params: LoopDoneParams,
	state: LoopState,
): ToolOutcome {
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

	// A stale claim while a check is already pending must not replace it.
	if (state.evaluating) {
		return {
			content: [
				{
					type: "text",
					text: "A completion claim is already being checked. Wait for its verdict.",
				},
			],
			details: undefined,
			newState: state,
		};
	}

	// A missing or blank reason means the call was not a valid claim (a
	// legacy "next" call, for example). It must not change any state.
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
		evaluating: true,
		claimReason: reason,
	};
	return {
		content: [
			{
				type: "text",
				text: "Claim recorded — the goal is confirmed in the next turn before the loop closes.",
			},
		],
		details: { ...newState } as LoopState,
		newState,
	};
}

/**
 * The check turn's verdict. "reached" closes the loop; "not_reached" (or no
 * verdict at all) leaves it open, so the work resumes.
 */
export function handleLoopApproveTool(
	params: LoopApproveParams,
	state: LoopState,
): ToolOutcome {
	if (!state.active) {
		return {
			content: [
				{ type: "text", text: "No active loop. Start one with /loop." },
			],
			details: undefined,
			newState: state,
		};
	}

	// Only meaningful while a claim is being checked.
	if (!state.evaluating) {
		return {
			content: [
				{
					type: "text",
					text: "loop_approve is only available while a completion claim is being checked.",
				},
			],
			details: undefined,
			newState: state,
		};
	}

	const verdict = params.verdict;
	const reason =
		typeof params.reason === "string" ? params.reason.trim() : "";

	if (verdict === "reached") {
		const newState = {
			...state,
			done: true,
			active: false,
			evaluating: false,
			reasonDone: reason || state.claimReason || "Goal met",
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

	// Not reached — or no verdict at all. The claim is ignored and the loop
	// resumes, whatever the model said about the goal being unreachable.
	const newState = {
		...state,
		evaluating: false,
	};
	return {
		content: [
			{
				type: "text",
				text: "Not confirmed. The loop stays open — keep working on the goal.",
			},
		],
		details: { ...newState } as LoopState,
		newState,
	};
}

/**
 * The model ends the current iteration and starts the next one. A count loop
 * closes when it reaches its cap; every other loop keeps going.
 */
export function handleLoopNextTool(
	params: LoopNextParams,
	state: LoopState,
): ToolOutcome {
	if (!state.active) {
		return {
			content: [
				{ type: "text", text: "No active loop. Start one with /loop." },
			],
			details: undefined,
			newState: state,
		};
	}

	if (state.forever) {
		return {
			content: [
				{
					type: "text",
					text: "loop_next is unavailable during a forever loop.",
				},
			],
			details: undefined,
			newState: state,
		};
	}

	// The advance tool belongs to count loops. In a goal loop the extension
	// owns iteration boundaries, and the model only claims completion.
	if (state.maxSteps === null) {
		return {
			content: [
				{
					type: "text",
					text: "loop_next is only available in a count loop. The loop advances itself here.",
				},
			],
			details: undefined,
			newState: state,
		};
	}

	// A stale advance while a claim is being checked must not replace it.
	if (state.evaluating) {
		return {
			content: [
				{
					type: "text",
					text: "A completion claim is being checked. Wait for its verdict.",
				},
			],
			details: undefined,
			newState: state,
		};
	}

	const newState = advanceState(state);
	const summary = (params.summary ?? "").trim();
	return {
		content: [
			{
				type: "text",
				text: newState.done
					? `✓ Loop complete — all ${state.maxSteps} passes done.`
					: `→ Continuing to iteration ${newState.currentStep + 1}.${summary ? ` Summary: ${summary}` : ""}`,
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
			"Claim that the goal is fully met. Call this only when it is.",
			"The claim is confirmed in a follow-up check before the loop closes.",
			"reason: why the goal is met.",
		].join(" "),
		parameters: Type.Object({
			reason: Type.String({
				description: "Why the goal is met (the claim to be checked)",
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

export function getLoopApproveToolDefinition() {
	return {
		name: LOOP_APPROVE_TOOL,
		label: "Loop Approve",
		description: [
			"Answer the loop's confirmation check: has the goal actually been reached?",
			'verdict "reached" closes the loop; verdict "not_reached" leaves it open so the work resumes.',
			"reason: your justification.",
		].join(" "),
		parameters: Type.Object({
			verdict: StringEnum(["reached", "not_reached"] as const),
			reason: Type.String({
				description: "Why the goal is (or is not) reached",
			}),
		}),
	};
}

export function getLoopNextToolDefinition() {
	return {
		name: LOOP_NEXT_TOOL,
		label: "Loop Next",
		description: [
			"End this iteration and start the next one.",
			"An iteration also ends when you end your turn, so this is only needed to move on without ending the turn.",
			"summary: what was accomplished in this iteration (optional).",
		].join(" "),
		parameters: Type.Object({
			summary: Type.Optional(
				Type.String({
					description: "What was accomplished in this iteration",
				}),
			),
		}),
	};
}

export function renderLoopNextCall(
	args: { summary?: string },
	theme: unknown,
) {
	const t = theme as {
		fg: (k: string, s: string) => string;
		bold: (s: string) => string;
	};
	const summary = (args.summary ?? "").trim();
	const shown = summary.length > 60 ? `${summary.slice(0, 57)}…` : summary;
	return new Text(
		t.fg("toolTitle", t.bold("loop_next ")) +
			t.fg("accent", shown || "(no summary)"),
		0,
		0,
	);
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
			t.fg("accent", shown || "(no reason)"),
		0,
		0,
	);
}

export function renderLoopApproveCall(
	args: { verdict?: string; reason?: string },
	theme: unknown,
) {
	const t = theme as {
		fg: (k: string, s: string) => string;
		bold: (s: string) => string;
	};
	const reached = args.verdict === "reached";
	return new Text(
		t.fg("toolTitle", t.bold("loop_approve ")) +
			t.fg(reached ? "success" : "warning", args.verdict ?? "(no verdict)"),
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
	const label = d.done
		? "✓ loop complete"
		: d.evaluating
			? "→ checking"
			: d.forever
				? `→ iter ${d.currentStep} · forever`
				: `→ iter ${d.currentStep}`;
	return new Text(t.fg(d.done ? "success" : "accent", label), 0, 0);
}

export function renderLoopApproveResult(
	result: { details?: LoopState },
	_opts: unknown,
	theme: unknown,
) {
	const d = result.details as LoopState | undefined;
	if (!d) return new Text("", 0, 0);
	const t = theme as { fg: (color: string, text: string) => string };
	const label = d.done ? "✓ loop complete" : "→ loop still open";
	return new Text(t.fg(d.done ? "success" : "warning", label), 0, 0);
}
