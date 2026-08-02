import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LoopState } from "../src/state.ts";
import { vi } from "vitest";

/** Narrow a parser result to LoopState, failing loudly on error strings. */
export function parseOk(s: LoopState | string): LoopState {
	if (typeof s === "string") throw new Error(`expected state, got: ${s}`);
	return s;
}

export function countState(step: number, max: number): LoopState {
	return {
		active: true,
		mode: "passes",
		currentStep: step,
		maxSteps: max,
		goal: "task",
		done: false,
		reasonDone: "",
		judgeModel: null,
		denials: 0,
	};
}

export function goalState(step = 0): LoopState {
	return {
		active: true,
		mode: "goal",
		currentStep: step,
		maxSteps: null,
		goal: "green tests",
		done: false,
		reasonDone: "",
		judgeModel: null,
		denials: 0,
	};
}

/** Goal state gated by a judge. */
export function judgedState(step = 0, denials = 0): LoopState {
	return {
		...goalState(step),
		judgeModel: "minimax/MiniMax-M3",
		denials,
	};
}

/** Fake ctx.modelRegistry slice for judge-slug validation. */
export function fakeRegistry(
	opts: { known?: string[]; unauthed?: string[] } = {},
) {
	const known = opts.known ?? ["minimax/MiniMax-M3", "m3/MiniMax-M3"];
	const unauthed = opts.unauthed ?? [];
	return {
		find: (provider: string, id: string) =>
			known.includes(`${provider}/${id}`)
				? ({ provider, id } as never)
				: undefined,
		hasConfiguredAuth: (m: { provider: string; id: string }) =>
			!unauthed.includes(`${m.provider}/${m.id}`),
	};
}

/** A minimal capture ui for widget tests. */
export function captureUi() {
	let status: string | undefined = undefined;
	let widget: unknown = undefined;
	const ctx = {
		ui: {
			setStatus: (_k: string, v: string | undefined) => (status = v),
			setWidget: (_k: string, v: unknown) => (widget = v),
		},
	} as unknown as ExtensionContext;
	return { ctx, get status() { return status; }, get widget() { return widget; } };
}

export { vi };
