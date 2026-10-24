# Task 4 (Follow-ups): report

Branch wt/rh4, off feat/ready-handoff. Built by rh-dev-4.

## What I built
- 4.1: `omnis_task_create` computes the gate digest before emitting and puts it on `task.created` as `gatePin`. `gateForDone` is given `task.gatePin ?? undefined`. `src/mcp/gate/pins.ts` is deleted (it had no tests of its own; gate.test.ts covers the behaviour). New test: the pin is on the event, and a new `createTools` over the same root (server restart) still refuses a changed gate with `PINNED_WHY`.
- 4.2: `omnis_gate_plan` answers `{"run":false,"changed":true,"state":"<task state>","command":"<shown command>"}` when the digest differs from the pin (a removed gate included, command `no gate found`). `skipGate` and mode off still answer `{"run":false}`. The gate guard refuses with `Gate failed for <id> (the gate changed since the task was created, 0 s): <command>. The task stays <state>.` before any Bash `$.tool.check`. Kit test checks the exact text, no Bash query and no approval.
- 4.3: POSIX assertion in gate-run.test.ts is now `=== 1`. WSL run below.
- Flakiness: see below.

## Decisions where spec and plan were silent
1. New file `src/core/gate-text.ts` (not in the file list): `PINNED_WHY` and `refusedText()`. The mod can't import from `src/mcp`, so the shared wording had to live in core. gate.ts re-exports `PINNED_WHY` (tests import it from there) and builds its refusal with `refusedText`, so both sides use one source. Lead: please keep this file when merging.
2. `SHOWN_COMMAND` in gate.ts is now exported, so gate-plan uses the same clip as the reply.
3. The guard treats a `changed` plan missing `state` or `command` as unreadable and fails closed (FAILED_TEXT).
4. Pin means `gatePin !== null`; the plan's check mirrors `gateForDone` (`digest !== pin`, so a null digest counts as changed).

## Flakiness: cause and fix
Cause (established by reading the tests and run.ts, then reproducing nothing flaky afterwards, not by catching a failure myself): the tests that need the grandchild's pid used a fixed `sleep(1200)` before aborting / killing, and the time-limit test used `limitMs: 1500`. The command is `node -e` that spawns a second node and prints `GRANDCHILD <pid>`. Under load node needs more than 1.2 s (or 1.5 s) to start and spawn, so the pid wasn't in the log when the test read it. That matches Task 1's failures (a different test each time, passing alone).
Fix, without weakening what is proved:
- New `started(log)` helper polls the log (up to 20 s) until the pid is printed. The abort, killAllGates and SIGTERM tests wait on that instead of sleeping.
- The time-limit test's limit is 5000 ms (`TREE_LIMIT_MS`), with the lower bound `TREE_LIMIT_MS - 100`; it still proves the timer kills the whole tree once.
- The POSIX kill assertion is `=== 1`.
Verified: gate-run.test.ts 17/17 twice alone, and 6 copies run at the same time (all 17/17).

## WSL (Ubuntu, WSL2, Linux 5.15.153.1)
Node was missing in WSL; I installed nvm v0.40.1 and Node 24 (v24.22.1) in my WSL user's home (dev environment). The worktree is read from /mnt/c. `node --test` ran the .ts files the same way as on Windows, no flags needed. The process group kill happens exactly once (`=== 1` passes), so run.ts needed no change.
Full output (`node --test --test-timeout=60000 tests/mcp/gate-run.test.ts`):
```
v24.22.1
Linux 5.15.153.1-microsoft-standard-WSL2
✔ exit 0 passes, and output goes to the log (124.615852ms)
✔ exit 3 fails with the code, and stderr is in the log and tail (116.574241ms)
✔ stdin is not open to the gate (114.350631ms)
✔ past the time limit the whole tree is killed, grandchild included (5058.256503ms)
✔ an abort kills the tree and answers cancelled (302.05255ms)
✔ an already aborted signal runs nothing (3.353769ms)
✔ a run directory that does not exist is a could-not-start error (16.84502ms)
✔ 3 MiB of output: the log keeps its head and tail under the cap, with a marker (616.689762ms)
✔ output under the cap is kept whole, even past the first half (342.817577ms)
✔ the tail is at most 4,000 characters and token-shaped runs are blanked (469.533369ms)
✔ a second gate in the same directory is refused while one runs (1783.527586ms)
✔ a fourth gate anywhere is refused while three run (1659.838931ms)
✔ a background child holding the output open does not hold the gate past its exit, and nothing is killed after the exit (2209.548752ms)
✔ killAllGates kills every running tree at once (245.766681ms)
✔ SIGTERM, SIGINT and SIGHUP kill running gates, then exit (370.838319ms)
✔ the gate settings are not passed on to the gate command (285.76769ms)
✔ the log is created new: an existing file at its name is never overwritten (3.201296ms)
ℹ tests 17
ℹ suites 0
ℹ pass 17
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 14486.022383
```

## npm run check (in the worktree, Windows)
- typecheck clean; node tests: 1040 tests, 1039 pass, 0 fail (1 skipped, as on baseline); kit tests: 192 pass, 0 fail (191 in Task 1, +1 for the changed-gate guard test).

## Not done / assumed
- I wrote the new tests together with the code and did not record a separate red run for them.
- I assumed an old log without `gatePin` on `task.created` simply has no pin (null), as the fold from Task 1 does.
