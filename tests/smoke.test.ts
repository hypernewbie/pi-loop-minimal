import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";
import type { LoopState } from "../src/state.ts";

// End-to-end lifecycle simulations through the extension's public surface:
// command -> turn ends -> completion, exactly like a live session.

type ToolParams = { reason?: string };
type ToolResult = { content: { type: "text"; text: string }[]; details?: LoopState };
type CommandCtx = ExtensionContext & { waitForIdle(): Promise<void> };
type CommandDef = { handler: (args: string, ctx: CommandCtx) => Promise<void> };

function harness() {
	const commands = new Map<string, CommandDef>();
	const toolDefs: {
		execute: (
			id: string,
			params: ToolParams,
			signal: unknown,
			onUpdate: unknown,
			ctx: CommandCtx,
		) => Promise<ToolResult>;
	}[] = [];
	const sentUser: string[] = [];
	const sent: { msg: { content?: string; customType?: string; display?: boolean }; opts: unknown }[] = [];
	const activeTools = ["read", "bash", "loop_done"];
	const ui = { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() };
	const ctx = {
		ui,
		waitForIdle: vi.fn(async () => {}),
		abort: vi.fn(),
		sessionManager: { getBranch: () => [] },
	} as unknown as CommandCtx;

	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();

	extension({
		on: (ev: string, fn: (event: unknown, ctx: unknown) => unknown) =>
			handlers.set(ev, fn),
		registerTool: (d: unknown) => toolDefs.push(d as never),
		registerCommand: (n: string, d: unknown) => commands.set(n, d as CommandDef),
		registerShortcut: () => {},
		sendMessage: (msg: unknown, opts: unknown) => sent.push({ msg: msg as never, opts }),
		sendUserMessage: (c: string) => sentUser.push(c),
		appendEntry: () => {},
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => {
			activeTools.splice(0, activeTools.length, ...names);
		},
	} as unknown as ExtensionAPI);

	const tool = (p: ToolParams) =>
		toolDefs[0].execute("c", p, undefined, undefined, ctx);
	// A normal turn end: the model finished and stopped.
	const turnEnd = (stopReason = "stop") =>
		handlers.get("agent_end")!(
			{ messages: [{ role: "assistant", stopReason }] },
			ctx,
		);

	return { commands, tool, sent, sentUser, ui, ctx, turnEnd, activeTools };
}

describe("goal loop lifecycle", () => {
	it("a turn end advances to the next iteration", async () => {
		const h = harness();
		await h.commands.get("loop")!.handler("goal ship the feature", h.ctx);
		expect(h.sentUser[0]).toContain("## Loop — Iteration 1");

		await h.turnEnd();
		expect(h.sent[0].msg.content).toContain("## Loop — Iteration 2");

		await h.turnEnd();
		expect(h.sent[1].msg.content).toContain("## Loop — Iteration 3");
	});

	it("every goal iteration steers with the open-ended prompt", async () => {
		const h = harness();
		await h.commands.get("loop")!.handler("goal keep going", h.ctx);
		await h.turnEnd();
		await h.turnEnd();
		expect(h.sent[0].msg.content).toContain(
			"call loop_done and give the reason why",
		);
		expect(h.sent[1].msg.content).toContain(
			"call loop_done and give the reason why",
		);
	});

	it("the model ends the loop with a justification", async () => {
		const h = harness();
		await h.commands.get("loop")!.handler("goal ship the feature", h.ctx);
		await h.turnEnd();
		await h.turnEnd();

		const r = await h.tool({ reason: "all green" });
		expect(r.content[0].text).toContain("Loop complete after 3 iteration(s)");
		expect(r.content[0].text).toContain("all green");
		// the loop is over: no further iteration is steered
		await h.turnEnd();
		expect(h.sent).toHaveLength(2);
	});

	it("a call without a justification does not end the loop", async () => {
		const h = harness();
		await h.commands.get("loop")!.handler("goal x", h.ctx);
		const r = await h.tool({});
		expect(r.content[0].text).toContain("needs a reason");
		await h.turnEnd();
		expect(h.sent).toHaveLength(1);
	});
});

describe("cross-surface consistency", () => {
	it("keeps widget, steer prompt, and iteration number in lockstep", async () => {
		const h = harness();
		await h.commands.get("loop")!.handler("goal render", h.ctx);
		await h.turnEnd();

		// widget now shows iter 2 (the iteration now running)
		const lastWidget = h.ui.setWidget.mock.calls.at(-1)!;
		expect(lastWidget[1]).toEqual(["iter 2 · render", "Ctrl+Shift+X to stop"]);
		expect(h.sent[0].msg.content).toContain("## Loop — Iteration 2");
	});

	it("goal-mode states survive a JSON round trip (no Infinity sentinel)", async () => {
		const h = harness();
		await h.commands.get("loop")!.handler("goal stable", h.ctx);
		await h.turnEnd();
		const r = await h.tool({ reason: "done" });
		expect(JSON.parse(JSON.stringify(r.details))).toEqual(r.details);
	});
});
