# pi-loop-minimal

Pi extension for agent loops: run until a goal is met, or continuously until
you stop it. A trimmed, modernized port of
[`pi-agent-loop`](https://www.npmjs.com/package/pi-agent-loop) (see
[Provenance](#provenance-and-license)).

## What it does

- **Goal loops** — `/loop goal <description>`: iterate until the model *claims*
  the goal is met **and** a confirmation check agrees. Open-ended: there is no
  iteration cap, matching the original behavior.
- **Forever loops** — `/loop forever <task>`: the model does not receive
  `loop_done`; ending a turn starts another work turn until **you** stop it.
- **Two tools, one at a time**: `loop_done` (working) and `loop_approve`
  (confirmation). Exactly one is exposed, and only while a loop runs. The
  extension owns iteration boundaries — a turn that ends advances the loop.
  Forever loops get neither.
- **Turn-driven iterations**: when the model ends a turn with the loop still
  open, the loop steers the next iteration immediately (`triggerTurn`), so a
  turn can never silently stall the loop. Runs the user aborted (`Esc`) or that
  errored are never counted as an iteration.
- **Session continuity**: loop state, control results, and user stops are
  replayed on session start and `/tree` navigation.

## Install

```bash
pi install git:github.com/hypernewbie/pi-loop-minimal
```

The old extension registers the same `/loop` command and `Ctrl+Shift+X`
shortcut, so the two must not be enabled together:

```bash
pi remove npm:pi-agent-loop
pi install git:github.com/hypernewbie/pi-loop-minimal
```

## Usage

| Command | Description |
|---|---|
| `/loop goal <description>` | Iterate until the goal is met |
| `/loop forever <task>` | Iterate until you stop it; the model cannot end it |
| `/loop-stop` | Stop the active loop |

`Ctrl+Shift+X` stops the loop and aborts the in-flight turn.

### How a loop runs

1. `/loop …` waits for idle, then kicks off the first work turn as a user
   message built from the loop prompt.
2. The model works. In a goal loop `loop_done` is exposed and does exactly one
   thing: claim the goal is met, with a reason.
3. When the model ends its turn with the loop still open, the extension
   advances it — the next iteration is dispatched as a hidden steer message.
   In forever loops the same turn-end injects a continuation instead, because
   a forever loop has no iteration count.
4. A `loop_done` claim does **not** close the loop. It opens a confirmation
   phase: the next turn asks whether the goal has actually been reached, and
   only `loop_approve` is exposed then.

Goal loops are unbounded: they end when a claim is **confirmed**, or when the user
stops them. There is no count form — a pass had no meaning once the model
could no longer advance the loop itself.

## Forever loops

```bash
/loop forever keep hunting flaky tests
```

Forever mode removes `loop_done` from Pi's active tool list before the
first model request, so there is no `next`/`done` control for the model to
spam. When it ends a normal turn, the extension injects a hidden “continue
working” message. The widget/footer carry a `· forever` marker, not a made-up
iteration count.

Stopping is yours alone:

| Action | Effect on a forever loop |
|---|---|
| `/loop-stop` | Ends it |
| `Ctrl+Shift+X` | Ends it and aborts the in-flight turn |
| `Esc` | Aborts the current turn only — the loop stays armed and the next turn end resumes it |
| model tries `loop_done` | Blocked as a stale call; no state changes |

## Confirmation

A goal loop closes only when a claim survives a check.

```text
loop_done(reason: "all tests green")     # working phase: a claim
loop_approve(verdict, reason)            # check phase: the verdict
```

1. **Working phase.** Only `loop_done` is exposed. The model claims the goal
   is met.
2. **Check phase.** The next turn is prompted with *“Has the goal actually
   been reached? Judge it against the goal itself, not against the claim.”*
   Only `loop_approve` is exposed now — `loop_done` is taken out of the
   active-tool list.
3. **Verdict.**
   - `verdict: "reached"` → the loop closes and the reason is recorded.
   - `verdict: "not_reached"` → the claim is ignored and the work resumes.
   - No `loop_approve` call at all → the claim is ignored and the work
     resumes.

A rejected claim comes back as a work prompt, not as a verdict:

```text
## Loop — Iteration 4 (not confirmed)
Goal: all tests green
The loop is still open: the build fails
The claim was: all tests green
Keep working on the goal. If part of it looks unreachable, do what is
achievable and keep going — the loop only closes when a claim is confirmed.
```

That last line is the point: **a claim of impossibility is not an exit**. The
loop only closes on a confirmed claim, so a model that gives up on the goal
gets sent back to work instead of ending the run.

`loop_approve` takes an explicit `verdict` because a rejection spoken through
the tool (`reason: "impossible to reach"`) would otherwise read as an
approval — exactly the false completion this check exists to catch.

### Tool exposure

Exactly one loop tool is exposed at a time, and none when no loop runs:

| State | Exposed |
|---|---|
| no loop | neither |
| goal loop, working | `loop_done` |
| goal loop, checking a claim | `loop_approve` |
| forever loop | neither |

The active-tool list is derived from Pi's current list each time, so tool
choices made by you or by other extensions are preserved. A `tool_call` gate
covers a call that was already issued before the swap took effect.

Every state change writes a durable `loop-state` entry and both stop paths write
`loop-stopped` via `pi.appendEntry`. Thus a loop can resume after a restart —
including a tool-free forever loop — while a stopped loop stays stopped. On
reconstruction, an active forever loop removes `loop_done` again.

## Status widget

```text
pass 3/5 · refine the renderer
Ctrl+Shift+X to stop
```

Footer status is `loop · iter 3` (goal mode), `loop · evaluating` (while a claim
is being checked), or `loop · forever`. A tool result renders as
`✓ loop complete` or `→ checking`; forever loops produce no tool result at
all.

## What changed from pi-agent-loop

- **Minimal grammar**: `/loop goal` and `/loop forever <task>`. The original's
  `passes <N>`, bare `<N>`, and `pipeline <s1|s2|s3>` grammar forms are gone
  (the pipeline mode, `stages` field, and pipeline branches are deleted).
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
- **Tool-free forever loops**: `/loop forever <task>` removes
  `loop_done` while active and continues only from `agent_end`, so a badly
  behaving model cannot manufacture progress with repeated `next` calls.
- **One verb, renamed**: the tool is `loop_done` and only claims completion,
  with a reason. The `next` status is gone from the schema, the tool
  description, every prompt, and the system prompt. The extension advances the
  loop when a turn ends, so the model can no longer call its own iterations.
  Legacy `{ status: "done" }` calls from older sessions are folded into the new
  shape; a legacy `{ status: "next" }` call is rejected instead of silently
  ending the loop.
- **Confirmation before closing**: a `loop_done` claim is checked in the next
  turn by `loop_approve`, and an unconfirmed claim resumes the loop instead of
  closing it. Exactly one loop tool is exposed at a time.
- **No count form**: `/loop <N> <task>` is gone. With the advance action
  removed, a "pass" was only "one model turn", and a loop that ends when the
  goal is met is the useful case. The command points at what is left instead
  of failing cryptically.
- **Durable loop state**: state moved from tool-result details to explicit
  `loop-state` entries, because the model no longer produces a result per
  iteration. Legacy sessions that carry tool-result details still restore.
- **Force-close nudge**: new `agent_end` behavior — a run that ends while
  the loop is still open is steered with a "continue working" message
  (never after abort/error). The original just went silent.

The original let the model drive the loop with `loop_control(next|done)`. This
version keeps only the *ending* half of that vocabulary — as `loop_done` — and
moves iteration control to the extension. Forever mode is the other
intentional exception: it has its own tool-free prompt and continuation.

## Development

```bash
npm install
npm test          # vitest — 136 tests
npm run typecheck # tsc --noEmit (src + tests)
npm pack --dry-run
```

The tests cover parsing, prompts, turn-end transitions, the claim and
confirmation phases, tool exposure per phase, renderers, command dispatch,
stop controls, and session reconstruction through a fake `ExtensionAPI`
harness.

## Provenance and license

The behavior contract and most of the implementation come from
[`pi-agent-loop@0.1.1`](https://www.npmjs.com/package/pi-agent-loop) by
pierre-mike, which declares MIT in its manifest but ships no `LICENSE` file
and has no public source repository. This package is a trimmed port of that
code: the same three-file structure, prompts, and tool contract, with the
pipeline/passes grammar removed, the dependency/event API brought up to
current Pi, and the defects above fixed.

Licensed MIT — see [LICENSE](LICENSE).
