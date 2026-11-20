import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";
import type { LoopState } from "../src/state.ts";
import { foreverState } from "./helpers.ts";

type ToolParams = { reason?: string; verdict?: string; summary?: string };
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
	customType?: string;
	data?: unknown;
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
	const effects: string[] = [];
	let activeTools = ["read", "bash", "loop_done", "unrelated_tool"];

	const ui = {
		notify: vi.fn(),
		setStatus: vi.fn(),
		setWidget: vi.fn(),
	};

	const setTools = (names: string[]) => {
		activeTools = [...names];
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
		sendUserMessage: (content: string) => {
			effects.push("send-user");
			sentUserMessages.push(content);
		},
		appendEntry: (customType: string, data?: unknown) => {
			effects.push(`entry:${customType}`);
			branch.push({ type: "custom", customType, data } as never);
		},
		getActiveTools: () => [...activeTools],
		setActiveTools: vi.fn(setTools),
	} as unknown as ExtensionAPI;

	const ctx = {
		ui,
		waitForIdle: vi.fn(async () => {}),
		abort: vi.fn(() => effects.push("abort")),
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
		effects,
		ctx,
		ui,
		branch,
		activeTools: () => [...activeTools],
		setActiveTools: pi.setActiveTools as unknown as ReturnType<typeof vi.fn>,
		setTools,
	};
}

type Harness = ReturnType<typeof createHarness>;

const loopCmd = (h: Harness) => h.commands.get("loop")!;
const stopCmd = (h: Harness) => h.commands.get("loop-stop")!;
const shortcut = (h: Harness) => h.shortcuts.get("ctrl+shift+x")!;

async function execTool(h: Harness, params: ToolParams): Promise<ToolResult> {
	return doneTool(h).execute("call-1", params, undefined, undefined, h.ctx);
}

async function execApprove(h: Harness, params: ToolParams): Promise<ToolResult> {
	return approveTool(h).execute("call-2", params, undefined, undefined, h.ctx);
}

async function execNext(h: Harness, params: ToolParams): Promise<ToolResult> {
	return nextTool(h).execute("call-3", params, undefined, undefined, h.ctx);
}

/** A normal turn end: the model finished and stopped. */
async function turnEnd(
	h: Harness,
	stopReason = "stop",
): Promise<void> {
	await h.handlers.get("agent_end")!(
		{ messages: [{ role: "assistant", stopReason }] },
		h.ctx,
	);
}

const doneTool = (h: Harness) => h.toolDefs.find((t) => t.name === "loop_done")!;
const nextTool = (h: Harness) => h.toolDefs.find((t) => t.name === "loop_next")!;
const approveTool = (h: Harness) =>
	h.toolDefs.find((t) => t.name === "loop_approve")!;

const evaluations = (h: Harness) =>
	h.sentMessages.filter((m) => m.msg.customType === "loop-evaluate");
const resumes = (h: Harness) =>
	h.sentMessages.filter((m) => m.msg.customType === "loop-resume");

const iterations = (h: Harness) =>
	h.sentMessages.filter((m) => m.msg.customType === "loop-iteration");
const nudges = (h: Harness) =>
	h.sentMessages.filter((m) => m.msg.customType === "loop-nudge");
const completions = (h: Harness) =>
	h.sentMessages.filter((m) => m.msg.customType === "loop-complete");

describe("extension surface", () => {
	it("registers the loop and loop-stop commands, both tools, and the shortcut", () => {
		const h = createHarness();
		expect(h.commands.has("loop")).toBe(true);
		expect(h.commands.has("loop-stop")).toBe(true);
		expect(h.shortcuts.has("ctrl+shift+x")).toBe(true);
		expect(h.toolDefs.map((t) => t.name)).toEqual([
			"loop_next",
			"loop_done",
			"loop_approve",
		]);
	});

	it("listens only to current-Pi events", () => {
		const h = createHarness();
		for (const ev of [
			"session_start",
			"session_tree",
			"before_agent_start",
			"agent_end",
			"tool_call",
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
		expect(h.ui.setWidget).toHaveBeenCalledWith("loop", [
			"pass 1/5 · refine the renderer",
			"Ctrl+Shift+X to stop",
		]);
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

	it("rejects a zero count with the parser message", async () => {
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

	it("persists the start state before dispatching the kickoff", async () => {
		const h = createHarness();
		await loopCmd(h).handler("goal durable", h.ctx);
		const start = h.branch.find(
			(e) => e.customType === "loop-state",
		) as { data?: LoopState };
		expect(start.data).toMatchObject({
			active: true,
			forever: false,
			goal: "durable",
			currentStep: 0,
		});
		expect(h.effects.indexOf("entry:loop-state")).toBeLessThan(
			h.effects.indexOf("send-user"),
		);
	});
});

describe("loop_done claims completion", () => {
	it("records the claim and asks for confirmation instead of closing", async () => {
		const h = createHarness();
		await loopCmd(h).handler("goal win", h.ctx);
		const r = await execTool(h, { reason: "all tests pass" });
		expect(r.details).toMatchObject({ active: true, done: false, evaluating: true });
		expect(r.content[0].text).toContain("confirmed in the next turn");
		expect(evaluations(h)).toHaveLength(1);
		expect(evaluations(h)[0].msg.content).toContain("Has the goal actually been reached?");
		expect(h.ui.setStatus).toHaveBeenLastCalledWith("loop", "loop · evaluating");
	});

	it("exposes only loop_approve while the claim is being checked", async () => {
		const h = createHarness();
		await loopCmd(h).handler("goal win", h.ctx);
		expect(h.activeTools()).toContain("loop_done");
		expect(h.activeTools()).toContain("loop_next");
		expect(h.activeTools()).not.toContain("loop_approve");
		await execTool(h, { reason: "all tests pass" });
		expect(h.activeTools()).not.toContain("loop_done");
		expect(h.activeTools()).not.toContain("loop_next");
		expect(h.activeTools()).toContain("loop_approve");
	});

	it("closes the loop when the claim is confirmed", async () => {
		const h = createHarness();
		await loopCmd(h).handler("goal win", h.ctx);
		await execTool(h, { reason: "all tests pass" });
		const r = await execApprove(h, { verdict: "reached", reason: "verified" });
		expect(r.content[0].text).toContain("Loop complete after 1 iteration(s)");
		expect(r.content[0].text).toContain("verified");
		expect(r.details).toMatchObject({ active: false, done: true });
		expect(h.ui.setWidget).toHaveBeenLastCalledWith("loop", undefined);
		// no loop tool is exposed once the loop is over
		expect(h.activeTools()).not.toContain("loop_done");
		expect(h.activeTools()).not.toContain("loop_next");
		expect(h.activeTools()).not.toContain("loop_approve");
	});

	it("keeps the loop open when the claim is rejected", async () => {
		const h = createHarness();
		await loopCmd(h).handler("goal win", h.ctx);
		await execTool(h, { reason: "all tests pass" });
		const r = await execApprove(h, { verdict: "not_reached", reason: "the build fails" });
		expect(r.details).toMatchObject({ active: true, done: false, evaluating: false });
		expect(resumes(h)).toHaveLength(1);
		expect(resumes(h)[0].msg.content).toContain("the build fails");
		expect(resumes(h)[0].msg.content).toContain("Keep working on the goal");
		// the work tools come back, the approval tool goes away
		expect(h.activeTools()).toContain("loop_done");
		expect(h.activeTools()).toContain("loop_next");
		expect(h.activeTools()).not.toContain("loop_approve");
	});

	it("keeps the loop open when the model claims the goal is unreachable", async () => {
		const h = createHarness();
		await loopCmd(h).handler("goal win", h.ctx);
		await execTool(h, { reason: "all tests pass" });
		const r = await execApprove(h, { verdict: "not_reached", reason: "impossible to reach" });
		expect(r.details).toMatchObject({ active: true, done: false });
		expect(resumes(h)[0].msg.content).toContain("impossible to reach");
		expect(resumes(h)[0].msg.content).toContain("do what is achievable and keep going");
	});

	it("resumes when the check turn ends without a verdict", async () => {
		const h = createHarness();
		await loopCmd(h).handler("goal win", h.ctx);
		await execTool(h, { reason: "all tests pass" });
		// the model ends the check turn without calling loop_approve
		await turnEnd(h);
		expect(resumes(h)).toHaveLength(1);
		expect(resumes(h)[0].msg.content).toContain("the claim was not confirmed");
		expect(h.activeTools()).toContain("loop_done");
		expect(h.activeTools()).toContain("loop_next");
		expect(h.activeTools()).not.toContain("loop_approve");
	});

	it("never advances the loop — that is the extension's job", async () => {
		const h = createHarness();
		await loopCmd(h).handler("goal x", h.ctx);
		await turnEnd(h);
		expect(iterations(h)).toHaveLength(1);
		const r = await execTool(h, { reason: "claiming" });
		expect(r.details?.currentStep).toBe(1);
	});

	it("is a no-op when no loop is active", async () => {
		const h = createHarness();
		const r = await execTool(h, { reason: "x" });
		expect(r.content[0].text).toBe("No active loop. Start one with /loop.");
		expect(r.details).toBeUndefined();
	});

	it("rejects a call without a justification and changes nothing", async () => {
		const h = createHarness();
		await loopCmd(h).handler("goal x", h.ctx);
		const r = await execTool(h, {});
		expect(r.content[0].text).toContain("needs a reason");
		expect(r.details).toBeUndefined();
		expect(evaluations(h)).toHaveLength(0);
	});

	it("does not persist a rejected call", async () => {
		const h = createHarness();
		await loopCmd(h).handler("goal x", h.ctx);
		const before = h.branch.length;
		await execTool(h, {});
		expect(h.branch.length).toBe(before);
	});

	it("blocks a stale loop_done while a claim is being checked", async () => {
		const h = createHarness();
		await loopCmd(h).handler("goal x", h.ctx);
		await execTool(h, { reason: "claiming" });
		const blocked = h.handlers.get("tool_call")!(
			{ toolName: "loop_done" },
			h.ctx,
		);
		expect(blocked).toEqual({
			block: true,
			reason: "loop_done is unavailable while a completion claim is being checked.",
		});
	});

	it("blocks a stale loop_approve outside the check phase", async () => {
		const h = createHarness();
		await loopCmd(h).handler("goal x", h.ctx);
		const blocked = h.handlers.get("tool_call")!(
			{ toolName: "loop_approve" },
			h.ctx,
		);
		expect(blocked).toEqual({
			block: true,
			reason: "loop_approve is only available while a completion claim is being checked.",
		});
	});
});

describe("a turn end advances the loop", () => {
	it("advances to the next iteration", async () => {
		const h = createHarness();
		await loopCmd(h).handler("goal keep going", h.ctx);
		await turnEnd(h);
		expect(iterations(h)).toHaveLength(1);
		expect(iterations(h)[0].msg.content).toContain("## Loop — Iteration 2");
		expect(iterations(h)[0].msg).toMatchObject({
			customType: "loop-iteration",
			display: false,
		});
		expect(iterations(h)[0].opts).toEqual({
			triggerTurn: true,
			deliverAs: "steer",
		});
		expect(h.ui.setWidget).toHaveBeenLastCalledWith("loop", [
			"iter 2 · keep going",
			"Ctrl+Shift+X to stop",
		]);
	});

	it("advances again on the next turn end", async () => {
		const h = createHarness();
		await loopCmd(h).handler("goal keep going", h.ctx);
		await turnEnd(h);
		await turnEnd(h);
		expect(iterations(h)).toHaveLength(2);
		expect(iterations(h)[1].msg.content).toContain("## Loop — Iteration 3");
	});

	it("keeps advancing a goal loop without a cap", async () => {
		const h = createHarness();
		await loopCmd(h).handler("goal endless", h.ctx);
		for (let i = 0; i < 5; i++) await turnEnd(h);
		expect(iterations(h)).toHaveLength(5);
		expect(iterations(h)[4].msg.content).toContain("## Loop — Iteration 6");
		expect(completions(h)).toHaveLength(0);
		expect(h.ui.setWidget).toHaveBeenLastCalledWith("loop", [
			"iter 6 · endless",
			"Ctrl+Shift+X to stop",
		]);
	});

	it("does not advance after the model ended the loop", async () => {
		const h = createHarness();
		await loopCmd(h).handler("goal done now", h.ctx);
		await execTool(h, { reason: "finished" });
		await turnEnd(h);
		expect(iterations(h)).toHaveLength(0);
	});

	it("does not advance after /loop-stop", async () => {
		const h = createHarness();
		await loopCmd(h).handler("goal stop soon", h.ctx);
		await stopCmd(h).handler("", h.ctx);
		await turnEnd(h);
		expect(iterations(h)).toHaveLength(0);
	});

	it("never advances an aborted run", async () => {
		const h = createHarness();
		await loopCmd(h).handler("goal abort me", h.ctx);
		await turnEnd(h, "aborted");
		expect(iterations(h)).toHaveLength(0);
	});

	it("never advances an errored run", async () => {
		const h = createHarness();
		await loopCmd(h).handler("goal error me", h.ctx);
		await turnEnd(h, "error");
		expect(iterations(h)).toHaveLength(0);
	});

	it("advances when the run ends on a tool result (no stopReason)", async () => {
		// a terminating tool batch can end a run with a toolResult last; the
		// loop is still open and the user did not abort -> the loop advances
		const h = createHarness();
		await loopCmd(h).handler("goal tool ended", h.ctx);
		await h.handlers.get("agent_end")!(
			{ messages: [{ role: "toolResult", toolName: "other" }] },
			h.ctx,
		);
		expect(iterations(h)).toHaveLength(1);
	});

	it("advances after reconstruction of an active loop", async () => {
		const h = createHarness();
		h.branch.push({
			type: "custom",
			customType: "loop-state",
			data: {
				active: true,
				currentStep: 3,
				goal: "restored",
				done: false,
				reasonDone: "",
				forever: false,
			},
		});
		await h.handlers.get("session_start")!({}, h.ctx);
		await turnEnd(h);
		expect(iterations(h)).toHaveLength(1);
		// three iterations were already done, so the turn that just ended was
		// the fourth and the next prompt is the fifth
		expect(iterations(h)[0].msg.content).toContain("Iteration 5");
	});

	it("is silent when no loop is active", async () => {
		const h = createHarness();
		await turnEnd(h);
		expect(iterations(h)).toHaveLength(0);
		expect(nudges(h)).toHaveLength(0);
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
		const r = await execTool(h, { reason: "x" });
		expect(r.content[0].text).toBe("No active loop. Start one with /loop.");
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
		expect(h.effects.indexOf("entry:loop-stopped")).toBeLessThan(
			h.effects.indexOf("abort"),
		);
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
				toolName: "loop_done",
				details: { active: true, mode: "goal", currentStep: 2, goal: "legacy" },
			},
		});
		await h.handlers.get("session_start")!({}, h.ctx);
		await turnEnd(h);
		expect(iterations(h)).toHaveLength(1);
		expect(iterations(h)[0].msg.content).toContain("Iteration 4");
	});

	it("still advances a restored active loop", async () => {
		const h = createHarness();
		h.branch.push({
			type: "message",
			message: {
				role: "toolResult",
				toolName: "loop_done",
				details: { active: true, mode: "goal", currentStep: 2, maxSteps: null, goal: "restored", done: false, reasonDone: "" },
			},
		});
		await h.handlers.get("session_start")!({}, h.ctx);
		await turnEnd(h);
		expect(iterations(h)).toHaveLength(1);
		expect(iterations(h)[0].msg.content).toContain("Iteration 4");
	});
});

describe("/loop forever", () => {
	it("removes loop_done before dispatching the tool-free kickoff", async () => {
		const h = createHarness();
		await loopCmd(h).handler("forever keep polishing the docs", h.ctx);
		expect(h.ui.notify).not.toHaveBeenCalled();
		expect(h.activeTools()).toEqual(["read", "bash", "unrelated_tool"]);
		expect(h.setActiveTools).toHaveBeenCalledWith(["read", "bash", "unrelated_tool"]);
		expect(h.sentUserMessages[0]).toContain("## Forever Loop");
		expect(h.sentUserMessages[0]).toContain("keep polishing the docs");
		expect(h.sentUserMessages[0]).not.toMatch(/loop_done|next|done|iteration/i);
	});

	it("writes a durable start record before any model response", async () => {
		const h = createHarness();
		await loopCmd(h).handler("forever tidy up", h.ctx);
		const start = h.branch.find(
			(e) => e.customType === "loop-state",
		) as { data?: LoopState };
		expect(start.data).toMatchObject({ active: true, forever: true, goal: "tidy up" });
		expect(h.effects.indexOf("entry:loop-state")).toBeLessThan(
			h.effects.indexOf("send-user"),
		);
	});

	it("rejects a missing task", async () => {
		const h = createHarness();
		await loopCmd(h).handler("forever", h.ctx);
		expect(h.ui.notify).toHaveBeenCalledWith("Provide a task description", "error");
		expect(h.sentUserMessages).toHaveLength(0);
	});

	it("blocks a stale loop_control call", async () => {
		const h = createHarness();
		await loopCmd(h).handler("forever tidy up", h.ctx);
		const blocked = h.handlers.get("tool_call")!(
			{ toolName: "loop_done" },
			h.ctx,
		);
		expect(blocked).toEqual({
			block: true,
			reason: "loop_done is unavailable during a forever loop.",
		});
		const r = await execTool(h, { reason: "stale" });
		expect(r.details).toBeUndefined();
		expect(r.content[0].text).toBe("loop_done is unavailable during a forever loop.");
		expect(h.sentMessages).toHaveLength(0);
	});

	it("does not block loop_control while inactive or in ordinary loops", async () => {
		const h = createHarness();
		expect(h.handlers.get("tool_call")!({ toolName: "loop_done" }, h.ctx)).toBeUndefined();
		await loopCmd(h).handler("goal x", h.ctx);
		expect(h.handlers.get("tool_call")!({ toolName: "loop_done" }, h.ctx)).toBeUndefined();
	});

	it("continues on each ordinary agent end without manufacturing progress", async () => {
		const h = createHarness();
		await loopCmd(h).handler("forever tidy up", h.ctx);
		await turnEnd(h);
		await turnEnd(h);
		expect(nudges(h)).toHaveLength(2);
		expect(nudges(h)[0].msg.content).toMatch(/forever loop remains active/i);
		expect(nudges(h)[0].msg.content).not.toMatch(/loop_control|next|done|iteration/i);
		expect(h.ui.setStatus).toHaveBeenCalledWith("loop", "loop · forever");
		expect(h.ui.setWidget).toHaveBeenCalledWith("loop", [
			"forever · tidy up",
			"Ctrl+Shift+X to stop",
		]);
	});

	it("re-removes a tool manually reactivated during continuation", async () => {
		const h = createHarness();
		await loopCmd(h).handler("forever tidy up", h.ctx);
		// Simulate another extension/user turning it back on between turns.
		h.setTools(["read", "bash", "loop_done", "unrelated_tool"]);
		await turnEnd(h);
		expect(h.activeTools()).not.toContain("loop_done");
	});

	it("/loop-stop still ends it without a made-up count", async () => {
		const h = createHarness();
		await loopCmd(h).handler("forever tidy up", h.ctx);
		await stopCmd(h).handler("", h.ctx);
		expect(h.ui.notify).toHaveBeenCalledWith("Forever loop stopped", "warning");
		expect(h.activeTools()).not.toContain("loop_done");
		await turnEnd(h);
		expect(nudges(h)).toHaveLength(0);
	});

	it("Ctrl+Shift+X still ends it and aborts the turn", async () => {
		const h = createHarness();
		await loopCmd(h).handler("forever tidy up", h.ctx);
		await shortcut(h).handler(h.ctx);
		expect(h.ctx.abort).toHaveBeenCalled();
		expect(h.ui.notify).toHaveBeenCalledWith("Loop aborted", "warning");
		expect(h.activeTools()).not.toContain("loop_done");
	});

	it("restores a tool-free forever loop from its start record", async () => {
		const h = createHarness();
		h.branch.push({
			type: "custom",
			customType: "loop-state",
			data: { ...foreverState(7), goal: "restored forever" },
		});
		await h.handlers.get("session_start")!({}, h.ctx);
		expect(h.activeTools()).not.toContain("loop_done");
		expect(h.ui.setStatus).toHaveBeenCalledWith("loop", "loop · forever");
		await turnEnd(h);
		expect(nudges(h)[0].msg.content).toContain("restored forever");
	});

	it("also removes the tool when legacy forever details are restored on tree navigation", async () => {
		const h = createHarness();
		h.branch.push({
			type: "message",
			message: { role: "toolResult", toolName: "loop_done", details: foreverState(7) },
		});
		await h.handlers.get("session_tree")!({}, h.ctx);
		expect(h.activeTools()).not.toContain("loop_done");
	});

	it("re-enables the tool only when a normal loop starts, preserving other tools", async () => {
		const h = createHarness();
		await loopCmd(h).handler("forever tidy up", h.ctx);
		h.setTools(["read", "unrelated_tool", "user_added_tool"]);
		await loopCmd(h).handler("goal x", h.ctx);
		expect(h.activeTools()).toEqual([
			"read",
			"unrelated_tool",
			"user_added_tool",
			"loop_next",
			"loop_done",
		]);
		await loopCmd(h).handler("3 x", h.ctx);
		expect(h.activeTools().filter((name) => name === "loop_done")).toHaveLength(1);
		expect(h.activeTools().filter((name) => name === "loop_next")).toHaveLength(1);
	});
});

describe("a stopped loop stays stopped across restarts", () => {
	const restart = async (h: Harness) => h.handlers.get("session_start")!({}, h.ctx);

	it("persists a stop marker so a forever loop cannot resurrect", async () => {
		const h = createHarness();
		await loopCmd(h).handler("forever tidy up", h.ctx);
		await stopCmd(h).handler("", h.ctx);
		expect(h.branch.some((e) => e.customType === "loop-stopped")).toBe(true);

		// fresh extension instance replaying the same branch
		const h2 = createHarness();
		h2.branch.push(...h.branch);
		await restart(h2);
		await turnEnd(h2);
		expect(nudges(h2)).toHaveLength(0);
		expect(iterations(h2)).toHaveLength(0);
	});

	it("keeps the shortcut stop across a restart too", async () => {
		const h = createHarness();
		await loopCmd(h).handler("forever tidy up", h.ctx);
		await shortcut(h).handler(h.ctx);
		const h2 = createHarness();
		h2.branch.push(...h.branch);
		await restart(h2);
		await turnEnd(h2);
		expect(h2.sentMessages).toHaveLength(0);
	});

	it("records the stop reason", async () => {
		const h = createHarness();
		await loopCmd(h).handler("goal x", h.ctx);
		await stopCmd(h).handler("", h.ctx);
		const marker = h.branch.find((e) => e.customType === "loop-stopped") as {
			data?: { reason?: string };
		};
		expect(marker.data?.reason).toBe("Stopped by user");
	});

	it("lets a loop started after a stop win", async () => {
		const h = createHarness();
		await loopCmd(h).handler("forever first", h.ctx);
		await stopCmd(h).handler("", h.ctx);
		// a later state entry (newer than the marker) restores an active loop
		h.branch.push({
			type: "custom",
			customType: "loop-state",
			data: {
				active: true, currentStep: 1,
				goal: "second", done: false, reasonDone: "", forever: true,
			},
		});
		const h2 = createHarness();
		h2.branch.push(...h.branch);
		await restart(h2);
		await turnEnd(h2);
		expect(nudges(h2)).toHaveLength(1);
		expect(nudges(h2)[0].msg.content).toContain("second");
	});

	it("documents that Esc alone does not exit a forever loop", async () => {
		const h = createHarness();
		await loopCmd(h).handler("forever tidy up", h.ctx);
		// aborted run: no nudge for that turn …
		await turnEnd(h, "aborted");
		expect(h.sentMessages).toHaveLength(0);
		// … but the loop is still armed, so the next ordinary turn end resumes it
		await turnEnd(h);
		expect(nudges(h)).toHaveLength(1);
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

describe("loop_next advances the iteration", () => {
	it("advances and dispatches the next iteration", async () => {
		const h = createHarness();
		await loopCmd(h).handler("goal keep going", h.ctx);
		const r = await execNext(h, { summary: "half done" });
		expect(r.details).toMatchObject({ currentStep: 1, active: true });
		expect(r.content[0].text).toContain("Continuing to iteration 2");
		expect(iterations(h)).toHaveLength(1);
		expect(iterations(h)[0].msg.content).toContain("## Loop — Iteration 2");
		expect(h.ui.setWidget).toHaveBeenLastCalledWith("loop", [
			"iter 2 · keep going",
			"Ctrl+Shift+X to stop",
		]);
	});

	it("does not count the same iteration again when the turn ends", async () => {
		const h = createHarness();
		await loopCmd(h).handler("goal keep going", h.ctx);
		await execNext(h, { summary: "half done" });
		await turnEnd(h);
		// one advance only: the model already closed that iteration
		expect(iterations(h)).toHaveLength(1);
		expect(h.ui.setStatus).toHaveBeenLastCalledWith("loop", "loop · iter 2");
		// the loop keeps working instead of stalling
		expect(nudges(h)).toHaveLength(1);
		expect(nudges(h)[0].msg.content).toContain("The loop is still active");
	});

	it("advances again on the next turn end", async () => {
		const h = createHarness();
		await loopCmd(h).handler("goal keep going", h.ctx);
		await execNext(h, { summary: "half done" });
		await turnEnd(h);
		await turnEnd(h);
		expect(iterations(h)).toHaveLength(2);
		expect(iterations(h)[1].msg.content).toContain("## Loop — Iteration 3");
	});

	it("is blocked while a claim is being checked", async () => {
		const h = createHarness();
		await loopCmd(h).handler("goal x", h.ctx);
		await execTool(h, { reason: "claiming" });
		const blocked = h.handlers.get("tool_call")!(
			{ toolName: "loop_next" },
			h.ctx,
		);
		expect(blocked).toEqual({
			block: true,
			reason: "loop_next is unavailable while a completion claim is being checked.",
		});
	});
});

describe("count loops", () => {
	it("runs exactly N iterations and completes on the last one", async () => {
		const h = createHarness();
		await loopCmd(h).handler("3 polish", h.ctx);
		expect(h.sentUserMessages[0]).toContain("## Loop — Pass 1 of 3");

		await turnEnd(h);
		expect(iterations(h)[0].msg.content).toContain("## Loop — Pass 2 of 3");
		await turnEnd(h);
		expect(iterations(h)[1].msg.content).toContain("## Loop — Pass 3 of 3");
		await turnEnd(h);

		const done = h.sentMessages.find((m) => m.msg.customType === "loop-complete");
		expect(done?.msg.content).toContain("all 3 passes done");
		expect(h.ui.setWidget).toHaveBeenLastCalledWith("loop", undefined);
		expect(h.activeTools()).not.toContain("loop_next");
		expect(h.activeTools()).not.toContain("loop_done");
	});

	it("counts an explicit advance and a turn end as separate passes", async () => {
		const h = createHarness();
		await loopCmd(h).handler("3 polish", h.ctx);
		// pass 1 is closed by the model
		await execNext(h, { summary: "pass one" });
		expect(h.ui.setStatus).toHaveBeenLastCalledWith("loop", "loop · pass 2/3");
		// the turn end right after it must not count the same pass twice
		await turnEnd(h);
		expect(h.ui.setStatus).toHaveBeenLastCalledWith("loop", "loop · pass 2/3");
		// the next turn end closes pass 2
		await turnEnd(h);
		expect(h.ui.setStatus).toHaveBeenLastCalledWith("loop", "loop · pass 3/3");
		// and the one after that closes pass 3, which is the last one
		await turnEnd(h);
		const done = h.sentMessages.find((m) => m.msg.customType === "loop-complete");
		expect(done?.msg.content).toContain("all 3 passes done");
	});

	it("never runs more than N passes", async () => {
		const h = createHarness();
		await loopCmd(h).handler("2 polish", h.ctx);
		await execNext(h, { summary: "one" });
		await execNext(h, { summary: "two" });
		await execNext(h, { summary: "three" });
		const done = h.sentMessages.find((m) => m.msg.customType === "loop-complete");
		expect(done?.msg.content).toContain("all 2 passes done");
		expect(h.sentMessages.filter((m) => m.msg.customType === "loop-complete")).toHaveLength(1);
	});

	it("completes early when a claim is confirmed", async () => {
		const h = createHarness();
		await loopCmd(h).handler("3 polish", h.ctx);
		await execTool(h, { reason: "already good enough" });
		await execApprove(h, { verdict: "reached", reason: "verified" });
		const r = await execNext(h, { summary: "x" });
		expect(r.content[0].text).toBe("No active loop. Start one with /loop.");
	});

	it("shows the pass counter in the widget", async () => {
		const h = createHarness();
		await loopCmd(h).handler("3 polish", h.ctx);
		expect(h.ui.setStatus).toHaveBeenLastCalledWith("loop", "loop · pass 1/3");
		expect(h.ui.setWidget).toHaveBeenLastCalledWith("loop", [
			"pass 1/3 · polish",
			"Ctrl+Shift+X to stop",
		]);
	});
});

describe("tool exposure", () => {
	it("exposes no loop tool before a loop starts", async () => {
		const h = createHarness();
		await h.handlers.get("session_start")!({}, h.ctx);
		expect(h.activeTools()).not.toContain("loop_done");
		expect(h.activeTools()).not.toContain("loop_approve");
		expect(h.activeTools()).not.toContain("loop_next");
	});

	it("exposes no loop tool once the loop is over", async () => {
		const h = createHarness();
		await h.handlers.get("session_start")!({}, h.ctx);
		await loopCmd(h).handler("goal x", h.ctx);
		expect(h.activeTools()).toContain("loop_done");
		await execTool(h, { reason: "claiming" });
		await execApprove(h, { verdict: "reached", reason: "verified" });
		expect(h.activeTools()).not.toContain("loop_done");
		expect(h.activeTools()).not.toContain("loop_approve");
		expect(h.activeTools()).not.toContain("loop_next");
	});

	it("exposes no loop tool after /loop-stop", async () => {
		const h = createHarness();
		await h.handlers.get("session_start")!({}, h.ctx);
		await loopCmd(h).handler("goal x", h.ctx);
		await stopCmd(h).handler("", h.ctx);
		expect(h.activeTools()).not.toContain("loop_done");
		expect(h.activeTools()).not.toContain("loop_approve");
		expect(h.activeTools()).not.toContain("loop_next");
	});

	it("exposes no loop tool for a forever loop", async () => {
		const h = createHarness();
		await h.handlers.get("session_start")!({}, h.ctx);
		await loopCmd(h).handler("forever x", h.ctx);
		expect(h.activeTools()).not.toContain("loop_done");
		expect(h.activeTools()).not.toContain("loop_approve");
		expect(h.activeTools()).not.toContain("loop_next");
	});

	it("drops a pending claim when the session is restored", async () => {
		const h = createHarness();
		h.branch.push({
			type: "custom",
			customType: "loop-state",
			data: {
				active: true,
				currentStep: 2,
				goal: "restored",
				done: false,
				reasonDone: "",
				forever: false,
				evaluating: true,
				claimReason: "claimed before the restart",
			},
		});
		await h.handlers.get("session_start")!({}, h.ctx);
		// back to working: only loop_done is exposed, and the claim is gone
		expect(h.activeTools()).toContain("loop_done");
		expect(h.activeTools()).not.toContain("loop_approve");
		await turnEnd(h);
		expect(evaluations(h)).toHaveLength(0);
		expect(iterations(h)).toHaveLength(1);
	});
});

describe("session reconstruction", () => {
	it("restores a legacy count loop as a count loop", async () => {
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
		await turnEnd(h);
		expect(iterations(h)[0].msg.content).toContain("## Loop — Pass 3 of 4");
	});

	it("restores an active loop from a state entry", async () => {
		const h = createHarness();
		h.branch.push({
			type: "custom",
			customType: "loop-state",
			data: {
				active: true,
				currentStep: 1,
				goal: "restored",
				done: false,
				reasonDone: "",
				forever: false,
			},
		});
		await h.handlers.get("session_start")!({}, h.ctx);
		await turnEnd(h);
		expect(iterations(h)[0].msg.content).toContain("## Loop — Iteration 3");
	});

	it("restores a goal loop whose state was JSON round-tripped", async () => {
		const h = createHarness();
		const data = JSON.parse(
			JSON.stringify({
				active: true,
				currentStep: 2,
				goal: "keep going",
				done: false,
				reasonDone: "",
				forever: false,
			}),
		);
		h.branch.push({ type: "custom", customType: "loop-state", data });
		await h.handlers.get("session_start")!({}, h.ctx);
		await turnEnd(h);
		expect(iterations(h)[0].msg.content).toContain("Iteration 4");
	});

	it("reconstructs on session_tree as well", async () => {
		const h = createHarness();
		h.branch.push({
			type: "custom",
			customType: "loop-state",
			data: {
				active: true,
				currentStep: 0,
				goal: "tree nav",
				done: false,
				reasonDone: "",
				forever: false,
			},
		});
		await h.handlers.get("session_tree")!({}, h.ctx);
		await turnEnd(h);
		expect(iterations(h)[0].msg.content).toContain("## Loop — Iteration 2");
	});

	it("the last state entry wins", async () => {
		const h = createHarness();
		h.branch.push(
			{
				type: "custom",
				customType: "loop-state",
				data: {
					active: true, currentStep: 1,
					goal: "first", done: false, reasonDone: "", forever: false,
				},
			},
			{
				type: "custom",
				customType: "loop-state",
				data: {
					active: false, currentStep: 2,
					goal: "first", done: true, reasonDone: "Goal met",
					forever: false,
				},
			},
		);
		await h.handlers.get("session_start")!({}, h.ctx);
		await turnEnd(h);
		expect(iterations(h)).toHaveLength(0);
		const r = await execTool(h, { reason: "x" });
		expect(r.content[0].text).toBe("No active loop. Start one with /loop.");
	});

	it("resets an in-memory loop when the branch has no loop state", async () => {
		const h = createHarness();
		await loopCmd(h).handler("goal bleeding", h.ctx);
		// Simulate switching to a branch with only unrelated entries; the active
		// loop's durable state entry belongs to the previous branch.
		h.branch.length = 0;
		h.branch.push({
			type: "message",
			message: { role: "toolResult", toolName: "other", details: {} },
		});
		await h.handlers.get("session_start")!({}, h.ctx);
		const r = await execTool(h, { reason: "x" });
		expect(r.content[0].text).toBe("No active loop. Start one with /loop.");
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
		const r = await execTool(h, { reason: "x" });
		expect(r.content[0].text).toBe("No active loop. Start one with /loop.");
	});
});
