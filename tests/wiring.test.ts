import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";
import type { LoopState } from "../src/state.ts";

type ToolParams = { status: "next" | "done"; summary: string; reason?: string };
type ToolResult = { content: { type: "text"; text: string }[]; details?: LoopState };
type CommandCtx = ExtensionContext & { waitForIdle(): Promise<void> };
type CommandDef = {
	handler: (args: string, ctx: CommandCtx) => Promise<void>;
	getArgumentCompletions?: (prefix: string) => unknown[] | null;
};
type ShortcutDef = { handler: (ctx: ExtensionContext) => Promise<void> };
type ToolDef = {
	name: string;
	execute: (
		id: string,
		params: ToolParams,
		signal: unknown,
		onUpdate: unknown,
		ctx: CommandCtx,
	) => Promise<ToolResult>;
};

type BranchEntry = {
	type: string;
	message?: { role: string; toolName?: string; details?: unknown };
};

function createHarness() {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const toolDefs: ToolDef[] = [];
	const commands = new Map<string, CommandDef>();
	const shortcuts = new Map<string, ShortcutDef>();
	const sentMessages: { msg: { customType?: string; content?: string; display?: boolean }; opts: unknown }[] = [];
	const sentUserMessages: string[] = [];
	const branch: BranchEntry[] = [];

	const ui = {
		notify: vi.fn(),
		setStatus: vi.fn(),
		setWidget: vi.fn(),
	};

	const pi = {
		on: (ev: string, fn: (event: unknown, ctx: unknown) => unknown) =>
			handlers.set(ev, fn),
		registerTool: (def: unknown) => toolDefs.push(def as ToolDef),
		registerCommand: (name: string, def: unknown) =>
			commands.set(name, def as CommandDef),
		registerShortcut: (key: string, def: unknown) =>
			shortcuts.set(key, def as ShortcutDef),
		sendMessage: (msg: unknown, opts: unknown) =>
			sentMessages.push({ msg: msg as never, opts }),
		sendUserMessage: (content: string) => sentUserMessages.push(content),
		appendEntry: (customType: string, data?: unknown) =>
			branch.push({ type: "custom", customType, data } as never),
	} as unknown as ExtensionAPI;

	const ctx = {
		ui,
		waitForIdle: vi.fn(async () => {}),
		abort: vi.fn(),
		sessionManager: { getBranch: () => branch },
	} as unknown as CommandCtx;

	extension(pi);

	return {
		handlers,
		toolDefs,
		commands,
		shortcuts,
		sentMessages,
		sentUserMessages,
		ctx,
		ui,
		branch,
	};
}

type Harness = ReturnType<typeof createHarness>;

const loopCmd = (h: Harness) => h.commands.get("loop")!;
const stopCmd = (h: Harness) => h.commands.get("loop-stop")!;
const shortcut = (h: Harness) => h.shortcuts.get("ctrl+shift+x")!;

async function execTool(h: Harness, params: ToolParams): Promise<ToolResult> {
	return h.toolDefs[0].execute("call-1", params, undefined, undefined, h.ctx);
}

describe("extension surface", () => {
	it("registers the loop and loop-stop commands, the tool, and the shortcut", () => {
		const h = createHarness();
		expect(h.commands.has("loop")).toBe(true);
		expect(h.commands.has("loop-stop")).toBe(true);
		expect(h.shortcuts.has("ctrl+shift+x")).toBe(true);
		expect(h.toolDefs[0].name).toBe("loop_control");
	});

	it("listens only to current-Pi events", () => {
		const h = createHarness();
		for (const ev of [
			"session_start",
			"session_tree",
			"before_agent_start",
			"agent_end",
		]) {
			expect(h.handlers.has(ev), ev).toBe(true);
		}
		expect(h.handlers.has("session_switch")).toBe(false);
		expect(h.handlers.has("session_fork")).toBe(false);
	});
});

describe("/loop completions", () => {
	it("offers the goal completion only while the prefix matches", () => {
		const h = createHarness();
		const completions = loopCmd(h).getArgumentCompletions!;
		expect(completions("goal")).toHaveLength(1);
		expect(completions("go")).toHaveLength(1);
		expect(completions("")).toHaveLength(2);
		expect(completions("for")).toHaveLength(1);
		expect((completions("for") as { value: string }[])[0].value).toBe("forever ");
	});

	it("never offers the completion while a goal is being typed", () => {
		const h = createHarness();
		const completions = loopCmd(h).getArgumentCompletions!;
		// typing "hello" as the goal must not show a completion that would
		// replace it on accept
		expect(completions("hello")).toBeNull();
		expect(completions("my goal text")).toBeNull();
	});
});

describe("/loop command", () => {
	it("shows usage when invoked without arguments", async () => {
		const h = createHarness();
		await loopCmd(h).handler("", h.ctx);
		expect(h.ui.notify).toHaveBeenCalledWith(
			"Usage:\n  /loop goal <description>\n  /loop forever <task>\n  /loop <N> <task>",
			"info",
		);
		expect(h.sentUserMessages).toHaveLength(0);
	});

	it("starts a goal loop and kicks off the first iteration", async () => {
		const h = createHarness();
		await loopCmd(h).handler("goal make all tests green", h.ctx);
		expect(h.sentUserMessages).toHaveLength(1);
		expect(h.sentUserMessages[0]).toContain("## Loop — Iteration 1");
		expect(h.sentUserMessages[0]).toContain("Goal: make all tests green");
		expect(h.ui.setWidget).toHaveBeenCalledWith("loop", [
			"iter 1 · make all tests green",
			"Ctrl+Shift+X to stop",
		]);
	});

	it("starts an exact-count loop with /loop <N> <task>", async () => {
		const h = createHarness();
		await loopCmd(h).handler("5 refine the renderer", h.ctx);
		expect(h.sentUserMessages).toHaveLength(1);
		expect(h.sentUserMessages[0]).toContain("## Loop — Pass 1 of 5");
		expect(h.sentUserMessages[0]).toContain("Task: refine the renderer");
	});

	it("rejects the legacy passes word", async () => {
		const h = createHarness();
		await loopCmd(h).handler("passes 3 refine", h.ctx);
		expect(h.ui.notify).toHaveBeenCalledWith(
			'Unknown mode "passes". Use: goal, forever, or <N> for an exact-count loop',
			"error",
		);
		expect(h.sentUserMessages).toHaveLength(0);
	});

	it("rejects the pipeline mode", async () => {
		const h = createHarness();
		await loopCmd(h).handler("pipeline a|b do stuff", h.ctx);
		expect(h.ui.notify).toHaveBeenCalledWith(
			'Unknown mode "pipeline". Use: goal, forever, or <N> for an exact-count loop',
			"error",
		);
	});

	it("rejects bad counts with the parser message", async () => {
		const h = createHarness();
		await loopCmd(h).handler("0 task", h.ctx);
		expect(h.ui.notify).toHaveBeenCalledWith(
			"Provide a valid number of passes",
			"error",
		);
	});

	it("waits for idle before starting", async () => {
		const h = createHarness();
		await loopCmd(h).handler("goal x", h.ctx);
		expect(h.ctx.waitForIdle).toHaveBeenCalled();
	});
});

describe("loop_control through the registered tool", () => {
	it("steers the next count pass through sendMessage", async () => {
		const h = createHarness();
		await loopCmd(h).handler("2 fix it", h.ctx);
		await execTool(h, { status: "next", summary: "half done" });
		expect(h.sentMessages).toHaveLength(1);
		expect(h.sentMessages[0].msg).toMatchObject({
			customType: "loop-iteration",
			display: false,
		});
		expect(h.sentMessages[0].msg.content).toContain(
			"## Loop — Pass 2 of 2",
		);
		expect(h.sentMessages[0].opts).toEqual({
			triggerTurn: true,
			deliverAs: "steer",
		});
		expect(h.ui.setWidget).toHaveBeenLastCalledWith("loop", [
			"pass 2/2 · fix it",
			"Ctrl+Shift+X to stop",
		]);
	});

	it("completes a count loop on the final next without steering", async () => {
		const h = createHarness();
		await loopCmd(h).handler("1 only once", h.ctx);
		await execTool(h, { status: "next", summary: "done it" });
		expect(h.sentMessages).toHaveLength(0);
		expect(h.ui.setWidget).toHaveBeenLastCalledWith("loop", undefined);
	});

	it("completes a goal loop with done and reports iterations", async () => {
		const h = createHarness();
		await loopCmd(h).handler("goal win", h.ctx);
		const r = await execTool(h, {
			status: "done",
			summary: "won",
			reason: "all tests pass",
		});
		expect(r.content[0].text).toContain("Loop complete after 1 iteration(s)");
		expect(r.content[0].text).toContain("all tests pass");
		expect(h.sentMessages).toHaveLength(0);
	});

	it("is a no-op when no loop is active", async () => {
		const h = createHarness();
		const r = await execTool(h, { status: "next", summary: "x" });
		expect(r.content[0].text).toBe(
			"No active loop. Start one with /loop.",
		);
	});
});

describe("stop controls", () => {
	it("/loop-stop stops an active loop and clears the widget", async () => {
		const h = createHarness();
		await loopCmd(h).handler("goal stopme", h.ctx);
		await stopCmd(h).handler("", h.ctx);
		expect(h.ui.notify).toHaveBeenCalledWith(
			"Loop stopped after 1 iteration(s)",
			"warning",
		);
		expect(h.ui.setWidget).toHaveBeenLastCalledWith("loop", undefined);
		const r = await execTool(h, { status: "next", summary: "x" });
		expect(r.content[0].text).toBe(
			"No active loop. Start one with /loop.",
		);
	});

	it("/loop-stop on an inactive loop informs the user", async () => {
		const h = createHarness();
		await stopCmd(h).handler("", h.ctx);
		expect(h.ui.notify).toHaveBeenCalledWith("No active loop", "info");
	});

	it("Ctrl+Shift+X stops, aborts the turn, and notifies", async () => {
		const h = createHarness();
		await loopCmd(h).handler("goal emergency", h.ctx);
		await shortcut(h).handler(h.ctx);
		expect(h.ctx.abort).toHaveBeenCalled();
		expect(h.ui.notify).toHaveBeenCalledWith("Loop aborted", "warning");
		expect(h.ui.setWidget).toHaveBeenLastCalledWith("loop", undefined);
	});

	it("Ctrl+Shift+X is a no-op without an active loop", async () => {
		const h = createHarness();
		await shortcut(h).handler(h.ctx);
		expect(h.ctx.abort).not.toHaveBeenCalled();
	});
});

describe("reconstruction defaults", () => {
	it("fills fields missing from older details instead of restoring undefined", async () => {
		const h = createHarness();
		// details written before a field existed
		h.branch.push({
			type: "message",
			message: {
				role: "toolResult",
				toolName: "loop_control",
				details: { active: true, mode: "goal", currentStep: 2, goal: "legacy" },
			},
		});
		await h.handlers.get("session_start")!({}, h.ctx);
		const res = (await h.toolDefs[0].execute(
			"1",
			{ status: "next", summary: "s" },
			undefined,
			vi.fn(),
			h.ctx,
		)) as { details: { maxSteps: number | null; currentStep: number; done: boolean } };
		expect(res.details.currentStep).toBe(3);
		expect(res.details.maxSteps).toBe(0);
		expect(res.details.done).toBe(false);
	});

	it("still nudges a restored active loop", async () => {
		const h = createHarness();
		h.branch.push({
			type: "message",
			message: {
				role: "toolResult",
				toolName: "loop_control",
				details: { active: true, mode: "goal", currentStep: 2, maxSteps: null, goal: "restored", done: false, reasonDone: "" },
			},
		});
		await h.handlers.get("session_start")!({}, h.ctx);
		await h.handlers.get("agent_end")!(
			{ messages: [{ role: "assistant", stopReason: "stop" }] },
			h.ctx,
		);
		expect(h.sentMessages).toHaveLength(1);
		expect(h.sentMessages[0].msg.content).toContain("iteration 3");
	});
});

describe("/loop forever", () => {
	it("starts an endless loop and kicks off iteration 1", async () => {
		const h = createHarness();
		await loopCmd(h).handler("forever keep polishing the docs", h.ctx);
		expect(h.ui.notify).not.toHaveBeenCalled();
		expect(h.sentUserMessages[0]).toContain("## Loop — Iteration 1 (forever)");
		expect(h.sentUserMessages[0]).toContain("keep polishing the docs");
	});

	it("rejects a missing task", async () => {
		const h = createHarness();
		await loopCmd(h).handler("forever", h.ctx);
		expect(h.ui.notify).toHaveBeenCalledWith("Provide a task description", "error");
		expect(h.sentUserMessages).toHaveLength(0);
	});

	it("ignores the model's done and keeps going", async () => {
		const h = createHarness();
		await loopCmd(h).handler("forever tidy up", h.ctx);
		const r = (await h.toolDefs[0].execute(
			"1",
			{ status: "done", summary: "finished" },
			undefined,
			vi.fn(),
			h.ctx,
		)) as { content: { text: string }[]; details: { active: boolean; done: boolean } };
		expect(r.details).toMatchObject({ active: true, done: false });
		expect(r.content[0].text).toContain('"done" is ignored');
		expect(h.sentMessages.at(-1)!.msg.content).toContain("Iteration 2 (forever)");
	});

	it("/loop-stop still ends it", async () => {
		const h = createHarness();
		await loopCmd(h).handler("forever tidy up", h.ctx);
		await stopCmd(h).handler("", h.ctx);
		expect(h.ui.notify).toHaveBeenCalledWith(
			"Loop stopped after 1 iteration(s)",
			"warning",
		);
		// and a later bug-end is not nudged
		await h.handlers.get("agent_end")!(
			{ messages: [{ role: "assistant", stopReason: "stop" }] },
			h.ctx,
		);
		expect(h.sentMessages.filter((m) => m.msg.customType === "loop-nudge")).toHaveLength(0);
	});

	it("Ctrl+Shift+X still ends it and aborts the turn", async () => {
		const h = createHarness();
		await loopCmd(h).handler("forever tidy up", h.ctx);
		const shortcut = [...h.shortcuts.values()][0];
		await shortcut.handler(h.ctx);
		expect(h.ctx.abort).toHaveBeenCalled();
		expect(h.ui.notify).toHaveBeenCalledWith("Loop aborted", "warning");
	});

	it("nudges a bug-ended turn while it is running", async () => {
		const h = createHarness();
		await loopCmd(h).handler("forever tidy up", h.ctx);
		await h.handlers.get("agent_end")!(
			{ messages: [{ role: "assistant", stopReason: "stop" }] },
			h.ctx,
		);
		const nudges = h.sentMessages.filter((m) => m.msg.customType === "loop-nudge");
		expect(nudges).toHaveLength(1);
		expect(nudges[0].msg.content).toContain("runs until the user stops it");
	});

	it("survives reconstruction as an endless loop", async () => {
		const h = createHarness();
		h.branch.push({
			type: "message",
			message: {
				role: "toolResult",
				toolName: "loop_control",
				details: {
					active: true, mode: "goal", currentStep: 7, maxSteps: null,
					goal: "restored forever", done: false, reasonDone: "", forever: true,
				},
			},
		});
		await h.handlers.get("session_start")!({}, h.ctx);
		const r = (await h.toolDefs[0].execute(
			"1",
			{ status: "done", summary: "s" },
			undefined,
			vi.fn(),
			h.ctx,
		)) as { details: { active: boolean; forever: boolean; currentStep: number } };
		expect(r.details).toMatchObject({ active: true, forever: true, currentStep: 8 });
	});
});

describe("a stopped loop stays stopped across restarts", () => {
	const restart = async (h: ReturnType<typeof createHarness>) =>
		h.handlers.get("session_start")!({}, h.ctx);
	const nudge = async (h: ReturnType<typeof createHarness>) =>
		h.handlers.get("agent_end")!(
			{ messages: [{ role: "assistant", stopReason: "stop" }] },
			h.ctx,
		);

	it("persists a stop marker so a forever loop cannot resurrect", async () => {
		const h = createHarness();
		await loopCmd(h).handler("forever tidy up", h.ctx);
		await h.toolDefs[0].execute("1", { status: "next", summary: "s" }, undefined, vi.fn(), h.ctx);
		await stopCmd(h).handler("", h.ctx);
		expect(h.branch.some((e) => (e as { customType?: string }).customType === "loop-stopped")).toBe(true);

		// fresh extension instance replaying the same branch
		const h2 = createHarness();
		h2.branch.push(...h.branch);
		await restart(h2);
		await nudge(h2);
		expect(h2.sentMessages.filter((m) => m.msg.customType === "loop-nudge")).toHaveLength(0);
	});

	it("keeps the shortcut stop across a restart too", async () => {
		const h = createHarness();
		await loopCmd(h).handler("forever tidy up", h.ctx);
		await [...h.shortcuts.values()][0].handler(h.ctx);
		const h2 = createHarness();
		h2.branch.push(...h.branch);
		await restart(h2);
		await nudge(h2);
		expect(h2.sentMessages).toHaveLength(0);
	});

	it("records the stop reason", async () => {
		const h = createHarness();
		await loopCmd(h).handler("goal x", h.ctx);
		await stopCmd(h).handler("", h.ctx);
		const marker = h.branch.find(
			(e) => (e as { customType?: string }).customType === "loop-stopped",
		) as { data?: { reason?: string } };
		expect(marker.data?.reason).toBe("Stopped by user");
	});

	it("lets a loop started after a stop win", async () => {
		const h = createHarness();
		await loopCmd(h).handler("forever first", h.ctx);
		await stopCmd(h).handler("", h.ctx);
		// a later loop_control result (newer than the marker) restores an active loop
		h.branch.push({
			type: "message",
			message: {
				role: "toolResult",
				toolName: "loop_control",
				details: {
					active: true, mode: "goal", currentStep: 1, maxSteps: null,
					goal: "second", done: false, reasonDone: "", forever: true,
				},
			},
		});
		const h2 = createHarness();
		h2.branch.push(...h.branch);
		await restart(h2);
		await nudge(h2);
		expect(h2.sentMessages.filter((m) => m.msg.customType === "loop-nudge")).toHaveLength(1);
		expect(h2.sentMessages[0].msg.content).toContain("second");
	});

	it("documents that Esc alone does not exit a forever loop", async () => {
		const h = createHarness();
		await loopCmd(h).handler("forever tidy up", h.ctx);
		// aborted run: no nudge for that turn …
		await h.handlers.get("agent_end")!(
			{ messages: [{ role: "assistant", stopReason: "aborted" }] },
			h.ctx,
		);
		expect(h.sentMessages).toHaveLength(0);
		// … but the loop is still armed, so the next ordinary turn end resumes it
		await nudge(h);
		expect(h.sentMessages.filter((m) => m.msg.customType === "loop-nudge")).toHaveLength(1);
	});
});

describe("force-close: agent_end nudge", () => {
	const agentEnd = (h: Harness, messages: unknown[] = []) =>
		h.handlers.get("agent_end")!({ messages }, h.ctx);

	it("nudges a run that ended with the loop still open", async () => {
		const h = createHarness();
		await loopCmd(h).handler("goal keep going", h.ctx);
		await agentEnd(h, [
			{ role: "assistant", stopReason: "stop" },
		]);
		expect(h.sentMessages).toHaveLength(1);
		expect(h.sentMessages[0].msg).toMatchObject({
			customType: "loop-nudge",
			display: false,
		});
		expect(h.sentMessages[0].msg.content).toContain("Continue working");
		expect(h.sentMessages[0].opts).toEqual({
			triggerTurn: true,
			deliverAs: "steer",
		});
	});

	it("does not nudge after loop_control completed the loop", async () => {
		const h = createHarness();
		await loopCmd(h).handler("goal done now", h.ctx);
		await execTool(h, { status: "done", summary: "finished" });
		await agentEnd(h, [{ role: "assistant", stopReason: "stop" }]);
		expect(h.sentMessages).toHaveLength(0);
	});

	it("does not nudge after /loop-stop", async () => {
		const h = createHarness();
		await loopCmd(h).handler("goal stop soon", h.ctx);
		await stopCmd(h).handler("", h.ctx);
		await agentEnd(h, [{ role: "assistant", stopReason: "stop" }]);
		expect(h.sentMessages).toHaveLength(0);
	});

	it("never nudges an aborted run", async () => {
		const h = createHarness();
		await loopCmd(h).handler("goal abort me", h.ctx);
		await agentEnd(h, [{ role: "assistant", stopReason: "aborted" }]);
		expect(h.sentMessages).toHaveLength(0);
	});

	it("never nudges an errored run", async () => {
		const h = createHarness();
		await loopCmd(h).handler("goal error me", h.ctx);
		await agentEnd(h, [{ role: "assistant", stopReason: "error" }]);
		expect(h.sentMessages).toHaveLength(0);
	});

	it("nudges when the run ends on a tool result (no stopReason)", async () => {
		// a terminating tool batch can end a run with a toolResult last; the
		// loop is still open and the user did not abort -> nudge fires
		const h = createHarness();
		await loopCmd(h).handler("goal tool ended", h.ctx);
		await agentEnd(h, [{ role: "toolResult", toolName: "other" }]);
		expect(h.sentMessages).toHaveLength(1);
		expect(h.sentMessages[0].msg.customType).toBe("loop-nudge");
	});

	it("re-arms after next, so a second bug-end is nudged again", async () => {
		const h = createHarness();
		await loopCmd(h).handler("2 two passes", h.ctx);
		await execTool(h, { status: "next", summary: "pass one done" });
		// model ends the second pass without calling loop_control
		await agentEnd(h, [{ role: "assistant", stopReason: "stop" }]);
		const nudges = h.sentMessages.filter(
			(m) => m.msg.customType === "loop-nudge",
		);
		expect(nudges).toHaveLength(1);
		expect(nudges[0].msg.content).toContain("pass 2/2");
	});

	it("nudges after reconstruction of an active loop", async () => {
		const h = createHarness();
		h.branch.push({
			type: "message",
			message: {
				role: "toolResult",
				toolName: "loop_control",
				details: {
					active: true,
					mode: "goal",
					currentStep: 3,
					maxSteps: null,
					goal: "restored",
					done: false,
					reasonDone: "",
				},
			},
		});
		await h.handlers.get("session_start")!({}, h.ctx);
		await agentEnd(h, [{ role: "assistant", stopReason: "stop" }]);
		expect(h.sentMessages).toHaveLength(1);
		expect(h.sentMessages[0].msg.content).toContain("iteration 4");
	});

	it("is silent when no loop is active", async () => {
		const h = createHarness();
		await agentEnd(h, [{ role: "assistant", stopReason: "stop" }]);
		expect(h.sentMessages).toHaveLength(0);
	});
});

describe("before_agent_start", () => {
	it("appends the loop context to the system prompt while active", async () => {
		const h = createHarness();
		await loopCmd(h).handler("goal injected", h.ctx);
		const r = (await h.handlers.get("before_agent_start")!(
			{ systemPrompt: "base" },
			h.ctx,
		)) as { systemPrompt: string };
		expect(r.systemPrompt.startsWith("base")).toBe(true);
		expect(r.systemPrompt).toContain("## Active Loop");
		expect(r.systemPrompt).toContain("Goal: injected");
	});

	it("returns nothing when no loop is active", async () => {
		const h = createHarness();
		const r = await h.handlers.get("before_agent_start")!(
			{ systemPrompt: "base" },
			h.ctx,
		);
		expect(r).toBeUndefined();
	});
});

describe("session reconstruction", () => {
	it("restores an active count loop from a previous loop_control result", async () => {
		const h = createHarness();
		h.branch.push({
			type: "message",
			message: {
				role: "toolResult",
				toolName: "loop_control",
				details: {
					active: true,
					mode: "passes",
					currentStep: 1,
					maxSteps: 4,
					goal: "restored",
					done: false,
					reasonDone: "",
				},
			},
		});
		await h.handlers.get("session_start")!({}, h.ctx);
		const r = await execTool(h, { status: "next", summary: "s" });
		expect(r.content[0].text).toBe("→ Advancing to step 3. Summary: s");
		expect(h.sentMessages[0].msg.content).toContain("## Loop — Pass 3 of 4");
	});

	it("restores a goal loop whose cap was JSON round-tripped to null", async () => {
		const h = createHarness();
		const details = JSON.parse(
			JSON.stringify({
				active: true,
				mode: "goal",
				currentStep: 2,
				maxSteps: null,
				goal: "keep going",
				done: false,
				reasonDone: "",
			}),
		);
		h.branch.push({
			type: "message",
			message: { role: "toolResult", toolName: "loop_control", details },
		});
		await h.handlers.get("session_start")!({}, h.ctx);
		const r = await execTool(h, { status: "next", summary: "still going" });
		expect(r.details?.done).toBe(false); // goal loops never end on count
		expect(r.content[0].text).toContain("Advancing to step 4");
	});

	it("reconstructs on session_tree as well", async () => {
		const h = createHarness();
		h.branch.push({
			type: "message",
			message: {
				role: "toolResult",
				toolName: "loop_control",
				details: {
					active: true,
					mode: "passes",
					currentStep: 0,
					maxSteps: 2,
					goal: "tree nav",
					done: false,
					reasonDone: "",
				},
			},
		});
		await h.handlers.get("session_tree")!({}, h.ctx);
		const r = await execTool(h, { status: "next", summary: "s" });
		expect(r.content[0].text).toBe("→ Advancing to step 2. Summary: s");
	});

	it("last loop_control result wins (later done overrides earlier active)", async () => {
		const h = createHarness();
		h.branch.push(
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "loop_control",
					details: {
						active: true,
						mode: "passes",
						currentStep: 1,
						maxSteps: 3,
						goal: "first",
						done: false,
						reasonDone: "",
					},
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "loop_control",
					details: {
						active: false,
						mode: "passes",
						currentStep: 2,
						maxSteps: 3,
						goal: "first",
						done: true,
						reasonDone: "Completed all passes",
					},
				},
			},
		);
		await h.handlers.get("session_start")!({}, h.ctx);
		const r = await execTool(h, { status: "next", summary: "x" });
		expect(r.content[0].text).toBe(
			"No active loop. Start one with /loop.",
		);
	});

	it("resets an in-memory loop when the branch has no loop results", async () => {
		const h = createHarness();
		await loopCmd(h).handler("goal bleeding", h.ctx);
		// branch has only unrelated entries; session_start must reset state
		h.branch.push({
			type: "message",
			message: { role: "toolResult", toolName: "other", details: {} },
		});
		await h.handlers.get("session_start")!({}, h.ctx);
		const r = await execTool(h, { status: "next", summary: "x" });
		expect(r.content[0].text).toBe(
			"No active loop. Start one with /loop.",
		);
	});

	it("ignores unrelated tool results", async () => {
		const h = createHarness();
		h.branch.push({
			type: "message",
			message: {
				role: "toolResult",
				toolName: "something_else",
				details: { active: true },
			},
		});
		await h.handlers.get("session_start")!({}, h.ctx);
		const r = await execTool(h, { status: "next", summary: "x" });
		expect(r.content[0].text).toBe(
			"No active loop. Start one with /loop.",
		);
	});
});
