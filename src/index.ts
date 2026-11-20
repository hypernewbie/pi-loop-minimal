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
	advanceState,
	buildEvaluationPrompt,
	buildNudgePrompt,
	buildPrompt,
	buildResumePrompt,
	emptyState,
	getSystemPromptAddition,
	type LoopState,
	parseForeverArgs,
	parseGoalArgs,
	parsePassesArgs,
	updateWidget,
} from "./state.js";
import {
	getLoopApproveToolDefinition,
	getLoopDoneToolDefinition,
	getLoopNextToolDefinition,
	handleLoopApproveTool,
	handleLoopDoneTool,
	handleLoopNextTool,
	LOOP_APPROVE_TOOL,
	LOOP_DONE_TOOL,
	LOOP_NEXT_TOOL,
	renderLoopApproveCall,
	renderLoopApproveResult,
	renderLoopDoneCall,
	renderLoopDoneResult,
	renderLoopNextCall,
} from "./tool.js";

export default function (pi: ExtensionAPI) {
	let state = emptyState();
	// Runtime-only: true when the model advanced the loop itself during the
	// current run. A turn end must not count that iteration a second time.
	let advancedThisRun = false;

	const STATE_ENTRY = "loop-state";
	const LEGACY_START_ENTRY = "loop-started";
	const STOP_ENTRY = "loop-stopped";

	// Loop state lives in session entries, not in tool results: the model can
	// no longer advance a loop, so there is no tool result to reconstruct from.
	const persist = (s: LoopState) => pi.appendEntry(STATE_ENTRY, { ...s });

	// The loop tools that belong to the current phase. Exactly the working
	// tools are exposed while the model works, only the approval tool while a
	// claim is checked, and none at all when there is no loop to drive.
	const applyLoopTools = () => {
		const tools = pi.getActiveTools();
		const withoutLoopTools = tools.filter(
			(name) =>
				name !== LOOP_DONE_TOOL &&
				name !== LOOP_APPROVE_TOOL &&
				name !== LOOP_NEXT_TOOL,
		);
		const wanted = !state.active
			? []
			: state.forever
				? []
				: state.evaluating
					? [LOOP_APPROVE_TOOL]
					: [LOOP_NEXT_TOOL, LOOP_DONE_TOOL];
		const next = [...withoutLoopTools, ...wanted];
		if (next.length === tools.length && next.every((n, i) => n === tools[i])) {
			return;
		}
		pi.setActiveTools(next);
	};

	const stopLoop = (reason: string, ctx: ExtensionContext) => {
		state.active = false;
		state.done = true;
		state.reasonDone = reason;
		state.evaluating = false;
		pi.appendEntry(STOP_ENTRY, { reason });
		applyLoopTools();
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
			maxSteps:
				typeof d.maxSteps === "number" && Number.isFinite(d.maxSteps)
					? d.maxSteps
					: null,
			// A pending check does not survive a restart: the claim it belonged
			// to is dropped, and the loop goes back to working.
			evaluating: false,
			claimReason: "",
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
		// Exactly one loop tool is exposed while a loop runs, and none when
		// there is no loop: registered tools are active by default, so both
		// loop tools have to be taken out of the list here.
		applyLoopTools();
		updateWidget(state, ctx);
	};

	pi.on("session_start", async (_e, ctx) => reconstruct(ctx));
	pi.on("session_tree", async (_e, ctx) => reconstruct(ctx));

	// Tool removal applies to future model requests. Block a call that was
	// already issued by a stale/queued request before the removal took effect.
	pi.on("tool_call", (event) => {
		// Only the tools of the current phase may run. The active-tool list
		// already hides the others; this covers a call that was issued
		// before the swap took effect.
		if (event.toolName === LOOP_DONE_TOOL || event.toolName === LOOP_NEXT_TOOL) {
			if (state.forever) {
				return {
					block: true,
					reason: `${event.toolName} is unavailable during a forever loop.`,
				};
			}
			if (state.evaluating) {
				return {
					block: true,
					reason: `${event.toolName} is unavailable while a completion claim is being checked.`,
				};
			}
		}
		if (event.toolName === LOOP_APPROVE_TOOL && !state.evaluating) {
			return {
				block: true,
				reason: "loop_approve is only available while a completion claim is being checked.",
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
			applyLoopTools();
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

		// A check turn that ended without a verdict: the claim is ignored and
		// the work resumes — whatever the model said about the goal.
		if (state.evaluating) {
			resumeLoop("the claim was not confirmed", ctx);
			return;
		}

		// The turn ended. If the model already advanced the loop itself during
		// this run, that iteration is counted — do not count it twice, just
		// keep the loop working on the iteration it moved to.
		if (advancedThisRun) {
			advancedThisRun = false;
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

		// The turn ended without an explicit advance, so the iteration is over
		// anyway: the extension owns the boundary.
		state = advanceState(state);
		persist(state);
		updateWidget(state, ctx);
		if (state.done) {
			applyLoopTools();
			pi.sendMessage({
				customType: "loop-complete",
				content: `✓ Loop complete — all ${state.maxSteps} passes done.`,
				display: true,
			});
			return;
		}
		dispatchIteration(ctx);
	});

	// ── Dispatch the prompt for the iteration that is now running ───────
	const dispatchIteration = (ctx: ExtensionContext) => {
		pi.sendMessage(
			{
				customType: "loop-iteration",
				content: buildPrompt(state),
				display: false,
			},
			{ triggerTurn: true, deliverAs: "steer" },
		);
	};

	// ── Resume: the claim was not confirmed, so the loop keeps working ──
	const resumeLoop = (why: string, ctx: ExtensionContext) => {
		state = { ...state, evaluating: false };
		persist(state);
		applyLoopTools();
		updateWidget(state, ctx);
		pi.sendMessage(
			{
				customType: "loop-resume",
				content: buildResumePrompt(state, why),
				display: false,
			},
			{ triggerTurn: true, deliverAs: "steer" },
		);
	};

	// ── Tool: the LLM ends this iteration and starts the next one ───────
	pi.registerTool({
		...getLoopNextToolDefinition(),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const result = handleLoopNextTool(params, state);
			state = result.newState;
			if (result.details) {
				persist(state);
				advancedThisRun = true;
				updateWidget(state, ctx);
				applyLoopTools();
				if (state.done) {
					pi.sendMessage({
						customType: "loop-complete",
						content: result.content[0].text,
						display: true,
					});
				} else {
					dispatchIteration(ctx);
				}
			}
			return {
				content: result.content,
				details: result.details,
			};
		},
		renderCall: renderLoopNextCall,
		renderResult: renderLoopDoneResult,
	});

	// ── Tool: the LLM claims the goal is met ───────────────────────────
	pi.registerTool({
		...getLoopDoneToolDefinition(),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const result = handleLoopDoneTool(params, state);
			state = result.newState;
			// Only a real state change is persisted, so a rejected call cannot
			// resurrect a stopped loop on the next reconstruction.
			if (result.details) persist(state);
			applyLoopTools();
			updateWidget(state, ctx);
			// A claim does not close the loop: the next turn checks it.
			if (state.evaluating) {
				pi.sendMessage(
					{
						customType: "loop-evaluate",
						content: buildEvaluationPrompt(state),
						display: false,
					},
					{ triggerTurn: true, deliverAs: "steer" },
				);
			}
			return {
				content: result.content,
				details: result.details,
			};
		},
		renderCall: renderLoopDoneCall,
		renderResult: renderLoopDoneResult,
	});

	// ── Tool: the LLM confirms (or rejects) the claim ───────────────────
	pi.registerTool({
		...getLoopApproveToolDefinition(),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const wasEvaluating = state.evaluating;
			const result = handleLoopApproveTool(params, state);
			state = result.newState;
			if (result.details) persist(state);
			applyLoopTools();
			updateWidget(state, ctx);
			// Rejected: the loop stays open and the work resumes.
			if (wasEvaluating && !state.evaluating && state.active) {
				resumeLoop(
					typeof params.reason === "string" && params.reason.trim()
						? params.reason.trim()
						: "the goal was not confirmed",
					ctx,
				);
			}
			return {
				content: result.content,
				details: result.details,
			};
		},
		renderCall: renderLoopApproveCall,
		renderResult: renderLoopApproveResult,
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
			advancedThisRun = false;
			// Exactly the working tools are exposed, and only while a loop runs.
			applyLoopTools();
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
