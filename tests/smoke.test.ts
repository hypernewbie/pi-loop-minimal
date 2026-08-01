import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";
import type { LoopState } from "../src/state.ts";

// End-to-end lifecycle simulations through the extension's public surface:
// command -> tool calls -> completion, exactly like a live session.

type ToolParams = { status: "next" | "done"; summary: string };
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
	const sent: { msg: { content?: string }; opts: unknown }[] = [];
	const ui = { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() };
	const ctx = {
		ui,
		waitForIdle: vi.fn(async () => {}),
		abort: vi.fn(),
		sessionManager: { getBranch: () => [] },
	} as unknown as CommandCtx;

	extension({
		on: () => {},
		registerTool: (d: unknown) => toolDefs.push(d as never),
		registerCommand: (n: string, d: unknown) => commands.set(n, d as CommandDef),
		registerShortcut: () => {},
		sendMessage: (msg: unknown, opts: unknown) => sent.push({ msg: msg as never, opts }),
		sendUserMessage: (c: string) => sentUser.push(c),
	} as unknown as ExtensionAPI);

	const tool = (p: ToolParams) =>
		toolDefs[0].execute("c", p, undefined, undefined, ctx);
	return { commands, tool, sent, sentUser, ui, ctx };
}

describe("goal loop lifecycle", () => {
	it("start -> two nexts -> done completes after 3 iterations", async () => {
		const h = harness();
		await h.commands.get("loop")!.handler("goal ship the feature", h.ctx);
		expect(h.sentUser[0]).toContain("## Loop — Iteration 1");

		await h.tool({ status: "next", summary: "started" });
		expect(h.sent[0].msg.content).toContain("## Loop — Iteration 2");

		await h.tool({ status: "next", summary: "more" });
		expect(h.sent[1].msg.content).toContain("## Loop — Iteration 3");

		const r = await h.tool({ status: "done", summary: "all done" });
		expect(r.content[0].text).toContain(
			"Loop complete after 3 iteration(s)",
		);
		// no further steer after done
		expect(h.sent).toHaveLength(2);
	});

	it("every goal iteration steers with the open-ended prompt", async () => {
		const h = harness();
		await h.commands.get("loop")!.handler("goal keep going", h.ctx);
		await h.tool({ status: "next", summary: "1" });
		await h.tool({ status: "next", summary: "2" });
		expect(h.sent[0].msg.content).toContain(
			'call loop_control with status "done" and explain why',
		);
		expect(h.sent[1].msg.content).toContain(
			'call loop_control with status "done" and explain why',
		);
	});
});

describe("count loop lifecycle", () => {
	it("/loop 3 runs exactly three passes, then completes on the third next", async () => {
		const h = harness();
		await h.commands.get("loop")!.handler("3 polish", h.ctx);
		expect(h.sentUser[0]).toContain("## Loop — Pass 1 of 3");

		await h.tool({ status: "next", summary: "p1" });
		expect(h.sent[0].msg.content).toContain("## Loop — Pass 2 of 3");

		await h.tool({ status: "next", summary: "p2" });
		expect(h.sent[1].msg.content).toContain("## Loop — Pass 3 of 3");

		const r = await h.tool({ status: "next", summary: "p3" });
		expect(r.content[0].text).toContain("all 3 iterations done");
		// no fourth pass is ever steered
		expect(h.sent).toHaveLength(2);
		expect(h.sentUser).toHaveLength(1);
	});

	it("/loop 1 completes on the first next", async () => {
		const h = harness();
		await h.commands.get("loop")!.handler("1 once", h.ctx);
		const r = await h.tool({ status: "next", summary: "done" });
		expect(r.content[0].text).toContain("all 1 iterations done");
		expect(h.sent).toHaveLength(0);
	});

	it("done before the final pass still completes the loop", async () => {
		const h = harness();
		await h.commands.get("loop")!.handler("4 task", h.ctx);
		const r = await h.tool({ status: "done", summary: "finished early" });
		expect(r.content[0].text).toContain("Loop complete after 1 iteration(s)");
		expect(h.sent).toHaveLength(0);
	});
});

describe("cross-surface consistency", () => {
	it("keeps widget, steer prompt, and tool result in lockstep", async () => {
		const h = harness();
		await h.commands.get("loop")!.handler("2 render", h.ctx);
		await h.tool({ status: "next", summary: "s" });

		// widget now shows pass 2/2 (the pass now running)
		const lastWidget = h.ui.setWidget.mock.calls.at(-1)!;
		expect(lastWidget[1]).toEqual(["pass 2/2 · render", "Ctrl+Shift+X to stop"]);
		expect(h.sent[0].msg.content).toContain("## Loop — Pass 2 of 2");
	});

	it("goal-mode states survive a JSON round trip (no Infinity sentinel)", async () => {
		const h = harness();
		await h.commands.get("loop")!.handler("goal stable", h.ctx);
		const r = await h.tool({ status: "next", summary: "s" });
		// details already carry maxSteps: null (JSON-safe) rather than
		// Infinity, and the round trip is lossless
		expect(r.details?.maxSteps).toBeNull();
		expect(JSON.parse(JSON.stringify(r.details))).toEqual(r.details);
	});
});
