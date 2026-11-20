// harness.ts — a fake ExtensionAPI harness shared by the test suites.
//
// The extension is driven exactly like a live session: commands, tool calls,
// turn ends, and the active-tool list are all observable.

import { vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";
import type { LoopState } from "../src/state.ts";

export type ToolParams = { reason?: string; verdict?: string; summary?: string };
export type ToolResult = { content: { type: "text"; text: string }[]; details?: LoopState };
export type CommandCtx = ExtensionContext & { waitForIdle(): Promise<void> };
export type CommandDef = {
	handler: (args: string, ctx: CommandCtx) => Promise<void>;
	getArgumentCompletions?: (prefix: string) => unknown[] | null;
};
export type ShortcutDef = { handler: (ctx: ExtensionContext) => Promise<void> };
export type ToolDef = {
	name: string;
	execute: (
		id: string,
		params: ToolParams,
		signal: unknown,
		onUpdate: unknown,
		ctx: CommandCtx,
	) => Promise<ToolResult>;
};

export type BranchEntry = {
	type: string;
	customType?: string;
	data?: unknown;
	message?: { role: string; toolName?: string; details?: unknown };
};

export function createHarness() {
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

export type Harness = ReturnType<typeof createHarness>;

export const loopCmd = (h: Harness) => h.commands.get("loop")!;
export const stopCmd = (h: Harness) => h.commands.get("loop-stop")!;
export const shortcut = (h: Harness) => h.shortcuts.get("ctrl+shift+x")!;

export async function execTool(h: Harness, params: ToolParams): Promise<ToolResult> {
	return doneTool(h).execute("call-1", params, undefined, undefined, h.ctx);
}

export async function execApprove(h: Harness, params: ToolParams): Promise<ToolResult> {
	return approveTool(h).execute("call-2", params, undefined, undefined, h.ctx);
}

export async function execNext(h: Harness, params: ToolParams): Promise<ToolResult> {
	return nextTool(h).execute("call-3", params, undefined, undefined, h.ctx);
}

/** A normal turn end: the model finished and stopped. */
export async function turnEnd(
	h: Harness,
	stopReason = "stop",
): Promise<void> {
	await h.handlers.get("agent_end")!(
		{ messages: [{ role: "assistant", stopReason }] },
		h.ctx,
	);
}

export const doneTool = (h: Harness) => h.toolDefs.find((t) => t.name === "loop_done")!;
export const nextTool = (h: Harness) => h.toolDefs.find((t) => t.name === "loop_next")!;
export const approveTool = (h: Harness) =>
	h.toolDefs.find((t) => t.name === "loop_approve")!;

export const evaluations = (h: Harness) =>
	h.sentMessages.filter((m) => m.msg.customType === "loop-evaluate");
export const resumes = (h: Harness) =>
	h.sentMessages.filter((m) => m.msg.customType === "loop-resume");

export const iterations = (h: Harness) =>
	h.sentMessages.filter((m) => m.msg.customType === "loop-iteration");
export const nudges = (h: Harness) =>
	h.sentMessages.filter((m) => m.msg.customType === "loop-nudge");
export const completions = (h: Harness) =>
	h.sentMessages.filter((m) => m.msg.customType === "loop-complete");
