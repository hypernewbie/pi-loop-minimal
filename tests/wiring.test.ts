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
		for (const ev of ["session_start", "session_tree", "before_agent_start"]) {
			expect(h.handlers.has(ev), ev).toBe(true);
		}
		expect(h.handlers.has("session_switch")).toBe(false);
		expect(h.handlers.has("session_fork")).toBe(false);
		expect(h.handlers.has("agent_end")).toBe(false);
	});
});

describe("/loop completions", () => {
	it("offers the goal completion only while the prefix matches", () => {
		const h = createHarness();
		const completions = loopCmd(h).getArgumentCompletions!;
		expect(completions("goal")).toHaveLength(1);
		expect(completions("go")).toHaveLength(1);
		expect(completions("")).toHaveLength(1);
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
			"Usage:\n  /loop goal <description>\n  /loop <N> <task>",
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
			'Unknown mode "passes". Use: goal, or <N> for an exact-count loop',
			"error",
		);
		expect(h.sentUserMessages).toHaveLength(0);
	});

	it("rejects the pipeline mode", async () => {
		const h = createHarness();
		await loopCmd(h).handler("pipeline a|b do stuff", h.ctx);
		expect(h.ui.notify).toHaveBeenCalledWith(
			'Unknown mode "pipeline". Use: goal, or <N> for an exact-count loop',
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
