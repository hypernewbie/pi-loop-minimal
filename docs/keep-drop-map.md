# pi-loop-minimal — keep/drop map (baseline of pi-agent-loop@0.1.1)

Evidence: full read of `pi-agent-loop@0.1.1` (`index.ts` 180 lines, `state.ts`
173, `tool.ts` 157; 510 total, zero tests) and Pi 0.83 extension docs.

## Wrong dependency (user: "isnt that the wrong dependency?")

The original manifest declares `peerDependencies: { "@mariozechner/pi-coding-agent": "*" }`
and imports `@mariozechner/pi-ai`, `@mariozechner/pi-tui`, `@sinclair/typebox`.
`@mariozechner/*` is the legacy namespace. Current Pi docs (packages.md) list the
bundled peers as `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`,
`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox` — all
with `"*"` ranges. Replacement: the `@earendil-works/*` set + `typebox`.

## Keep

| Item | Why |
|---|---|
| `/loop goal <description>` | requested form |
| `/loop <N> <task>` | requested form (original grammar was `/loop passes <N> <task>`; the count form is retained, the word `passes` is dropped) |
| `loop_control` tool (`next`/`done`, summary, reason) | the original's signal mechanism; foundation to keep |
| `before_agent_start` system-prompt injection | steering foundation |
| `ctx.ui.setStatus` / `setWidget` widget | UX foundation (restyled in phase 3) |
| `Ctrl+Shift+X` abort + `ctx.abort()` | existing stop/abort control surface; current `@earendil-works/pi-tui` still exports `Key.ctrlShift` (verified `keys.d.ts:118`) |
| `/loop-stop` command | existing stop control surface, not a loop form; dropping it would remove capability the original already has |
| Session-branch reconstruction on `session_start` / `session_tree` | the original's state-continuity foundation (dead `session_switch`/`session_fork` events dropped — see Drop) |
| `pi.sendMessage` + `deliverAs: "steer"` + `triggerTurn` advance | auto-advance foundation |
| Module structure `index.ts` / `state.ts` / `tool.ts` | preserve the original source structure |

## Drop

| Item | Reason |
|---|---|
| `/loop passes <N> <task>` grammar word | requested: only `goal` and `<N>` forms |
| `/loop pipeline <s1|s2|s3>` mode + `stages` + pipeline prompt | requested: not retained |
| `session_switch`, `session_fork` event handlers | events do not exist in current Pi; compatibility drop |
| Empty `agent_end` handler (no-op with comment) | dead code; removes nothing |
| `setTimeout(…, 100)` before the advance message | demonstrated defect: arbitrary delay + ordering race; `deliverAs: "steer"` already queues until after the current turn's tool calls, so the message can be sent synchronously |
| `@mariozechner/*`, `@sinclair/typebox` imports | wrong dependency (see above) |


## Foundation fixes permitted under "improve upon foundations"

- JSON-unsafe goal state: `maxSteps: Infinity` for goal mode round-trips to
  `null` in tool-result `details` (reconstruction of a goal loop then sees
  `maxSteps: null`, breaking the `=== Infinity` display check). Minimal fix:
  represent the unbounded goal mode as `null` and treat `null` as unbounded —
  goal mode never uses the end-of-pass check anyway.
- Any fix must stay proportionate and non-user-visible unless it is required by
  the two retained forms.

## Not in scope (do not add)

Persistence entries, watchdogs, nudges, goal caps, `loop-state`/`loop-receipt`
entries, extra commands, `/loop stop`/`/loop status`, status footers, or a
module split beyond the original three files. All of these would be invented
scope.
