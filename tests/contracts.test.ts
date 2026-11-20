// contracts.test.ts — the invariants that must never break.
//
// Every test in this file asserts one rule from a different angle, so a
// future change cannot satisfy one assertion while quietly breaking the
// rule. Each test carries the comment:
//
//     CONTRACT: <the rule>. Never remove this test.
//
// The rule under test: **a goal loop has exactly one model-facing verb — the
// completion claim. The model never advances a goal loop itself.** The
// extension owns iteration boundaries there. `loop_next` (the advance tool)
// exists for count loops only.
//
// This shipped broken once (v0.9.0): the advance tool was exposed in every
// mode, which re-opened the exact hole v0.6.0 had closed. These tests exist
// so that can never happen again.

import { describe, expect, it } from "vitest";
import {
	buildNudgePrompt,
	buildPrompt,
	getSystemPromptAddition,
} from "../src/state.ts";
import { goalState } from "./helpers.ts";
import {
	createHarness,
	execApprove,
	execNext,
	execTool,
	iterations,
	loopCmd,
	nudges,
	turnEnd,
} from "./harness.ts";

const ADVANCE_TOOL = "loop_next";

/** The loop tools visible in the given active-tool list. */
const loopTools = (tools: string[]) =>
	tools.filter((name) => name.startsWith("loop_"));

describe("contract: a goal loop exposes no advance tool", () => {
	// CONTRACT: a goal loop must never expose an advance tool to the model.
	// Never remove this test.
	it("keeps loop_next out of the active tool list", async () => {
		const h = createHarness();
		await loopCmd(h).handler("goal ship it", h.ctx);
		expect(h.activeTools()).not.toContain(ADVANCE_TOOL);
	});

	// CONTRACT: a goal loop must never expose an advance tool to the model.
	// Never remove this test.
	it("exposes loop_done as the only loop tool", async () => {
		const h = createHarness();
		await loopCmd(h).handler("goal ship it", h.ctx);
		expect(loopTools(h.activeTools())).toEqual(["loop_done"]);
	});

	// CONTRACT: a goal loop must never expose an advance tool to the model.
	// Never remove this test.
	it("keeps it out of the list for the whole life of the loop", async () => {
		const h = createHarness();
		await loopCmd(h).handler("goal ship it", h.ctx);
		expect(h.activeTools()).not.toContain(ADVANCE_TOOL);
		await turnEnd(h);
		expect(h.activeTools()).not.toContain(ADVANCE_TOOL);
		await execTool(h, { reason: "claiming" });
		expect(h.activeTools()).not.toContain(ADVANCE_TOOL);
		await execApprove(h, { verdict: "not_reached", reason: "not yet" });
		expect(h.activeTools()).not.toContain(ADVANCE_TOOL);
		await turnEnd(h);
		expect(h.activeTools()).not.toContain(ADVANCE_TOOL);
	});

	// CONTRACT: a goal loop must never expose an advance tool to the model.
	// Never remove this test.
	it("keeps it out of the list after the loop is restored", async () => {
		const h = createHarness();
		h.branch.push({
			type: "custom",
			customType: "loop-state",
			data: {
				active: true,
				currentStep: 2,
				maxSteps: null,
				goal: "restored",
				done: false,
				reasonDone: "",
				forever: false,
				evaluating: false,
				claimReason: "",
			},
		});
		await h.handlers.get("session_start")!({}, h.ctx);
		expect(h.activeTools()).not.toContain(ADVANCE_TOOL);
	});

	// CONTRACT: a forever loop must never expose an advance tool to the model.
	// Never remove this test.
	it("keeps it out of the list for a forever loop", async () => {
		const h = createHarness();
		await loopCmd(h).handler("forever keep going", h.ctx);
		expect(h.activeTools()).not.toContain(ADVANCE_TOOL);
	});
});

describe("contract: the model cannot advance a goal loop", () => {
	// CONTRACT: the model must never be able to advance a goal loop itself.
	// Never remove this test.
	it("blocks an advance call in a goal loop", async () => {
		const h = createHarness();
		await loopCmd(h).handler("goal ship it", h.ctx);
		const blocked = h.handlers.get("tool_call")!(
			{ toolName: ADVANCE_TOOL },
			h.ctx,
		);
		expect(blocked).toMatchObject({ block: true });
	});

	// CONTRACT: the model must never be able to advance a goal loop itself.
	// Never remove this test.
	it("changes no state when an advance call slips through the gate", async () => {
		const h = createHarness();
		await loopCmd(h).handler("goal ship it", h.ctx);
		const before = h.ui.setStatus.mock.calls.length;
		const r = await execNext(h, { summary: "skipping ahead" });
		expect(r.details).toBeUndefined();
		// the loop did not move
		expect(h.ui.setStatus.mock.calls.length).toBe(before);
		expect(h.ui.setStatus).toHaveBeenLastCalledWith("loop", "loop · iter 1");
	});

	// CONTRACT: the model must never be able to advance a goal loop itself.
	// Never remove this test.
	it("does not dispatch an iteration for an advance call in a goal loop", async () => {
		const h = createHarness();
		await loopCmd(h).handler("goal ship it", h.ctx);
		await execNext(h, { summary: "skipping ahead" });
		expect(iterations(h)).toHaveLength(0);
	});

	// CONTRACT: the model must never be able to advance a goal loop itself.
	// Never remove this test.
	it("counts exactly one iteration per turn end", async () => {
		const h = createHarness();
		await loopCmd(h).handler("goal ship it", h.ctx);
		expect(h.ui.setStatus).toHaveBeenLastCalledWith("loop", "loop · iter 1");
		await turnEnd(h);
		expect(h.ui.setStatus).toHaveBeenLastCalledWith("loop", "loop · iter 2");
		await turnEnd(h);
		expect(h.ui.setStatus).toHaveBeenLastCalledWith("loop", "loop · iter 3");
	});

	// CONTRACT: the model must never be able to advance a goal loop itself.
	// Never remove this test.
	it("does not move the counter when the model claims completion", async () => {
		const h = createHarness();
		await loopCmd(h).handler("goal ship it", h.ctx);
		await execTool(h, { reason: "claiming" });
		await execApprove(h, { verdict: "not_reached", reason: "not yet" });
		expect(h.ui.setStatus).toHaveBeenLastCalledWith("loop", "loop · iter 1");
	});

	// CONTRACT: the model must never be able to advance a goal loop itself.
	// Never remove this test.
	it("keeps the goal loop open no matter how often the model tries", async () => {
		const h = createHarness();
		await loopCmd(h).handler("goal ship it", h.ctx);
		for (let i = 0; i < 10; i++) {
			await execNext(h, { summary: `attempt ${i}` });
		}
		expect(h.ui.setStatus).toHaveBeenLastCalledWith("loop", "loop · iter 1");
		expect(iterations(h)).toHaveLength(0);
	});
});

describe("contract: goal-loop prompts never advertise an advance tool", () => {
	// CONTRACT: a goal loop's model-facing text must never mention the
	// advance tool. Never remove this test.
	it("keeps it out of the iteration prompt", () => {
		expect(buildPrompt(goalState(2))).not.toContain(ADVANCE_TOOL);
	});

	// CONTRACT: a goal loop's model-facing text must never mention the
	// advance tool. Never remove this test.
	it("keeps it out of the system prompt addition", () => {
		expect(getSystemPromptAddition(goalState(2))).not.toContain(ADVANCE_TOOL);
	});

	// CONTRACT: a goal loop's model-facing text must never mention the
	// advance tool. Never remove this test.
	it("keeps it out of the continuation prompt", () => {
		expect(buildNudgePrompt(goalState(2))).not.toContain(ADVANCE_TOOL);
	});

	// CONTRACT: a goal loop's model-facing text must never mention the
	// advance tool. Never remove this test.
	it("keeps it out of every goal-loop prompt at once", () => {
		const all = [
			buildPrompt(goalState(0)),
			buildPrompt(goalState(7)),
			getSystemPromptAddition(goalState(0)),
			getSystemPromptAddition(goalState(7)),
			buildNudgePrompt(goalState(0)),
		].join("\n");
		expect(all).not.toContain(ADVANCE_TOOL);
	});
});

describe("contract: the advance tool belongs to count loops", () => {
	// CONTRACT: the advance tool must exist and be scoped to count loops.
	// Never remove this test.
	it("is exposed in a count loop", async () => {
		const h = createHarness();
		await loopCmd(h).handler("3 polish", h.ctx);
		expect(h.activeTools()).toContain(ADVANCE_TOOL);
		expect(loopTools(h.activeTools())).toContain(ADVANCE_TOOL);
	});

	// CONTRACT: the advance tool must exist and be scoped to count loops.
	// Never remove this test.
	it("is advertised by the count-loop prompts", () => {
		const h = createHarness();
		// the count prompt comes from the same builder as the goal prompt
		const count = buildPrompt({ ...goalState(0), maxSteps: 3 });
		expect(count).toContain(ADVANCE_TOOL);
		expect(getSystemPromptAddition({ ...goalState(0), maxSteps: 3 })).toContain(
			ADVANCE_TOOL,
		);
	});

	// CONTRACT: the advance tool must exist and be scoped to count loops.
	// Never remove this test.
	it("is registered by the extension even when it is not active", () => {
		const h = createHarness();
		expect(h.toolDefs.map((t) => t.name)).toContain(ADVANCE_TOOL);
	});

	// CONTRACT: the advance tool must exist and be scoped to count loops.
	// Never remove this test.
	it("is not exposed while a count loop checks a claim", async () => {
		const h = createHarness();
		await loopCmd(h).handler("3 polish", h.ctx);
		await execTool(h, { reason: "claiming" });
		expect(h.activeTools()).not.toContain(ADVANCE_TOOL);
	});

	// CONTRACT: the advance tool must exist and be scoped to count loops.
	// Never remove this test.
	it("keeps a count loop's pass counter honest", async () => {
		const h = createHarness();
		await loopCmd(h).handler("2 polish", h.ctx);
		await execNext(h, { summary: "pass one" });
		await turnEnd(h);
		await turnEnd(h);
		const done = h.sentMessages.find((m) => m.msg.customType === "loop-complete");
		expect(done?.msg.content).toContain("all 2 passes done");
	});
});
