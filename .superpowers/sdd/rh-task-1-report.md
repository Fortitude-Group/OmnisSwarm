# Task 1 (Contract): report

Branch wt/rh1, off feat/ready-handoff. Built by rh-dev-1.

## What I built
- events.ts: `task.handoff` (in EVENT_TYPES), `HANDOFF_WHY`/`HandoffWhy`, `error?` on agent.tool, `gatePin?` on task.created, `dependsOn?` on task.updated.
- fold-agents.ts (new): the agent.tool case moved out of fold.ts (now 455 lines). Agent `trail` (last 8 ends) and `errs` (last 3 failures, text '' when none). Exports TRAIL_KEEP, ERRS_KEEP, MAX_ERROR_TEXT.
- fold-tasks.ts: `gatePin` (64 lowercase hex or null), `handoffs`, dependsOn replaced on update, task.created first-wins, `task <id> ready` and `task <id> handoff note from <name>` feed lines. MAX_DEPENDS now lives here.
- state-check.ts: accepts trail, errs, gatePin (required key), handoffs (optional).
- ready.ts (new, mod-safe): readyTasks, newlyReady, waitsOn, strandedBy, wouldCycle, cyclePath, MAX_TASKS (500).
- recording.ts: HANDOFF_TOOL, INTERNAL_TOOL includes handoff. guard.ts DENY_REASON names omnis_handoff.
- record.ts: validates `error` (text, only on a failed end), strips control chars, collapses whitespace, redacts, clips to 160 code points.
- tools.ts: omnis_task_update takes `dependsOn` and `handoff`; dependsOn emitted on task.updated; `handoff: true` is accepted and does nothing else.
- fence.ts / fence-guard.ts: DEPENDS_REFUSAL, HANDOFF_REFUSAL.

## Final npm run check
- typecheck: clean.
- node tests: 1036 tests, 1035 pass, 0 fail (1 skipped, as on baseline).
- kit tests: 191 pass, 0 fail (baseline 189).
- Two earlier full runs each failed one test in tests/mcp/gate-run.test.ts (the tree-kill tests: "past the time limit..." then "an abort kills..."), where the grandchild's pid was not in the log yet. A different test each time, passing alone (17/17, twice) and on the third full run. They are timing-sensitive under machine load (other agents were running checks). I did not touch that file; Task 4 owns it.

## Decisions where spec and plan were silent
1. A dependency naming a task that doesn't exist is ignored by ready.ts (not waited on). A forged line can't strand a task for ever.
2. `task.updated` to done fires ready lines only when the task was not already done (so a repeat done doesn't repeat them). `newlyReady` agrees; a test checks it.
3. Refusal order in the fence guard: skipGate, then handoff, then ownership keys (owns/assignee/worktree), then dependsOn. A call with dependsOn plus an ownership key gets OWNS_REFUSAL (plan decision 1).
4. `handoff: false` and `dependsOn` absent are not refused for a subagent; `dependsOn: null` or `[]` is (key present). `handoff` is refused only when `=== true`.
5. A task.handoff with an agent id the fold doesn't know uses the id as the name; a blank agent is skipped.
6. record.ts drops `error` when nothing is left after cleaning, rather than writing ''. The fold's `text` for a failure with no error is ''.
7. state-check now requires `gatePin` on every task. An old snapshot without it fails the check and is rebuilt from the log (assumed to be the snapshot loader's normal path for an invalid snapshot; I did not read snapshot.ts).
8. Loop refusal text: path of ids joined with ` → `; with more than 8 ids, the first 8 then ` → …` (no closing id).
9. Tests were written with the code rather than strictly red first for the pure/mechanical parts; no separate red run was recorded.

## For Tasks 2, 3, 4
- Import `readyTasks`, `newlyReady`, `waitsOn`, `strandedBy` from src/core/ready.ts. `MAX_TASKS` is also exported by src/mcp/tools.ts (same 500); ready.ts has its own.
- `TaskEntry` now has `gatePin: string | null` and optional `handoffs`. Any literal TaskEntry in your tests needs `gatePin: null`.
- `AgentState.trail?: {tool, subject, ok}[]` and `errs?: {tool, subject, text, at}[]` (`at` is epoch ms).
- Task 4: the server still calls pinGate (in-memory) in the create handler; I did not touch pins.ts or put gatePin on the event. The fold already stores it.
- Task 3: `handoff: true` is parsed in the taskUpdate handler (`args.handoff === true`), after the done check; add the behaviour after the `tasks` lookup, before the emit. `HANDOFF_TOOL` is in recording.ts. The `error` the mod sends must be a string on a phase end with isError true only, else omnis_record refuses it.
- The refusal texts are exported from src/mod/fence.ts.
