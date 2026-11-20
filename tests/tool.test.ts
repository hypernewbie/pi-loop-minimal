import { describe, expect, it } from "vitest";
import {
	getLoopApproveToolDefinition,
	getLoopDoneToolDefinition,
	getLoopNextToolDefinition,
	handleLoopApproveTool,
	handleLoopDoneTool,
	handleLoopNextTool,
	renderLoopApproveCall,
	renderLoopApproveResult,
	renderLoopDoneCall,
	renderLoopDoneResult,
	renderLoopNextCall,
} from "../src/tool.ts";
import type { LoopState } from "../src/state.ts";
import { claimingState, countState, foreverState, goalState } from "./helpers.ts";

describe("handleLoopDoneTool — no active loop", () => {
	it("returns a no-op result without touching state", () => {
		const state: LoopState = {
			active: false,
			currentStep: 0,
			maxSteps: null,
			goal: "",
			done: false,
			reasonDone: "",
			forever: false,
			evaluating: false,
			claimReason: "",
		};
		const r = handleLoopDoneTool({ reason: "x" }, state);
		expect(r.content[0].text).toBe("No active loop. Start one with /loop.");
		expect(r.details).toBeUndefined();
		expect(r.newState).toBe(state);
	});
});

describe("handleLoopDoneTool — claiming completion", () => {
	it("records the claim instead of closing the loop", () => {
		const r = handleLoopDoneTool({ reason: "all green" }, goalState(2));
		expect(r.newState.active).toBe(true);
		expect(r.newState.done).toBe(false);
		expect(r.newState.evaluating).toBe(true);
		expect(r.newState.claimReason).toBe("all green");
		expect(r.content[0].text).toContain("confirmed in the next turn");
		expect(r.details).toMatchObject({ evaluating: true });
	});

	it("trims the claim", () => {
		const r = handleLoopDoneTool({ reason: "  all green  " }, goalState(0));
		expect(r.newState.claimReason).toBe("all green");
	});

	it("rejects a claim without a justification and changes nothing", () => {
		const before = goalState(1);
		const r = handleLoopDoneTool({}, before);
		expect(r.newState).toBe(before);
		expect(r.details).toBeUndefined();
		expect(r.content[0].text).toContain("needs a reason");
		expect(r.content[0].text).toContain("still active");
	});

	it("rejects a blank justification and changes nothing", () => {
		const before = goalState(1);
		const r = handleLoopDoneTool({ reason: "   " }, before);
		expect(r.newState).toBe(before);
		expect(r.details).toBeUndefined();
	});

	it("ignores a second claim while one is being checked", () => {
		const before = claimingState(1);
		const r = handleLoopDoneTool({ reason: "really done" }, before);
		expect(r.newState).toBe(before);
		expect(r.details).toBeUndefined();
		expect(r.content[0].text).toContain("already being checked");
	});

	it("never advances the loop — that is the extension's job", () => {
		const r = handleLoopDoneTool({ reason: "just because" }, goalState(0));
		expect(r.newState.currentStep).toBe(0);
		expect(r.newState.active).toBe(true);
	});
});

describe("handleLoopNextTool — advancing an iteration", () => {
	it("advances to the next iteration", () => {
		const r = handleLoopNextTool({ summary: "did a pass" }, countState(2, 5));
		expect(r.newState.currentStep).toBe(3);
		expect(r.newState.active).toBe(true);
		expect(r.content[0].text).toContain("Continuing to iteration 4");
		expect(r.content[0].text).toContain("did a pass");
		expect(r.details).toMatchObject({ currentStep: 3 });
	});

	it("works without a summary", () => {
		const r = handleLoopNextTool({}, countState(0, 5));
		expect(r.newState.currentStep).toBe(1);
		expect(r.content[0].text).toContain("Continuing to iteration 2");
	});

	it("refuses to advance a goal loop", () => {
		const before = goalState(2);
		const r = handleLoopNextTool({ summary: "skipping ahead" }, before);
		expect(r.newState).toBe(before);
		expect(r.details).toBeUndefined();
		expect(r.content[0].text).toContain("only available in a count loop");
	});

	it("closes a count loop when the cap is reached", () => {
		const r = handleLoopNextTool({ summary: "final" }, countState(2, 3));
		expect(r.newState.active).toBe(false);
		expect(r.newState.done).toBe(true);
		expect(r.newState.reasonDone).toBe("Completed all passes");
		expect(r.content[0].text).toContain("all 3 passes done");
	});

	it("keeps a count loop open below the cap", () => {
		const r = handleLoopNextTool({ summary: "s" }, countState(0, 3));
		expect(r.newState.currentStep).toBe(1);
		expect(r.newState.active).toBe(true);
	});

	it("is a no-op when no loop is active", () => {
		const before = goalState(0);
		const r = handleLoopNextTool({ summary: "s" }, { ...before, active: false });
		expect(r.content[0].text).toBe("No active loop. Start one with /loop.");
		expect(r.details).toBeUndefined();
	});

	it("is a no-op for a forever loop", () => {
		const before = foreverState(5);
		const r = handleLoopNextTool({ summary: "s" }, before);
		expect(r.newState).toBe(before);
		expect(r.content[0].text).toBe(
			"loop_next is unavailable during a forever loop.",
		);
	});

	it("is a no-op while a claim is being checked", () => {
		const before = { ...claimingState(1), maxSteps: 3 };
		const r = handleLoopNextTool({ summary: "s" }, before);
		expect(r.newState).toBe(before);
		expect(r.content[0].text).toContain("claim is being checked");
	});
});

describe("handleLoopDoneTool — forever loops", () => {
	it("does not let a stale call change state", () => {
		const before = foreverState(5);
		const r = handleLoopDoneTool({ reason: "stale" }, before);
		expect(r.newState).toBe(before);
		expect(r.details).toBeUndefined();
		expect(r.content[0].text).toBe(
			"loop_done is unavailable during a forever loop.",
		);
	});
});

describe("handleLoopApproveTool — confirming a claim", () => {
	it("closes the loop when the goal is reached", () => {
		const r = handleLoopApproveTool(
			{ verdict: "reached", reason: "verified: tests pass" },
			claimingState(2),
		);
		expect(r.newState.done).toBe(true);
		expect(r.newState.active).toBe(false);
		expect(r.newState.evaluating).toBe(false);
		expect(r.newState.reasonDone).toBe("verified: tests pass");
		expect(r.content[0].text).toContain("Loop complete after 3 iteration(s)");
		expect(r.content[0].text).toContain("verified: tests pass");
		expect(r.details).toMatchObject({ active: false, done: true });
	});

	it("falls back to the claim when no reason is given", () => {
		const r = handleLoopApproveTool({ verdict: "reached" }, claimingState(0));
		expect(r.newState.reasonDone).toBe("all tests are green");
	});

	it("keeps the loop open when the goal is not reached", () => {
		const r = handleLoopApproveTool(
			{ verdict: "not_reached", reason: "the build fails" },
			claimingState(2),
		);
		expect(r.newState.active).toBe(true);
		expect(r.newState.done).toBe(false);
		expect(r.newState.evaluating).toBe(false);
		expect(r.content[0].text).toContain("Not confirmed");
		expect(r.content[0].text).toContain("keep working");
		expect(r.details).toMatchObject({ active: true, evaluating: false });
	});

	it("keeps the loop open when no verdict is given at all", () => {
		const r = handleLoopApproveTool({}, claimingState(0));
		expect(r.newState.active).toBe(true);
		expect(r.newState.evaluating).toBe(false);
	});

	it("keeps the loop open when the model claims the goal is unreachable", () => {
		const r = handleLoopApproveTool(
			{ verdict: "not_reached", reason: "impossible to reach" },
			claimingState(0),
		);
		expect(r.newState.active).toBe(true);
		expect(r.newState.done).toBe(false);
	});

	it("is a no-op when there is no claim to check", () => {
		const before = goalState(0);
		const r = handleLoopApproveTool({ verdict: "reached", reason: "x" }, before);
		expect(r.newState).toBe(before);
		expect(r.details).toBeUndefined();
		expect(r.content[0].text).toContain("only available while a completion claim");
	});

	it("is a no-op when no loop is active", () => {
		const before: LoopState = {
			active: false,
			currentStep: 0,
			maxSteps: null,
			goal: "",
			done: false,
			reasonDone: "",
			forever: false,
			evaluating: false,
			claimReason: "",
		};
		const r = handleLoopApproveTool({ verdict: "reached" }, before);
		expect(r.newState).toBe(before);
		expect(r.content[0].text).toBe("No active loop. Start one with /loop.");
	});
});

describe("tool definitions", () => {
	it("registers three distinct tools", () => {
		expect(getLoopDoneToolDefinition().name).toBe("loop_done");
		expect(getLoopApproveToolDefinition().name).toBe("loop_approve");
		expect(getLoopNextToolDefinition().name).toBe("loop_next");
		expect(getLoopDoneToolDefinition().label).toBe("Loop Done");
		expect(getLoopApproveToolDefinition().label).toBe("Loop Approve");
		expect(getLoopNextToolDefinition().label).toBe("Loop Next");
	});

	it("gives loop_next an optional summary and nothing else", () => {
		const def = getLoopNextToolDefinition();
		expect(Object.keys(def.parameters.properties)).toEqual(["summary"]);
		expect(def.parameters.required ?? []).toEqual([]);
	});

	it("offers no advance action on the claim and verdict tools", () => {
		// loop_next is the advance tool, so only the other two are checked
		for (const def of [
			getLoopDoneToolDefinition(),
			getLoopApproveToolDefinition(),
		]) {
			const description = def.description.toLowerCase();
			expect(description).not.toContain("next");
			expect(description).not.toContain("advance");
			expect(description).not.toContain("status");
		}
	});

	it("makes loop_done take a reason and nothing else", () => {
		const def = getLoopDoneToolDefinition();
		expect(Object.keys(def.parameters.properties)).toEqual(["reason"]);
		expect(def.parameters.required).toEqual(["reason"]);
	});

	it("makes loop_approve take a verdict and a reason", () => {
		const def = getLoopApproveToolDefinition();
		expect(Object.keys(def.parameters.properties).sort()).toEqual([
			"reason",
			"verdict",
		]);
		expect(def.parameters.required?.sort()).toEqual(["reason", "verdict"]);
	});

	it("folds a legacy done call into the current shape", () => {
		const def = getLoopDoneToolDefinition();
		const fold = def.prepareArguments as (args: unknown) => { reason: string };
		expect(fold({ status: "done", summary: "shipped it" })).toEqual({
			reason: "shipped it",
		});
		expect(fold({ status: "done", reason: "because" })).toEqual({
			reason: "because",
		});
		expect(fold({ status: "done" })).toEqual({ reason: "Goal met" });
	});

	it("folds a legacy next call into a call the tool rejects", () => {
		const def = getLoopDoneToolDefinition();
		const fold = def.prepareArguments as (args: unknown) => { reason: string };
		expect(fold({ status: "next", summary: "keep going" })).toEqual({
			reason: "",
		});
	});
});

describe("renderers", () => {
	const theme = {
		fg: (k: string, s: string) => `<${k}>${s}</${k}>`,
		bold: (s: string) => `**${s}**`,
	};

	it("renders the advance call", () => {
		const r = renderLoopNextCall({ summary: "polished the docs" }, theme);
		expect(r.render(200)[0].startsWith(
			"<toolTitle>**loop_next **</toolTitle><accent>polished the docs</accent>",
		)).toBe(true);
	});

	it("renders the claim call", () => {
		const r = renderLoopDoneCall({ reason: "goal met" }, theme);
		expect(r.render(200)[0].startsWith(
			"<toolTitle>**loop_done **</toolTitle><accent>goal met</accent>",
		)).toBe(true);
	});

	it("renders the verdict call", () => {
		const reached = renderLoopApproveCall({ verdict: "reached" }, theme);
		expect(reached.render(200)[0].startsWith(
			"<toolTitle>**loop_approve **</toolTitle><success>reached</success>",
		)).toBe(true);
		const notReached = renderLoopApproveCall({ verdict: "not_reached" }, theme);
		expect(notReached.render(200)[0].startsWith(
			"<toolTitle>**loop_approve **</toolTitle><warning>not_reached</warning>",
		)).toBe(true);
	});

	it("renders a completion result", () => {
		const r = renderLoopDoneResult(
			{ details: { ...goalState(2), done: true, active: false } },
			{},
			theme,
		);
		expect(r.render(200)[0].startsWith("<success>✓ loop complete</success>")).toBe(
			true,
		);
	});

	it("renders a pending check", () => {
		const r = renderLoopDoneResult({ details: claimingState(1) }, {}, theme);
		expect(r.render(200)[0].startsWith("<accent>→ checking</accent>")).toBe(true);
	});

	it("renders an open loop after a rejection", () => {
		const r = renderLoopApproveResult(
			{ details: { ...claimingState(1), evaluating: false } },
			{},
			theme,
		);
		expect(r.render(200)[0].startsWith("<warning>→ loop still open</warning>")).toBe(
			true,
		);
	});

	it("keeps legacy forever result rendering for old session history", () => {
		const r = renderLoopDoneResult(
			{ details: { ...foreverState(3), currentStep: 3 } },
			{},
			theme,
		);
		expect(r.render(200)[0]).toContain("iter 3 · forever");
	});
});
