// index.ts — Minimal agent loop extension
// Loop forms:
//   /loop goal <description>  — repeat until the LLM declares the goal met
//   /loop forever <task>      — continue until the user stops it
//
// The extension owns iteration boundaries: a turn that ends advances the
// loop. `loop_done` can only end a loop, with a reason. Forever loops do
// not expose the tool at all.
// Ctrl+Shift+X to abort at any time.
//
// Ported from pi-agent-loop@0.1.1 (MIT). Changes from the original:
// the `passes`/`pipeline` modes and the dead `session_switch`/`session_fork`
// events are removed, the no-op `agent_end` handler was replaced by the
// turn-end advance below, the `/loop` command now takes `<N>` directly
// instead of `passes <N>`, and the count form was later dropped.

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
	updateWidget,
} from "./state.js";
import {
	getLoopDoneToolDefinition,
	handleLoopDoneTool,
	LOOP_DONE_TOOL,
	renderLoopDoneCall,
	renderLoopDoneResult,
} from "./tool.js";

export default function (pi: ExtensionAPI) {
	let state = emptyState();

	const STATE_ENTRY = "loop-state";
	const LEGACY_START_ENTRY = "loop-started";
	const STOP_ENTRY = "loop-stopped";

	// Loop state lives in session entries, not in tool results: the model can
	// no longer advance a loop, so there is no tool result to reconstruct from.
	const persist = (s: LoopState) => pi.appendEntry(STATE_ENTRY, { ...s });

	// Derive each change from Pi's current list: never restore a stale snapshot
	// and accidentally overwrite tool choices made by the user or extensions.
	const setLoopDoneActive = (active: boolean) => {
		const tools = pi.getActiveTools();
		const hasTool = tools.includes(LOOP_DONE_TOOL);
		if (active === hasTool) return;
		pi.setActiveTools(
			active
				? [...new Set([...tools, LOOP_DONE_TOOL])]
				: tools.filter((name) => name !== LOOP_DONE_TOOL),
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
	// Older entries carry fields this version dropped (mode, maxSteps) and may
	// miss fields entirely, so every field is normalized here: restoring a
	// missing field as undefined turns arithmetic on it into NaN.
	const restoreState = (data: unknown): LoopState | null => {
		if (!data || typeof data !== "object") return null;
		const d = data as Record<string, unknown>;
		const step = d.currentStep;
		return {
			active: d.active === true,
			currentStep:
				typeof step === "number" && Number.isFinite(step) ? step : 0,
			goal: typeof d.goal === "string" ? d.goal : "",
			done: d.done === true,
			reasonDone: typeof d.reasonDone === "string" ? d.reasonDone : "",
			forever: d.forever === true,
		};
	};

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
				const restored = restoreState(entry.data);
				if (restored) state = restored;
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
			// Legacy sessions stored the state in loop_control tool results.
			if (
				msg.role === "toolResult" &&
				(msg.toolName === "loop_control" || msg.toolName === LOOP_DONE_TOOL)
			) {
				const restored = restoreState(msg.details);
				if (restored) state = restored;
			}
		}
		if (state.active && state.forever) setLoopDoneActive(false);
		updateWidget(state, ctx);
	};

	pi.on("session_start", async (_e, ctx) => reconstruct(ctx));
	pi.on("session_tree", async (_e, ctx) => reconstruct(ctx));

	// Tool removal applies to future model requests. Block a call that was
	// already issued by a stale/queued request before the removal took effect.
	pi.on("tool_call", (event) => {
		if (state.active && state.forever && event.toolName === LOOP_DONE_TOOL) {
			return {
				block: true,
				reason: "loop_done is unavailable during a forever loop.",
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
			setLoopDoneActive(false);
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
		state = { ...state, currentStep: state.currentStep + 1 };
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
		...getLoopDoneToolDefinition(),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const result = handleLoopDoneTool(params, state);
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
		renderCall: renderLoopDoneCall,
		renderResult: renderLoopDoneResult,
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
			"Start a loop. Usage: /loop goal <desc> | /loop forever <task>",
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
					"Usage:\n  /loop goal <description>\n  /loop forever <task>",
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
			} else if (/^\d+$/.test(mode) || mode === "passes") {
				ctx.ui.notify(
					"Exact-count loops were removed. Use /loop goal <description> (ends when the goal is met) or /loop forever <task> (ends when you stop it).",
					"error",
				);
				return;
			} else {
				ctx.ui.notify(
					`Unknown mode "${mode}". Use: goal or forever`,
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
			// must not receive loop_done. Normal loop forms opt it back in.
			setLoopDoneActive(!state.forever);
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
