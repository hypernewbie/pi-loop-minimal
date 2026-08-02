// index.ts — Minimal agent loop extension
// Two loop forms:
//   /loop goal <description>  — repeat until the LLM declares the goal met
//   /loop <N> <task>          — repeat exactly N times
//
// The LLM gets a `loop_control` tool to signal progress/completion.
// Ctrl+Shift+X to abort at any time.
//
// Ported from pi-agent-loop@0.1.1 (MIT). Changes from the original:
// the `passes`/`pipeline` modes and the dead `session_switch`/`session_fork`
// events are removed, the no-op `agent_end` handler was replaced by the
// force-close nudge below, and the `/loop` command now takes `<N>`
// directly instead of `passes <N>`.

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { type JudgeResult, runJudge } from "./judge.js";
import {
	buildNudgePrompt,
	buildPrompt,
	emptyState,
	getSystemPromptAddition,
	type LoopState,
	parseGoalArgs,
	parseJudgedArgs,
	parsePassesArgs,
	updateWidget,
} from "./state.js";
import {
	getLoopControlToolDefinition,
	handleLoopControlTool,
	renderLoopControlCall,
	renderLoopControlResult,
} from "./tool.js";

export default function (pi: ExtensionAPI) {
	let state = emptyState();
	// Runtime-only: true while the current iteration expects loop_control.
	// Set when an iteration is dispatched, cleared when loop_control runs;
	// used by agent_end to detect a turn that ended without closing the loop.
	let awaitingControl = false;

	// ── Reconstruct state from session branch ────────────────────────────
	const reconstruct = (ctx: ExtensionContext) => {
		state = emptyState();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role === "toolResult" && msg.toolName === "loop_control") {
				const d = msg.details as Partial<LoopState> | undefined;
				// Spread over defaults: details recorded before a field existed
				// would otherwise restore as undefined (denials + 1 => NaN).
				if (d) state = { ...emptyState(), ...d };
			}
		}
		// A restored active loop was mid-iteration when the session ended:
		// its iteration still expects loop_control.
		awaitingControl = state.active;
	};

	pi.on("session_start", async (_e, ctx) => reconstruct(ctx));
	pi.on("session_tree", async (_e, ctx) => reconstruct(ctx));

	// ── Force-close: nudge a run that ended with the loop still open ────
	pi.on("agent_end", async (event, _ctx) => {
		if (!state.active || !awaitingControl) return;
		// Never restart a run the user aborted or one that errored: Pi ends
		// those with a final message carrying stopReason "aborted"/"error".
		const last = event.messages.at(-1);
		// Pi's stream contract ends aborted/errored runs with a final
		// AssistantMessage carrying stopReason "aborted"/"error"; the
		// AgentMessage type does not expose it, so narrow via a cast.
		const stopReason =
			last?.role === "assistant"
				? (last as { stopReason?: string }).stopReason
				: undefined;
		if (stopReason === "aborted" || stopReason === "error") return;
		pi.sendMessage(
			{
				customType: "loop-nudge",
				content: buildNudgePrompt(state),
				display: false,
			},
			{ triggerTurn: true, deliverAs: "steer" },
		);
	});

	// ── Tool: the LLM calls this to signal progress ─────────────────────
	pi.registerTool({
		...getLoopControlToolDefinition(),
		async execute(_id, params, signal, onUpdate, ctx) {
			// A judged loop must clear an independent review before it may close.
			let judge: JudgeResult | undefined;
			if (state.active && state.judgeModel && params.status === "done") {
				onUpdate?.({
					content: [
						{ type: "text", text: `judging with ${state.judgeModel}…` },
					],
					details: undefined,
				});
				judge = await runJudge(state, params, ctx, signal);
			}
			// state is re-read after the await on purpose: /loop-stop or
			// Ctrl+Shift+X during the review deactivates the loop, and the
			// handler's inactive branch then applies.
			const result = handleLoopControlTool(params, state, pi, ctx, judge);
			state = result.newState;
			// Re-arm for the next iteration; an inactive loop has nothing to
			// await, so a later agent_end stays silent.
			awaitingControl = result.newState.active;
			updateWidget(state, ctx);
			return {
				content: result.content,
				details: result.details,
				...(judge?.kind === "verdict" && judge.usage
					? { usage: judge.usage }
					: {}),
			};
		},
		renderCall: renderLoopControlCall,
		renderResult: renderLoopControlResult,
	});

	// ── Inject loop context into the system prompt ───────────────────────
	pi.on("before_agent_start", async (event, _ctx) => {
		if (!state.active) return;
		return {
			systemPrompt: event.systemPrompt + getSystemPromptAddition(state),
		};
	});

	// ── /loop command — start a loop ─────────────────────────────────────
	pi.registerCommand("loop", {
		description:
			"Start a loop. Usage: /loop goal <desc> | /loop goal_judged <provider/model> <desc> | /loop <N> <task>",
		getArgumentCompletions: (prefix: string) => {
			// Filter by the current argument: once the user types the goal
			// text, the completion must disappear so accepting it cannot
			// replace what they typed (AutocompleteItem.value replaces the
			// whole current argument).
			// No completions are offered for the judge model slug: accepting an
			// argument completion replaces the whole argument and does not submit,
			// which is the /model footgun. Mode keywords only.
			const items = [
				{
					value: "goal ",
					label: "goal <description>",
					description: "Loop until goal is met",
				},
				{
					value: "goal_judged ",
					label: "goal_judged <provider/model> <description>",
					description: "Loop until an independent judge agrees",
				},
			];
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				ctx.ui.notify(
					"Usage:\n  /loop goal <description>\n  /loop goal_judged <provider/model> <description>\n  /loop <N> <task>",
					"info",
				);
				return;
			}

			await ctx.waitForIdle();

			const parts = args.trim().split(/\s+/);
			const mode = parts[0];

			let result: LoopState | string;

			if (mode === "goal") {
				result = parseGoalArgs(parts);
			} else if (mode === "goal_judged") {
				result = parseJudgedArgs(parts, ctx.modelRegistry);
			} else if (/^\d+$/.test(mode)) {
				result = parsePassesArgs(parts);
			} else {
				ctx.ui.notify(
					`Unknown mode "${mode}". Use: goal, goal_judged, or <N> for an exact-count loop`,
					"error",
				);
				return;
			}

			if (typeof result === "string") {
				ctx.ui.notify(result, "error");
				return;
			}

			state = result;
			awaitingControl = true;
			updateWidget(state, ctx);
			// Kick off the first iteration
			pi.sendUserMessage(buildPrompt(state));
		},
	});

	// ── /loop-stop command ───────────────────────────────────────────────
	pi.registerCommand("loop-stop", {
		description: "Stop the active loop",
		handler: async (_args, ctx) => {
			if (!state.active) {
				ctx.ui.notify("No active loop", "info");
				return;
			}
			state.active = false;
			state.done = true;
			state.reasonDone = "Stopped by user";
			awaitingControl = false;
			updateWidget(state, ctx);
			ctx.ui.notify(
				`Loop stopped after ${state.currentStep + 1} iteration(s)`,
				"warning",
			);
		},
	});

	// ── Ctrl+Shift+X — emergency stop ───────────────────────────────────
	pi.registerShortcut(Key.ctrlShift("x"), {
		description: "Stop the active loop",
		handler: async (ctx) => {
			if (!state.active) return;
			state.active = false;
			state.done = true;
			state.reasonDone = "Stopped by shortcut";
			awaitingControl = false;
			updateWidget(state, ctx);
			ctx.abort(); // also abort the current LLM turn
			ctx.ui.notify("Loop aborted", "warning");
		},
	});
}
