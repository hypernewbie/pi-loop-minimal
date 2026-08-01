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
// events are removed, the no-op `agent_end` handler is dropped, and the
// `/loop` command now takes `<N>` directly instead of `passes <N>`.

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import {
	buildPrompt,
	emptyState,
	getSystemPromptAddition,
	type LoopState,
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

	// ── Reconstruct state from session branch ────────────────────────────
	const reconstruct = (ctx: ExtensionContext) => {
		state = emptyState();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role === "toolResult" && msg.toolName === "loop_control") {
				const d = msg.details as LoopState | undefined;
				if (d) state = { ...d };
			}
		}
	};

	pi.on("session_start", async (_e, ctx) => reconstruct(ctx));
	pi.on("session_tree", async (_e, ctx) => reconstruct(ctx));

	// ── Tool: the LLM calls this to signal progress ─────────────────────
	pi.registerTool({
		...getLoopControlToolDefinition(),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const result = handleLoopControlTool(params, state, pi, ctx);
			state = result.newState;
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
			"Start a loop. Usage: /loop goal <desc> | /loop <N> <task>",
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
			];
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				ctx.ui.notify(
					"Usage:\n  /loop goal <description>\n  /loop <N> <task>",
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
			} else if (/^\d+$/.test(mode)) {
				result = parsePassesArgs(parts);
			} else {
				ctx.ui.notify(
					`Unknown mode "${mode}". Use: goal, or <N> for an exact-count loop`,
					"error",
				);
				return;
			}

			if (typeof result === "string") {
				ctx.ui.notify(result, "error");
				return;
			}

			state = result;
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
			updateWidget(state, ctx);
			ctx.abort(); // also abort the current LLM turn
			ctx.ui.notify("Loop aborted", "warning");
		},
	});
}
