# Verification gate and scope fence Implementation Plan

> **For agentic workers:** build one task, test-first, in your own worktree. Read the spec first: `docs/superpowers/specs/2026-10-24-gate-fence-design.md`. Every exact string in the spec is used verbatim.

**Goal:** `omnis_task_update(done)` runs the project's gate and refuses to close a red task. An agent's edits are fenced to the files its task owns.

**Architecture:** Task 1 lays the shared contract (events, fold, pure glob matcher, worktree reader, task fields). Then three tasks run in parallel worktrees: the gate in the server (Task 2), the fence in the server and mod (Task 3), the report (Task 4). Task 5 is a security review of 2 and 3. Task 6 integrates.

**Tech stack:** TypeScript on Node 24 (`node --test` for pure and server code), the Claude Code mod kit (`npm run test:mod`) for hooks. No dependencies.

## Global constraints

- No dependencies. Web APIs only in `src/mod/**` and anything it imports (so `src/core/glob.ts` must be mod-safe: no `node:` imports). Timers in the mod only through `$.clock`.
- Never store `$`. Never pass `$` through a property call. Every gating hook's `.catch` passes `next(e)` (fail open).
- Kit tests take `KIT` from `src/mod/test-engine.ts` and drive behaviour through `$.tool.check`, `$.tool.call`, `$.turn.complete`, `$.agent.spawn`. Never call a `register*` function from a kit test.
- Gate before every commit: `npm run check` green (typecheck, node tests, kit tests).
- Files under 500 lines. `src/core/fold.ts` is at 482: Task 1 moves the task cases into a new `src/core/fold-tasks.ts` rather than growing it.
- Commit messages: plain British English, no em dashes, no AI attribution, no `Co-Authored-By` trailer. Author `Fortitude Omnis <dev@fortitude-omnis.group>`.
- Never kill processes by name. The gate runner kills only the tree of the process it started, by PID.

## Decisions this plan makes where the spec is silent

1. **Settings reach the server through `env`.** The server has no plugin options today (only `OMNIS_PROJECT_DIR`). Task 2 reads `OMNIS_VERIFY_GATE`, `OMNIS_GATE_COMMAND`, `OMNIS_GATE_MINUTES` from `process.env` through one `gateSettings(env)` function. Task 6 wires them in `plugin.json` with `${user_config.<key>}` and checks that substitution works (if it doesn't, Task 6 stops and reports).
2. **Handlers get a call context.** `protocol.ts` passes a second argument `ctx: { signal: AbortSignal; progress: (message: string) => void }` to every handler. `progress` is a no-op when the call had no `_meta.progressToken`. `notifications/cancelled` with a matching `requestId` aborts that call's signal. Sync tools ignore `ctx`. `runStdio` writes progress notifications with the same single-writer rule as replies.
3. **`worktree` and `owns` ride on the existing task events.** `task.created` and `task.updated` data gain optional `worktree?: string` and `owns?: string[]`. No new event for them.
4. **Fence roots come from the server.** Only the server can read `.git/worktrees`. `omnis_fence` returns them, and the mod caches them with the agent's answer.
5. **Gate log name:** `.omnis-swarm/gates/<swarm>-<task>-<n>.log`, `n` = that task's `gate.runs + 1` from the fold.

## File map

| File | Task | Responsibility |
|---|---|---|
| `src/core/events.ts` | 1 | `gate.ran`, `fence.blocked`, `GATE_RESULTS`, `FENCE_MODES`, task data fields |
| `src/core/fold.ts`, `src/core/fold-tasks.ts` (new) | 1 | task `owns`, `worktree`, `gate`; agent `fenceBlocks`; feed lines |
| `src/core/state-check.ts` | 1 | accept the new optional fields |
| `src/core/glob.ts` (new) | 1 | pure: `validPattern`, `matchesAny(patterns, relPath, foldCase)` |
| `src/mcp/worktrees.ts` (new) | 1 | `projectRoots(root)`, `resolveWorktree(root, value)` |
| `src/core/recording.ts`, `src/mod/guard.ts` | 1 | `FENCE_TOOL`, `INTERNAL_TOOL` includes `fence`, deny text names `omnis_fence` |
| `src/mcp/tools/record.ts` | 1 | validate `fence.blocked` |
| `src/mcp/tools.ts` | 1 | task_create/update accept `owns`, `worktree` (store), and parse `skipGate` + `note` (behaviour in Task 2) |
| `docs/event-log.md` | 1 | two event rows, the new task fields |
| `src/mcp/protocol.ts`, `src/mcp/server.ts` | 2 | handler `ctx`, progress, cancel |
| `src/mcp/gate/detect.ts` (new) | 2 | pure-ish: command detection (2.3), `gateSettings(env)` |
| `src/mcp/gate/run.ts` (new) | 2 | spawn, time limit, tree kill, log cap, tail, one-per-dir and max-3 |
| `src/mcp/gate/gate.ts` (new) | 2 | orchestration, reply texts, test-gap note, `gate.ran` |
| `src/mcp/tools.ts` | 2 | `omnis_task_update` becomes async and calls the gate |
| `src/mcp/tools/fence.ts` (new), `src/mcp/registry.ts` | 3 | internal `omnis_fence` |
| `src/mod/fence.ts` (new) | 3 | pure: cache, verdict, texts |
| `src/mod/fence-guard.ts` (new) | 3 | `tool.check` fence hook, cache drop on task tools, the `skipGate` refusal for subagents |
| `src/mod/register.ts` | 3 | one line, before `registerClashGuard` |
| `src/core/report.ts` | 4 | Gates section, gate and fence problems |
| `.claude-plugin/plugin.json`, `README.md`, `package.json` | 6 | settings, env, timeout, docs, 0.4.0 |

## Parallelism

- **Task 1 first, alone.** Everything imports its types.
- **Tasks 2, 3 and 4 in parallel**, each in its own worktree off Task 1's merge. Shared file: `src/mcp/tools.ts` is Task 2's alone (Task 3 adds a separate tool file). `src/mod/register.ts` is touched only by Task 3.
- **Task 5** (security review) reads 2 and 3 once they're done. Fixes go back to their developer.
- **Task 6** integrates in order 1 (already on the branch), 4, 2, 3, then the manifest and README.

---

### Task 1: Contract

- `gate.ran` and `fence.blocked` exactly as spec 2.8 and 3.6. `GATE_RESULTS = ['passed','failed','timeout','error','none','skipped']`, `FENCE_MODES = ['block','warn']`.
- `TaskEntry` gains `owns: string[]` (default `[]`), `worktree: string | null`, `gate: { result, at, runs } | null`. `AgentState` gains optional `fenceBlocks?: number`.
- Feed lines exactly as spec 2.8 and 3.6.
- `glob.ts`: `validPattern(p)` per spec 3.1 returns an error string or null. `matchesAny(patterns, rel, fold)`: `*` one segment's characters, `**` zero or more whole segments, `?` one non-`/` character, trailing `/` means the folder and everything under it. Test at least: `src/**` vs `src/a/b.ts` (yes), `src/*.ts` vs `src/a/b.ts` (no), `docs/` vs `docs/x/y.md` (yes), `**/*.test.ts` vs `a.test.ts` (yes), case folding on and off, a pattern equal to the whole path.
- `worktrees.ts`: `projectRoots(root)` = `[realpath(root), ...realpaths of each <root>/.git/worktrees/*/gitdir's parent folder that exists]`, never throws (an unreadable entry is skipped). `resolveWorktree(root, value)` returns the matching root or throws `InputError('worktree is not this project or one of its git worktrees.')`. Test with a temp repo layout built from files (no git process).
- `tools.ts`: schemas gain `owns` (array of string, max 20), `worktree` (string, max 400) on create and update; `skipGate` (boolean) on update. `owns` patterns are validated with `validPattern`. `skipGate: true` without `note` is an `InputError`: `skipGate needs a note saying why.` Task 1 stores `owns` and `worktree` and leaves `done` behaviour unchanged (Task 2 adds the gate).
- Report: `.superpowers/sdd/gf-task-1-report.md`.

### Task 2: Verification gate (server)

- Spec sections 2 and 6. Decisions 1, 2, 5 above.
- Detection test: temp dirs with each marker file, in priority order; npm's placeholder test script; two `.sln` files means none.
- Runner tests use real tiny commands through `node -e` (exit 0, exit 3, sleep past a 1 s limit, write 3 MiB of output) with the time limit injectable in ms for tests. Verify the tree kill: a child that spawns a grandchild sleeping 30 s is gone after the timeout (check the grandchild's PID no longer exists).
- `omnis_task_update` with `done`: `verifyGate` off keeps the old path. Otherwise resolve the run directory, detect, run, record `gate.ran`, then write `task.updated` only when the table in spec 2.5 says the task closes. Test every row of that table and every reply text.
- Progress: every 30 s while running, `ctx.progress('gate running, <m> min')`. Cancel kills the tree and the reply is the block-on-failure text with `<why>` = `cancelled`.
- Report: `.superpowers/sdd/gf-task-2-report.md`.

### Task 3: Scope fence (server tool and mod)

- Spec section 3 and 2.6 (the `skipGate` refusal).
- `omnis_fence` (internal, `{ agent }` matching the agent-id pattern used by `omnis_record`) reads the running swarm's folded state. The agent's name is `state.agents[agent].name`; its tasks are those assigned to that name in `pending` or `active` with non-empty `owns`.
- `fence-guard.ts` registers before the clash guard in `register.ts`, so its `tool.check` sees the edit first. Verify the order in a kit test: a fenced-out edit to a file nobody holds is refused and takes no hold (a second agent that owns the file can then edit it without a clash).
- Cache: 10 s per agent, cleared when `tool.call` sees any `omnis_task_create` or `omnis_task_update`. Server call timeout 2 s, fail open.
- Kit tests: blocked text, warn text to main, off, lead never fenced, unfenced agent, path outside every root passes, worktree root relative matching, dedupe of `fence.blocked` within 60 s, server error fails open, `skipGate` from a subagent refused and from main allowed.
- Report: `.superpowers/sdd/gf-task-3-report.md`.

### Task 4: Run report

- Spec 2.8 and 3.6: a `Gates` section after Tasks listing each task with `gate.runs > 0` (results in order need the fold to keep the last 5 results per task: Task 4 may add `gate.history` to the fold if Task 1 didn't, coordinating through the lead), and Problems lines `Gate failed for <id> (<why>)`, `Gate skipped for <id>`, `<agent> was fenced out of <n> edit(s)`.
- Report: `.superpowers/sdd/gf-task-4-report.md`.

### Task 5: Security review

- `omnis-security-reviewer` reads Tasks 2 and 3's diffs against spec section 5. Findings go to `.superpowers/sdd/gf-task-5-review.md`.

### Task 6: Integrate, manifest and README

- Merge in order. `plugin.json`: `verifyGate`, `gateCommand`, `gateMinutes`, `scopeFence` in `userConfig`; `env` gains the three `OMNIS_*` gate variables; the server gets `"timeout": 3900000`. `scopeFence` reaches the mod through plugin options like `clashGuard`.
- README: "The verification gate" and "The scope fence" sections, the settings list, "What it runs and what it sends" updated for the one child process. Version 0.4.0 in `package.json`, `plugin.json`, README.
- Full gate green. Report: `.superpowers/sdd/gf-task-6-report.md`.
