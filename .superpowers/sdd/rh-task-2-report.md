# Task 2 (Ready list): report

Branch wt/rh2, off feat/ready-handoff. Built by rh-dev-2.

## What I built
- `src/mcp/tools.ts` (status text and the task_update reply only):
  - `omnis_task_update` reply gains, as extra lines after `Task <id> is now <state>.` (or after the gate's text):
    - done: `Now ready: t4 Title (dev-3), t5 Title (no assignee).` from `newlyReady(before, after)`, titles clipped to 40, 8 tasks then `, and <n> more`. Only when something became ready. A gate refusal returns early, so it adds nothing.
    - failed: `Now stranded: t4, t5 (they depend on <id>).` for pending tasks whose `strandedBy` includes the id.
    - active: `Note: <id> still waits on t3 (active), t6 (pending).` from `waitsOn`. The update goes ahead.
  - `omnis_swarm_status` gains `Ready:` and `Waiting:` lines after `Tasks:`, 10 tasks each then `, and <n> more`, stranded dependencies marked `t8 on t3 (failed)`.
- `src/mod/ready-relay.ts` (new), registered right after `registerGateGuard` in `src/mod/register.ts`: observe-only `tool.call` on `omnis_task_update` under any alias. For a subagent call (`agentId` set), not an error or deny, with a `Now ready: ` line in the reply, it appends `[OmnisSwarm] <name> closed <id>. <line>` to main. Name via `agentLabel`. The id must match `t<digits>`. Any failure is swallowed; the result is returned unchanged.
- `src/core/report.ts` `tasks()`: `- Never started: t5, waiting on failed t3.` for each pending task with a failed dependency.

## Tests added
- `tests/mcp/ready-lines.test.ts` (7): every reply line, caps, clipping, status lines and the 10 cap.
- `tests/core/report-never-started.test.ts` (2).
- `src/mod/ready-relay.test.ts` (6 kit tests): relayed with exact text, other alias, main not relayed, no line, error result, other tool.

## npm run check
Green, exit 0. Typecheck clean. Node tests: 1045, 1044 pass, 0 fail, 1 skipped. Kit tests: 197 pass, 0 fail (191 before, plus 6).
Earlier full runs failed once on tests/mcp/gate-run.test.ts ("an abort kills the tree...", the known Task 4 flake) and once on my own relay test setup; the final run was clean.

## Decisions where spec and plan were silent
1. The cap wording is `..., and <n> more` (comma before "and") in all four lists.
2. `Now ready` uses a copy of the tasks taken just before this call's `task.updated`, because the session state advances in place. The copy is only taken for `done`.
3. `Waiting:` lists a pending task with several unfinished dependencies as `t7 on t4 t5`; a failed one is marked inline: `t8 on t3 (failed) t4`.
4. The `Note: ... still waits on` line is given whenever the task has unfinished dependencies at the time of an `active` update, even if it was already active.
5. `Now stranded` keeps the spec's "they depend on" even for one task.
6. Report line with several failed dependencies: `waiting on failed t1, t2.`
7. The relay reads the task id from `e.input.id`, falling back to `e.id`; a kit `$.tool.call` puts arguments at the top level.
8. The kit tests mock the gate plan (`{"run":false}`) because `$.tool.call` of a `done` close runs the gate guard.
9. I did not run the tests red first; they were written alongside the code and passed on first run (the relay tests failed once on my own test setup, not on the code). Disclosed, not hidden.

## Not touched
`handoff` branch and create-handler pin lines in tools.ts, `problems()` in report.ts, fence-guard (Task 1 already refuses a subagent's `dependsOn`).
