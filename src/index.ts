// index.ts — Minimal agent loop extension
// Loop forms:
//   /loop goal <description>  — repeat until the LLM declares the goal met
//   /loop <N> <task>          — repeat exactly N times
//   /loop forever <task>      — continue until the user stops it
//
// The extension owns iteration boundaries: a turn that ends advances the
// loop. `loop_control` can only end a loop, with a reason. Forever loops do
// not expose the tool at all.
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
import {
	buildNudgePrompt,
	buildPrompt,
	emptyState,
	getSystemPromptAddition,
	type LoopState,
	parseForeverArgs,
	parseGoalArgs,
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

	const LOOP_CONTROL_TOOL = "loop_control";
	const STATE_ENTRY = "loop-state";
	const LEGACY_START_ENTRY = "loop-started";
	const STOP_ENTRY = "loop-stopped";

	// Loop state lives in session entries, not in tool results: the model can
	// no longer advance a loop, so there is no tool result to reconstruct from.
	const persist = (s: LoopState) => pi.appendEntry(STATE_ENTRY, { ...s });

	// Derive each change from Pi's current list: never restore a stale snapshot
	// and accidentally overwrite tool choices made by the user or extensions.
	const setLoopControlActive = (active: boolean) => {
		const tools = pi.getActiveTools();
		const hasControl = tools.includes(LOOP_CONTROL_TOOL);
		if (active === hasControl) return;
		pi.setActiveTools(
			active
				? [...new Set([...tools, LOOP_CONTROL_TOOL])]
				: tools.filter((name) => name !== LOOP_CONTROL_TOOL),
		);
	};

	const stopLoop = (reason: string, ctx: ExtensionContext) => {
		state.active = false;
		state.done = true;
		state.reasonDone = reason;
		pi.appendEntry(STOP_ENTRY, { reason });
		updateWidget(state, ctx);
	};

	// ── Reconstruct state from session branch ────────────────────────────
	const reconstruct = (ctx: ExtensionContext) => {
		state = emptyState();
		for (const entry of ctx.sessionManager.getBranch()) {
			// Entries are replayed in order: a later state wins over an earlier
			// one, and a later stop wins over the state that preceded it.
			if (
				entry.type === "custom" &&
				(entry.customType === STATE_ENTRY ||
					entry.customType === LEGACY_START_ENTRY)
			) {
				const d = entry.data as Partial<LoopState> | undefined;
				if (d) state = { ...emptyState(), ...d };
				continue;
			}
			if (entry.type === "custom" && entry.customType === STOP_ENTRY) {
				const reason = (entry.data as { reason?: string } | undefined)?.reason;
				state = {
					...state,
					active: false,
					done: true,
					reasonDone: reason ?? "Stopped by user",
				};
				continue;
			}
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role === "toolResult" && msg.toolName === "loop_control") {
				const d = msg.details as Partial<LoopState> | undefined;
				// Spread over defaults: details written by an older version can be
				// missing fields, and restoring them as undefined turns arithmetic
				// on them into NaN (the same trap as Infinity -> null for maxSteps).
				if (d) state = { ...emptyState(), ...d };
			}
		}
		if (state.active && state.forever) setLoopControlActive(false);
		updateWidget(state, ctx);
	};

	pi.on("session_start", async (_e, ctx) => reconstruct(ctx));
	pi.on("session_tree", async (_e, ctx) => reconstruct(ctx));

	// Tool removal applies to future model requests. Block a call that was
	// already issued by a stale/queued request before the removal took effect.
	pi.on("tool_call", (event) => {
		if (
			state.active &&
			state.forever &&
			event.toolName === LOOP_CONTROL_TOOL
		) {
			return {
				block: true,
				reason: "loop_control is unavailable during a forever loop.",
			};
		}
	});

	// ── Turn end: the extension advances the loop ───────────────────────
	pi.on("agent_end", async (event, ctx) => {
		if (!state.active) return;
		// Never advance on a run the user aborted or one that errored: Pi ends
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

		if (state.forever) {
			setLoopControlActive(false);
			pi.sendMessage(
				{
					customType: "loop-nudge",
					content: buildNudgePrompt(state),
					display: false,
				},
				{ triggerTurn: true, deliverAs: "steer" },
			);
			return;
		}

		// The turn ended, so that iteration is over. The extension owns the
		// boundary — the model cannot advance the loop itself.
		const completed = state.currentStep + 1;
		if (state.mode === "passes" && completed >= (state.maxSteps ?? 0)) {
			state = {
				...state,
				currentStep: completed,
				done: true,
				active: false,
				reasonDone: "Completed all passes",
			};
			persist(state);
			updateWidget(state, ctx);
			pi.sendMessage({
				customType: "loop-complete",
				content: `✓ Loop complete — all ${state.maxSteps} passes done.`,
				display: true,
			});
			return;
		}

		state = { ...state, currentStep: completed };
		persist(state);
		updateWidget(state, ctx);
		pi.sendMessage(
			{
				customType: "loop-iteration",
				content: buildPrompt(state),
				display: false,
			},
			{ triggerTurn: true, deliverAs: "steer" },
		);
	});

	// ── Tool: the LLM calls this to end the loop, with a reason ─────────
	pi.registerTool({
		...getLoopControlToolDefinition(),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const result = handleLoopControlTool(params, state);
			state = result.newState;
			// Only a real state change is persisted, so a rejected call cannot
			// resurrect a stopped loop on the next reconstruction.
			if (result.details) persist(state);
			updateWidget(state, ctx);
			return {
				content: result.content,
				details: result.details,
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
			"Start a loop. Usage: /loop goal <desc> | /loop forever <task> | /loop <N> <task>",
		getArgumentCompletions: (prefix: string) => {
			// Filter by the current argument: once the user types the goal
			// text, the completion must disappear so accepting it cannot
			// replace what they typed (AutocompleteItem.value replaces the
			// whole current argument).
			const items = [
				{
					value: "goal ",
					label: "goal <description>",
					description: "Loop until goal is met",
				},
				{
					value: "forever ",
					label: "forever <task>",
					description: "Loop until you stop it",
				},
			];
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				ctx.ui.notify(
					"Usage:\n  /loop goal <description>\n  /loop forever <task>\n  /loop <N> <task>",
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
			} else if (mode === "forever") {
				result = parseForeverArgs(parts);
			} else if (/^\d+$/.test(mode)) {
				result = parsePassesArgs(parts);
			} else {
				ctx.ui.notify(
					`Unknown mode "${mode}". Use: goal, forever, or <N> for an exact-count loop`,
					"error",
				);
				return;
			}

			if (typeof result === "string") {
				ctx.ui.notify(result, "error");
				return;
			}

			state = result;
			// Forever loops are driven solely by agent_end, so their model request
			// must not receive loop_control. Normal loop forms opt it back in.
			setLoopControlActive(!state.forever);
			persist(state);
			updateWidget(state, ctx);
			// Kick off the first work session/iteration.
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
			const wasForever = state.forever;
			stopLoop("Stopped by user", ctx);
			ctx.ui.notify(
				wasForever
					? "Forever loop stopped"
					: `Loop stopped after ${state.currentStep + 1} iteration(s)`,
				"warning",
			);
		},
	});

	// ── Ctrl+Shift+X — emergency stop ───────────────────────────────────
	pi.registerShortcut(Key.ctrlShift("x"), {
		description: "Stop the active loop",
		handler: async (ctx) => {
			if (!state.active) return;
			stopLoop("Stopped by shortcut", ctx);
			ctx.abort(); // also abort the current LLM turn
			ctx.ui.notify("Loop aborted", "warning");
		},
	});
}
