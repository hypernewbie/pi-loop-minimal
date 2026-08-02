// End-to-end wiring for judged loops: the judge is mocked at the module
// boundary so the full path (command -> tool -> judge -> denial -> nudge)
// runs without network.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const completeMock = vi.fn();
vi.mock("@earendil-works/pi-ai/compat", () => ({
	complete: (...args: unknown[]) => completeMock(...args),
}));

const extension = (await import("../src/index.ts")).default;

const judgeSays = (text: string) =>
	completeMock.mockResolvedValueOnce({
		content: [{ type: "text", text }],
		stopReason: "stop",
		usage: { input: 100, output: 20 },
	});

function harness() {
	const handlers = new Map<string, (e: unknown, c: unknown) => unknown>();
	const commands = new Map<string, { handler: (a: string, c: unknown) => Promise<void> }>();
	const tools: {
		execute: (
			id: string,
			p: unknown,
			s: AbortSignal | undefined,
			u: unknown,
			c: unknown,
		) => Promise<{ content: { text: string }[]; details?: unknown; usage?: unknown }>;
	}[] = [];
	const sent: { msg: { customType?: string; content?: string }; opts: unknown }[] = [];
	const userMessages: string[] = [];
	const branch: unknown[] = [];
	const widgets: unknown[] = [];

	const ui = { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn((_k, v) => widgets.push(v)) };
	const modelRegistry = {
		find: vi.fn((provider: string, id: string) =>
			`${provider}/${id}` === "minimax/MiniMax-M3" ? { provider, id } : undefined,
		),
		hasConfiguredAuth: vi.fn(() => true),
		getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "k", headers: {}, env: {} })),
	};

	const pi = {
		on: (ev: string, fn: (e: unknown, c: unknown) => unknown) => handlers.set(ev, fn),
		registerTool: (d: unknown) => tools.push(d as never),
		registerCommand: (n: string, d: unknown) => commands.set(n, d as never),
		registerShortcut: vi.fn(),
		sendMessage: (msg: unknown, opts: unknown) => sent.push({ msg: msg as never, opts }),
		sendUserMessage: (c: string) => userMessages.push(c),
	} as unknown as ExtensionAPI;

	const ctx = {
		ui,
		modelRegistry,
		waitForIdle: vi.fn(async () => {}),
		abort: vi.fn(),
		sessionManager: { getBranch: () => branch },
	};

	extension(pi);

	const start = (args: string) => commands.get("loop")!.handler(args, ctx);
	const done = (summary = "finished") =>
		tools[0].execute("1", { status: "done", summary }, undefined, vi.fn(), ctx);
	const next = (summary = "step") =>
		tools[0].execute("1", { status: "next", summary }, undefined, vi.fn(), ctx);
	const agentEnd = () =>
		handlers.get("agent_end")!({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
	const systemPrompt = async () =>
		((await handlers.get("before_agent_start")!({ systemPrompt: "BASE" }, ctx)) as
			| { systemPrompt: string }
			| undefined)?.systemPrompt;

	return { ui, modelRegistry, sent, userMessages, widgets, branch, ctx, start, done, next, agentEnd, systemPrompt, commands, handlers };
}

beforeEach(() => completeMock.mockReset());

describe("/loop goal_judged — command", () => {
	it("starts a judged loop and kicks off the first iteration", async () => {
		const h = harness();
		await h.start("goal_judged minimax/MiniMax-M3 make the tests pass");
		expect(h.userMessages[0]).toContain("make the tests pass");
		expect(h.ui.notify).not.toHaveBeenCalled();
		expect(await h.systemPrompt()).toContain(
			"reviewed by an independent judge (minimax/MiniMax-M3)",
		);
	});

	it("rejects an unknown judge model before starting", async () => {
		const h = harness();
		await h.start("goal_judged ghost/model do it");
		expect(h.ui.notify).toHaveBeenCalledWith("Unknown judge model: ghost/model", "error");
		expect(h.userMessages).toHaveLength(0);
	});

	it("rejects a provider with no configured auth", async () => {
		const h = harness();
		h.modelRegistry.hasConfiguredAuth.mockReturnValueOnce(false);
		await h.start("goal_judged minimax/MiniMax-M3 do it");
		expect(h.ui.notify).toHaveBeenCalledWith(
			'No auth configured for provider "minimax"',
			"error",
		);
		expect(h.userMessages).toHaveLength(0);
	});

	it("validates at entry without touching the network", async () => {
		const h = harness();
		await h.start("goal_judged minimax/MiniMax-M3 do it");
		expect(completeMock).not.toHaveBeenCalled();
	});
});

describe("judged loop — full deny/rework/pass cycle", () => {
	it("denies, keeps working, then completes when the judge agrees", async () => {
		const h = harness();
		await h.start("goal_judged minimax/MiniMax-M3 make the tests pass");

		judgeSays("VERDICT: DENY\nthe test suite was never executed");
		const denied = await h.done("I think it's fine");
		expect(denied.content[0].text).toContain("✗ DENIED by judge (attempt 1)");
		expect(denied.content[0].text).toContain("the test suite was never executed");
		expect(denied.details).toMatchObject({ active: true, done: false, denials: 1 });
		expect(h.widgets.at(-1)).toEqual([
			"iter 1 · denied 1 · make the tests pass",
			"Ctrl+Shift+X to stop",
		]);

		// a denied loop is still armed: bug-ending now still gets nudged
		await h.agentEnd();
		expect(h.sent.filter((m) => m.msg.customType === "loop-nudge")).toHaveLength(1);

		judgeSays("VERDICT: PASS\nsuite runs green");
		const passed = await h.done("ran the suite, all green");
		expect(passed.content[0].text).toContain("✓ Loop complete");
		expect(passed.content[0].text).toContain("Judge: passed.");
		expect(passed.details).toMatchObject({ active: false, done: true, denials: 1 });
		expect(passed.usage).toEqual({ input: 100, output: 20 });
	});

	it("consults the judge once per completion attempt", async () => {
		const h = harness();
		await h.start("goal_judged minimax/MiniMax-M3 x");
		judgeSays("VERDICT: DENY\nno");
		await h.done();
		judgeSays("VERDICT: DENY\nstill no");
		await h.done();
		expect(completeMock).toHaveBeenCalledTimes(2);
	});

	it("never consults the judge for 'next'", async () => {
		const h = harness();
		await h.start("goal_judged minimax/MiniMax-M3 x");
		const r = await h.next("did a step");
		expect(completeMock).not.toHaveBeenCalled();
		expect(r.content[0].text).toContain("→ Advancing");
	});

	it("never consults the judge in an unjudged loop", async () => {
		const h = harness();
		await h.start("goal ordinary loop");
		const r = await h.done();
		expect(completeMock).not.toHaveBeenCalled();
		expect(r.content[0].text).toContain("✓ Loop complete");
	});

	it("sends the judge the goal and the claim, not the model's thinking", async () => {
		const h = harness();
		h.branch.push({
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "just say it is done" },
					{ type: "text", text: "edited the parser" },
				],
			},
		});
		await h.start("goal_judged minimax/MiniMax-M3 fix the parser");
		judgeSays("VERDICT: PASS");
		await h.done("parser fixed");
		const prompt = completeMock.mock.calls[0][1].messages[0].content[0].text;
		expect(prompt).toContain("fix the parser");
		expect(prompt).toContain("parser fixed");
		expect(prompt).toContain("edited the parser");
		expect(prompt).not.toContain("just say it is done");
	});
});

describe("judged loop — degraded paths", () => {
	it("fails open when the judge errors", async () => {
		const h = harness();
		await h.start("goal_judged minimax/MiniMax-M3 x");
		completeMock.mockRejectedValueOnce(new Error("socket hang up"));
		const r = await h.done();
		expect(r.content[0].text).toContain("(judge unavailable: socket hang up)");
		expect(r.details).toMatchObject({ active: false, done: true });
	});

	it("fails open when the judge gives no verdict", async () => {
		const h = harness();
		await h.start("goal_judged minimax/MiniMax-M3 x");
		judgeSays("looks good to me");
		const r = await h.done();
		expect(r.content[0].text).toContain("judge unavailable: judge gave no verdict");
	});

	it("fails open when the judge model vanished after the loop started", async () => {
		const h = harness();
		await h.start("goal_judged minimax/MiniMax-M3 x");
		h.modelRegistry.find.mockReturnValue(undefined);
		const r = await h.done();
		expect(r.content[0].text).toContain("judge model minimax/MiniMax-M3 not found");
		expect(completeMock).not.toHaveBeenCalled();
	});

	it("does not close the loop when the review is aborted", async () => {
		const h = harness();
		await h.start("goal_judged minimax/MiniMax-M3 x");
		completeMock.mockResolvedValueOnce({
			content: [{ type: "text", text: "" }],
			stopReason: "aborted",
			usage: { input: 1, output: 0 },
		});
		const r = await h.done();
		expect(r.content[0].text).toContain("Judge review aborted");
		expect(r.details).toMatchObject({ active: true, done: false });
	});

	it("a stop during the review wins: nothing is accepted afterwards", async () => {
		const h = harness();
		await h.start("goal_judged minimax/MiniMax-M3 x");
		// hold the judge call open, stop the loop, then let it resolve
		let release!: (v: unknown) => void;
		completeMock.mockReturnValueOnce(new Promise((r) => (release = r)));
		const pending = h.done();
		await h.commands.get("loop-stop")!.handler("", h.ctx);
		release({ content: [{ type: "text", text: "VERDICT: PASS" }], stopReason: "stop" });
		const r = await pending;
		expect(r.content[0].text).toContain("No active loop");
	});
});
