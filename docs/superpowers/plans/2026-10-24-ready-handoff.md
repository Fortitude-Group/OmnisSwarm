# Ready-task list and stuck-task handoff Implementation Plan

> **For agentic workers:** build one task, test-first, in your own worktree. Read the spec first: `docs/superpowers/specs/2026-10-24-ready-handoff-design.md`. Every exact string in the spec is used verbatim.

**Goal:** closing a task tells the lead what it unblocked. A stuck agent leaves a handoff note, built from the log, for whoever takes its task next. The three 0.4.0 follow-ups ship alongside. Version 0.5.0.

**Architecture:** Task 1 lays the shared contract: events, fold, the pure `ready.ts`, record validation, tool arguments and the subagent refusals. Then three tasks run in parallel worktrees: the ready list (Task 2), the handoff (Task 3) and the follow-ups (Task 4). Task 5 is a security review of 1 and 3. Task 6 integrates and writes the docs.

**Tech stack:** TypeScript on Node 24 (`node --test` for pure and server code), the Claude Code mod kit (`npm run test:mod`) for hooks. No dependencies.

## Global constraints

- No dependencies. Use Web APIs only in `src/mod/**` and anything it imports, so `src/core/ready.ts` and `src/core/handoff.ts` must be mod-safe: no `node:` imports. In the mod, timers go only through `$.clock`.
- Never store `$`. Never pass `$` through a property call. Every observe-only hook calls `next` once and returns its result unchanged. Every gating hook's `.catch` passes `next(e)`, so it fails open. The gate guard is the exception: it fails closed, as it does today.
- Kit tests take `KIT` from `src/mod/test-engine.ts` and drive behaviour through `$.tool.check`, `$.tool.call`, `$.turn.complete` and `$.agent.spawn`. Never call a `register*` function from a kit test.
- Before every commit, run `npm run check`. It must be green: typecheck, node tests and kit tests. That exact command is allowed in `.claude/settings.json`.
- Keep files under 500 lines. `src/core/fold.ts` is at 471, so Task 1 moves the `agent.tool` case into a new `src/core/fold-agents.ts` rather than growing it.
- Commit messages are plain British English, with no em dashes, no AI attribution and no `Co-Authored-By` trailer. The author is `Fortitude Omnis <dev@fortitude-omnis.group>`.
- Never kill processes by name.

## Decisions this plan makes where the spec is silent

1. **The new subagent refusals live where the old ones do.**
   - `dependsOn` joins `OWNERSHIP_KEYS` in `src/mod/fence-guard.ts`. When `dependsOn` is the only ownership key present, the refusal is `Only main can change what a task depends on. Ask main instead.` (`DEPENDS_REFUSAL` in `fence.ts`). Otherwise the existing `OWNS_REFUSAL` stands.
   - `handoff` is refused next to `skipGate`, with the spec 3.4 text (`HANDOFF_REFUSAL`).
   - Task 1 does both, so the parallel tasks never touch `fence-guard.ts`.
2. **Task 1 parses every new argument.**
   - `omnis_task_update` gains `dependsOn` and `handoff` in its schema. Both are parsed and validated, with the existing-id check, the loop refusal through `wouldCycle` and `handoff` with `done` refused.
   - `dependsOn` is emitted on `task.updated`.
   - `handoff: true` is accepted, and Task 3 gives it its behaviour.
3. **Ready feed lines are worked out in the fold without a snapshot.** On a `task.updated` that sets `done`, each `pending` task that depends on that id, and whose dependencies are now all `done`, gets `task <id> ready`. That is the same set `newlyReady` gives, and a test checks they agree.
4. **The `error` field is cleaned on the server.** `omnis_record` validates `agent.tool` end events: `error` is optional, a string, only allowed when `isError` is true, and is `cleanText`-ed, redacted and clipped to 160 before the event is written (Task 1). The mod side, which fills it in from the tool result or deny reason, is Task 3.
5. **`omnis_handoff` replies in JSON** (`{"notes":["handoff/t3"]}`), as `omnis_fence` does, so the mod parses it rather than matching text.
6. **The handoff memory write goes through `putMemory`.**
   - The stored writer is `omnis`.
   - The `memory.put` event has no `agent`, so the fold counts it as the lead's and no placeholder agent appears.
   - A full memory store (`MemoryLimitError`) skips the note. `omnis_handoff` then returns the notes it did write, and the `handoff: true` reply says `Memory is full, so no handoff note was saved.`
7. **Stuck-again counting lives in `StuckWatch`.** Each agent's track gains `hits` (reset by `forget`). `start` and `end` return the hit with `again: true` when `hits` is already 1 or more. The `finished` trigger needs `StuckWatch.stillStuck(agent)`, which is true when `failFired` or `repeatFired` is set. It's read in the `turn.complete` hook before `forget`.

## File map

| File | Task | Responsibility |
|---|---|---|
| `src/core/events.ts` | 1 | `task.handoff` + `HANDOFF_WHY`, `agent.tool.error?`, `task.created.gatePin?`, `task.updated.dependsOn?` |
| `src/core/fold.ts`, `fold-tasks.ts`, `fold-agents.ts` (new) | 1 | agent `trail`, `errs`; task `gatePin`, `handoffs`, `dependsOn` on update; first-wins create; ready and handoff feed lines |
| `src/core/state-check.ts` | 1 | accept the new fields |
| `src/core/ready.ts` (new) | 1 | the five pure functions in spec 2.1 |
| `src/core/recording.ts`, `src/mod/guard.ts` | 1 | `HANDOFF_TOOL`, `INTERNAL_TOOL` includes `handoff`, deny text names it |
| `src/mcp/tools/record.ts` | 1 | validate and clean `error` |
| `src/mcp/tools.ts` | 1 | the `dependsOn` and `handoff` args (decision 2) |
| `src/mod/fence.ts`, `fence-guard.ts` | 1 | decision 1 |
| `src/mcp/tools.ts` | 2 | `Now ready` / `Now stranded` / `still waits on` reply lines, status `Ready:` / `Waiting:` |
| `src/mod/ready-relay.ts` (new), `src/mod/register.ts` | 2 | relay a subagent's `Now ready:` line to main |
| `src/core/report.ts` | 2 | `Never started` under Tasks |
| `src/core/handoff.ts` (new) | 3 | `handoffNote(state, taskId, agentId)` |
| `src/mcp/tools/handoff.ts` (new), `src/mcp/registry.ts` | 3 | internal `omnis_handoff` |
| `src/mcp/tools.ts` (`taskUpdate` handler, handoff branch only) | 3 | `handoff: true` writes the note |
| `src/mod/record-events.ts`, `recorder.ts` | 3 | send `error` on failed tool ends |
| `src/mod/stuck.ts`, `stuck-guard.ts` | 3 | stuck again, finished while stuck, call `omnis_handoff`, texts to agent and main |
| `src/core/report.ts` (Problems, handoff line only) | 3 | `<id> was handed on from <name> (<why>)` |
| `src/mcp/gate/pins.ts` (deleted), `gate.ts`, `tools/gate-plan.ts`, `tools.ts` (create handler pin lines) | 4 | pins from the log, `changed` plan answer |
| `src/mod/gate-guard.ts` | 4 | refuse a changed gate before asking |
| `tests/mcp/gate-run.test.ts` + a WSL run | 4 | POSIX kill |
| `README.md`, `docs/event-log.md`, `package.json`, `plugin.json`, `server.ts` | 6 | docs, 0.5.0 |

## Parallelism

- **Task 1 runs first, alone.** Everything imports its types.
- **Tasks 2, 3 and 4 run in parallel,** each in its own worktree off Task 1's merge.
  - Three of them touch `src/mcp/tools.ts`, but in separate places: Task 2 the status text and the `done`/`failed`/`active` reply, Task 3 the `handoff` branch, and Task 4 the create handler's pin lines.
  - Two of them touch `src/core/report.ts`: Task 2 the `tasks()` function and Task 3 one line in `problems()`.
  - The lead resolves conflicts by keeping both sides.
- **Task 5** (security review) reads Tasks 1 and 3 once they're done. Fixes go back to their developer.
- **Task 6** integrates in order 4, 3, 2, then writes the docs and the version.

### Task 1: Contract

- Spec 2.1, 2.2, 3.1, 3.7 (event and fold only) and 4.1 (event and fold only), plus decisions 1 to 4.
- `ready.ts`:
  - Tests cover:
    - a chain `t1 → t2 → t3`
    - a fan-in (`t4` on `t2` and `t3`)
    - `newlyReady` across a single update
    - a stranded task
    - `wouldCycle` for a self-loop, a two-loop and a long loop
    - a forged cyclic `dependsOn` in folded state, where every walk still ends
  - The loop path in the refusal text comes from `wouldCycle`'s companion `cyclePath(tasks, id, deps): string[] | null`.
- Fold:
  - `trail` keeps the last 8 entries and `errs` the last 3.
  - A failed end without `error` adds an `errs` entry with `text: ''`.
  - Test that `task.created` is first-wins.
  - Test that a `gatePin` that isn't 64 lowercase hex is dropped (`null`).
- `task.handoff` fold and feed line are exactly as in spec 3.7, using the agent's name, or its id when it's unknown.
- Report: `.superpowers/sdd/rh-task-1-report.md`.

### Task 2: Ready list

- Spec 2.3 and 2.4.
  - Every reply line, the status lines with their caps (`and <n> more`) and the Never-started line, each with a test.
- `ready-relay.ts`:
  - Registered after `registerGateGuard`.
  - Observe-only, on `tool.call` for `omnis_task_update` under any server alias, from a subagent (`e.agentId` set), and only when the result isn't an error.
  - Kit tests:
    - a subagent's close with a ready line is relayed with the exact text
    - main's own close isn't relayed
    - a reply without the line isn't relayed
    - an error result isn't relayed
- Report: `.superpowers/sdd/rh-task-2-report.md`.

### Task 3: Handoff

- Spec 3.1 (the mod side), 3.2 to 3.6 and decisions 5 to 7.
- `handoff.ts`:
  - A golden test for the spec 3.6 example layout.
  - A note that would be over 4,096 bytes is cut as the spec says.
  - Empty sections are left out.
- `omnis_handoff`:
  - no open tasks
  - one active and one pending task (active first)
  - more than 3 tasks
  - an unknown agent
  - a full memory store
- Mod (kit tests):
  - The second hit in a run sends the stop text, not the nudge, and calls `omnis_handoff`.
  - A turn ending while still stuck calls it with `finished`. A turn ending after the pattern re-armed doesn't.
  - Each main text is exact.
  - A server failure or a slow reply still sends the agent text and appends nothing.
  - A failed tool end records `error` from the result's first text block, and a refused one records it from the deny reason.
- `handoff: true` on `omnis_task_update`:
  - It writes the note from the assignee before the call.
  - The same call can reassign.
  - It's refused with no worked agent, and refused with `done`.
- Report: `.superpowers/sdd/rh-task-3-report.md`.

### Task 4: Follow-ups

- Spec 4.1 (server side), 4.2 and 4.3.
- Test: a task created, then the server's in-memory state dropped (a new `createTools` over the same root), then the gate edited, then `done`. The task is refused with `PINNED_WHY`.
- `gate-plan` answers `{"run":false,"changed":true}`. The kit test shows the gate guard refusing with the exact text, without a `$.tool.check` Bash query.
- WSL:
  - Run `wsl -d Ubuntu -- bash -lc '<cd to the worktree under /mnt/c> && node --test tests/mcp/gate-run.test.ts'`, after installing Node 24 with nvm in WSL if `node` is missing there.
  - `npm ci` isn't needed: there are no dependencies, but check that `node --test` runs the TypeScript the same way it does on Windows.
  - Put the output in the report.
  - If the kill fails, fix `run.ts` and say so.
- Report: `.superpowers/sdd/rh-task-4-report.md`.

### Task 5: Security review

- `omnis-security-reviewer` reads Tasks 1 and 3's diffs against spec section 6. Findings go to `.superpowers/sdd/rh-task-5-review.md`.

### Task 6: Integrate, docs and release

- Merge in order. Then:
  - README: "Ready tasks" and "Handing on a stuck task" (with the stop-first advice), error text in what it records, and the pins-lost-on-restart Limits line removed.
  - `docs/event-log.md`: the rows in spec 3.7.
  - Version 0.5.0 in `package.json`, `plugin.json`, `server.ts` and the README.
- Full gate green, then merge to master and push.
