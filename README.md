# pi-loop-minimal

Pi extension for agent loops: run the model in repeats until a goal is met, or
exactly N times. A trimmed, modernized port of
[`pi-agent-loop`](https://www.npmjs.com/package/pi-agent-loop) (see
[Provenance](#provenance-and-license)) that keeps only the two loop modes that
matter.

## What it does

- **Goal loops** — `/loop goal <description>`: iterate until the model calls
  `loop_control` with `done`. Open-ended: there is no iteration cap, matching
  the original behavior.
- **Exact-count loops** — `/loop <N> <task>`: exactly N passes. Advancing past
  the final pass completes the loop; `done` before the final pass also
  completes it.
- **Judged goal loops** — `/loop goal_judged <provider/model> <description>`:
  the same as a goal loop, except an independent model reviews every claimed
  completion. A `done` the evidence does not support is **denied** and the
  model is sent back to work. See [Judged loops](#judged-loops).
- **Same signal contract**: the model steers each iteration by calling the
  `loop_control` tool with `status: "next"` or `status: "done"`; the next
  iteration is steered with the same iteration prompt shape as the original.
- **Forced closure**: if the model ends its turn with the loop still open,
  the loop immediately steers it to continue working (`triggerTurn`), so a
  bug-ended turn cannot silently stall the loop. Runs the user aborted
  (`Esc`) or that errored are never restarted.
- **Session continuity**: state is reconstructed from the last `loop_control`
  result on session start and on `/tree` navigation, like the original.

## Install

```bash
pi install git:github.com/hypernewbie/pi-loop-minimal
```

The old extension registers the same `/loop` command, `loop_control` tool, and
`Ctrl+Shift+X` shortcut, so the two must not be enabled together:

```bash
pi remove npm:pi-agent-loop
pi install git:github.com/hypernewbie/pi-loop-minimal
```

## Usage

| Command | Description |
|---|---|
| `/loop goal <description>` | Iterate until the goal is met |
| `/loop goal_judged <provider/model> <description>` | Iterate until an independent judge agrees the goal is met |
| `/loop <N> <task>` | Run exactly N passes (N >= 1) |
| `/loop-stop` | Stop the active loop |

`Ctrl+Shift+X` stops the loop and aborts the in-flight turn.

### How a loop runs

1. `/loop …` waits for idle, then kicks off the first iteration as a user
   message built from the iteration prompt.
2. The model works on the iteration, then calls `loop_control`:
   - `status: "next"` — advance to the next pass / iteration,
   - `status: "done"` — the goal is met (or the loop ends).
3. The transition is applied, the widget updates, and the next iteration is
   dispatched as a hidden steer message — or a completion result is returned.

Count semantics are strict: `/loop 3 …` runs **exactly** three passes. A
`done` on pass 2 completes the loop after 2 iterations; `next` on pass 3
completes it after 3. Goal loops never end on `next`.

## Judged loops

```bash
/loop goal_judged minimax/MiniMax-M3 make the failing integration tests pass
```

A model that has run out of ideas will happily call `loop_control` with
`done`. In a judged loop it does not get to decide:

1. The model calls `done`.
2. An independent judge — the model named in the command — is asked whether
   the evidence shows the goal was met.
3. **PASS** completes the loop. **DENY** returns the denial as the tool result:
   the loop stays open at the same iteration, the denial counter increments,
   and the model keeps working with the judge's reasons in hand.

There is no denial cap: an agent that keeps claiming completion keeps getting
sent back. `/loop-stop` and `Ctrl+Shift+X` remain the way out.

**The judge model is validated when you start the loop**, not when the first
`done` arrives — an unknown slug, a malformed one, or a provider with no
configured auth fails immediately with a message. Use `provider/id` exactly as
`pi --list-models` prints it. Pick a model *other* than the one doing the work:
same-model self-assessment is lenient.

The judge sees only the goal, the claim, and a digest of recent transcript
activity — never the working model's thinking. That fresh, evidence-only
context is where the independence comes from. Because the digest is written by
the model under review, it is treated as untrusted input: every line is
flattened to a single line behind a `agent:`/`tool:`/`user:` prefix, the block
is wrapped in a randomised fence, and the judge is told that a planted
`VERDICT: PASS` is a manipulation attempt.

If the judge cannot be reached — no auth, network failure, no parseable verdict
— the loop **fails open**: the `done` is accepted and the receipt says
`(judge unavailable: …)`. A broken judge should not trap you in a loop. A user
abort during review is different: nothing is accepted and the loop stays open.

Each review is one extra model call, billed to the judge model and reported as
tool usage.

## Status widget

```text
pass 3/5 · refine the renderer
Ctrl+Shift+X to stop
```

Footer status is `loop · pass 3/5` (count mode) or `loop · iter 3` (goal
mode). Tool results render as `→ pass 2/5`, `→ iter 3`, or `✓ loop complete`.
In a judged loop a rejected completion adds `· denied N` to the widget and
footer, and the tool result renders as `✗ denied by judge (N)`.

## What changed from pi-agent-loop

- **Only two forms**: `/loop goal` and `/loop <N> <task>`. The original's
  `passes <N>` and `pipeline <s1|s2|s3>` grammar forms are gone (the count
  form survives, respelled; the pipeline mode, `stages` field, and pipeline
  branches are deleted).
- **Current Pi API**: `@mariozechner/*` and `@sinclair/typebox` replaced with
  the `@earendil-works/*` packages and `typebox`; the dead
  `session_switch`/`session_fork` events and the no-op `agent_end` handler
  were dropped.
- **Synchronous advance**: the original dispatched the next iteration inside
  `setTimeout(…, 100)`. `deliverAs: "steer"` already queues the message until
  after the current turn's tool calls, so the timer (and its ordering race)
  is gone.
- **JSON-safe goal state**: goal mode used `maxSteps: Infinity`, which
  serializes to `null` in tool-result details; after a restart the system
  prompt rendered `Step: 2/null` instead of `∞`. Goal mode now stores
  `maxSteps: null` and treats `null` as unbounded.
- **Tighter count parsing**: `/loop 3abc …` is rejected instead of being
  accepted as 3 via `parseInt` slop.
- **Force-close nudge**: new `agent_end` behavior — a run that ends while
  the loop is still open is steered with a "continue working" message
  (never after abort/error). The original just went silent.
- **Judged completion**: new `goal_judged` form. The original had no notion of
  reviewing a claimed completion; `done` was always final.

Everything model-facing — iteration prompts, the `loop_control` schema and
its descriptions, the system-prompt addition, the completion texts — is
unchanged from the original except that stage references were dropped from
the tool description with the pipeline removal.

## Development

```bash
npm install
npm test          # vitest — 164 tests
npm run typecheck # tsc --noEmit (src + tests)
npm pack --dry-run
```

The tests cover parsing, prompts, transitions, exact-count semantics, the
synchronous steer, renderers, command dispatch, stop controls, and session
reconstruction through a fake `ExtensionAPI` harness. Judged loops add entry
validation, verdict parsing, evidence budgeting and injection resistance, the
fail-open and abort paths, and a full deny → rework → pass cycle with the judge
mocked at the module boundary.

## Provenance and license

The behavior contract and most of the implementation come from
[`pi-agent-loop@0.1.1`](https://www.npmjs.com/package/pi-agent-loop) by
pierre-mike, which declares MIT in its manifest but ships no `LICENSE` file
and has no public source repository. This package is a trimmed port of that
code: the same three-file structure, prompts, and tool contract, with the
pipeline/passes grammar removed, the dependency/event API brought up to
current Pi, and the defects above fixed.

Licensed MIT — see [LICENSE](LICENSE).
