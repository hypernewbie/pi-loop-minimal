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
		forever: false,
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
		forever: false,
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

/** Endless loop state. */
export function foreverState(step = 0): LoopState {
	return { ...goalState(step), goal: "watch the build", forever: true };
}
