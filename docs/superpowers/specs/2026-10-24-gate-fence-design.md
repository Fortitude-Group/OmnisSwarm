# OmnisSwarm: verification gate and scope fence

Asked for by Rob on 2026-10-24 ("start with the gate and scope fence and build them all in that order"). It extends the main design (`2026-10-21-omnisswarm-design.md`) and the clash spec (`2026-10-23-clash-stuck-report-design.md`); anything not said here follows those. The ready-task list and stuck handoff come after, in their own spec.

## 1. Goals and non-goals

Goals:
- A task can't be closed as done while the project's build or tests fail in the place the work was done.
- An agent can't edit files outside the ones its task owns.
- Both are measured, not guessed: an exit code and a path match.

Non-goals:
- Choosing or writing the gate command for the user beyond a fixed detection order (section 2.3).
- Seeing Bash writes (`sed -i`, `>`, `mv`). Same blind spot as the clash guard, and the README says so.
- Coverage numbers. The test-gap note (section 2.7) counts files, nothing more.
- Running anything on a model's say-so. The model picks *which task* and *which registered worktree*, never the command.
- Any dependency.

## 2. Verification gate

### 2.1 When it runs

On `omnis_task_update` with `state: "done"`, before the `task.updated` event is written. Every other state change is unchanged. The tool's handler becomes async (`AsyncToolDef`, `src/mcp/protocol.ts`).

### 2.2 Where it runs

The **run directory** is, in order: the `worktree` argument of this call, else the task's stored `worktree` (set on `omnis_task_create` or an earlier update), else the project root.

A `worktree` value must resolve (after `realpath`) to the project root or to a worktree registered with this repo. Registered worktrees are read from `<root>/.git/worktrees/*/gitdir` (each holds the path of that worktree's `.git` file; the worktree is its parent folder). No `git` process is started. Anything else is an `InputError`: `worktree is not this project or one of its git worktrees.` The stored value is the resolved path.

### 2.3 What it runs

The command comes from the user, or from files in the run directory. Never from a tool argument.

1. The `gateCommand` setting, when not empty.
2. Else the first of these found in the run directory:
   - `scripts/build-test.ps1` → `pwsh -NoProfile -File scripts/build-test.ps1`
   - `scripts/build-test.sh` → `bash scripts/build-test.sh`
   - `package.json` with a `scripts.check` → `npm run check`
   - `package.json` with a `scripts.test` that isn't npm's placeholder (`no test specified`) → `npm test`
   - exactly one `*.slnx`, else exactly one `*.sln`, at the top of the run directory → `dotnet test <file>`
3. Else there is no gate. The task closes, the reply says `No gate found in <dir>, so nothing was run.`, and `gate.ran` is recorded with result `none`.

### 2.4 How it runs

- In the MCP server (`node:child_process` `spawn`, `shell: true`, `windowsHide: true`, stdin ignored, the server's environment). This is the first child process in `src/`. The README's "What it runs" section says so: one command, chosen as above, only when a task is marked done.
- Time limit `gateMinutes` (default 10, 1 to 60, clamped to what Claude Code allows a tool call; section 6). On timeout the whole process tree is killed (`taskkill /pid <pid> /T /F` on Windows, a negative-pid `SIGKILL` on a detached group elsewhere) and the result is `timeout`.
- One gate per run directory at a time. A second `done` for the same directory while one runs is refused: `A gate is already running in <dir>. Wait for it, then try again.` At most 3 gates run at once across directories; a fourth is refused the same way with `Three gates are already running.`.
- Output (stdout and stderr, interleaved) goes to `.omnis-swarm/gates/<swarm>-<task>-<n>.log` (`n` counts runs of that task from 1). The log is capped at 2 MiB; past that the middle is dropped with a marker line.
- If the server is cancelled (`notifications/cancelled` for the call) or exits, the gate's tree is killed.

### 2.5 The setting and what each result does

`verifyGate`: `block` (default), `warn`, `off`. Anything else is `block`. `off` skips sections 2.2 to 2.7 entirely (the old behaviour).

| Result | block | warn |
|---|---|---|
| passed (exit 0) | task done | task done |
| failed (exit ≠ 0), timeout, error (could not start) | task keeps its state, reply is an error | task done, reply carries the failure |
| none (no gate found) | task done | task done |

Reply texts, exactly (the `Last lines` block is the last 40 lines of the log, at most 4,000 characters, with `SECRETISH` runs blanked as in `tools.ts`):

- Pass: `Task <id> is now done. Gate passed in <s> s (<command>).`
- Block on failure: `Gate failed for <id> (<why>, <s> s): <command>. The task stays <state>.\nLast lines:\n<lines>\nFull log: <log path>` where `<why>` is `exit <code>`, `timed out after <m> min` or `could not start: <message>`. The tool result has `isError: true`.
- Warn on failure: `Task <id> is now done, but its gate failed (<why>, <s> s): <command>. verifyGate is warn, so it closed anyway.\nLast lines:\n<lines>\nFull log: <log path>`

`<command>` is shown clipped to 80 characters, `<log path>` relative to the project.

### 2.6 Skipping the gate

`omnis_task_update` gains `skipGate: true`, which needs a `note` (the reason). It closes the task without running the gate and records `gate.ran` with result `skipped`. Only the lead may use it: the mod refuses a subagent's call that carries `skipGate` with `Only main can skip the gate. Report the problem to main instead.` (a `tool.check` hook, origin is the subagent's `agentId`). With mods off, the refusal doesn't happen; accepted, as with the internal-tool guard.

### 2.7 Test-gap note

When the gate passes or fails (not `none` or `skipped`), and the task has an assignee whose agent is in the swarm, the reply gets one more line when that agent edited at least one source file and no test file in this swarm:

`Note: <assignee> changed <n> source file(s) and no test files.`

- Edited files are the agent's `edit`-kind subjects in `state.edits`.
- A test file matches `/(^|\/)(tests?|__tests__|spec|specs)\//i` or `/\.(test|spec)\.[a-z0-9]+$/i` or `/Tests?\.(cs|fs|vb)$/`.
- A source file has one of these extensions and isn't a test file: `ts tsx js jsx mjs cjs mts cts py cs fs vb go rs java kt swift rb php c cc cpp h hpp`.
- It never changes the result. It's also recorded on `gate.ran` as `gap: <n>`.

### 2.8 Event

`gate.ran` (src `mcp`, no `agent`): `{ task, result: 'passed'|'failed'|'timeout'|'error'|'none'|'skipped', ms, command?, exit?, log?, gap?, mode: 'block'|'warn' }`.

Fold: the task gets `gate: { result, at, runs }` (`runs` counts every `gate.ran` for it). Feed line, kind `task`: `task <id> gate ✓ <s>s`, `task <id> gate ✕ <why>`, `task <id> gate skipped`, or `task <id> no gate`. The pane needs no drawing change: the feed already shows task lines.

Run report: a `Gates` line per task that ran one (`t3 ✓ 42 s`, `t4 ✕ exit 1 then ✓`), and every failed or skipped gate under Problems.

## 3. Scope fence

### 3.1 Ownership

`omnis_task_create` and `omnis_task_update` gain `owns`: up to 20 patterns, each 1 to 200 characters. A pattern is a path relative to the repo root, `/`-separated, with `*` (any run of characters inside one segment), `**` (any number of whole segments) and `?` (one character). A trailing `/` means everything under that folder. Refused at input: a leading `/` or drive letter, a `..` segment, a `\`, and characters outside `[A-Za-z0-9._/*?@+ -]`. On update, `owns` replaces the list; `owns: []` clears it.

### 3.2 Who is fenced

A **subagent** whose name is the assignee of at least one task with a non-empty `owns`, in any state. Its fence is the union of those tasks' patterns. Counting done and failed tasks too stops a subagent from lifting its own fence by moving its task to `failed` and back (security finding RM1). Main frees an agent by clearing a task's `owns` or reassigning it. The lead is never fenced. An agent with no such task isn't fenced (fail open).

### 3.3 The check

On `tool.check` for Edit, Write and NotebookEdit from a subagent, the path (normalised as the clash guard does, `normalisePath` in `src/mod/holds.ts`) is matched like this:

- The **roots** are the project root and its registered worktrees (section 2.2). The path is made relative to the longest root it sits under.
- A path under no root (a scratch or temp file) passes.
- A relative path that matches any pattern passes. Matching folds case when the root has a drive letter.
- Anything else is outside the fence.

The fence check runs before the clash guard, so a fenced-out edit never takes a hold.

### 3.4 The setting and what happens

`scopeFence`: `block` (default), `warn`, `off`. Anything else is `block`.

- block: refused with, exactly, `<path> is outside the files your task owns (<task ids>: <patterns>). Ask main to widen the task, or leave it to the agent that owns it.` (`<patterns>` comma-separated, clipped to 120 characters.)
- warn: the edit goes ahead and the lead is told, exactly, `[OmnisSwarm scope fence] <agent> edited <path>, outside <task ids>'s files.`
- Both record `fence.blocked` (deduped per agent and path within 60 s, as clashes are).

### 3.5 How the mod learns the fence

A new internal tool `omnis_fence` (`{ agent: <agentId> }`) answers `{ fenced: false }` or `{ fenced: true, tasks: string[], owns: string[], roots: string[] }` from the folded state. It joins the internal-tool guard (`INTERNAL_TOOL`, `DENY_REASON`). The mod caches each agent's answer for 10 s, drops the whole cache when it sees any `omnis_task_create` or `omnis_task_update` call, and fails open on any error or a slow answer (over 2 s).

### 3.6 Event

`fence.blocked` (src `mod`, `agent` the refused agent): `{ path, tasks: string[], mode: 'block'|'warn' }`, validated by `omnis_record` like `clash.blocked`. Fold: agent gets `fenceBlocks` (count). Feed line, kind `task`: `fence: <agent> ✕ <path>` (block) or `fence: <agent> ! <path>` (warn). Run report: each under Problems.

## 4. Settings and docs

Five new `userConfig` entries: `verifyGate`, `gateCommand` (string, default empty), `gateMinutes` (number, default 10), `scopeFence`. The server reads `verifyGate`, `gateCommand` and `gateMinutes` from the plugin options it's given (the integrator checks how plugin options reach the MCP server; if they don't, they're passed through `env` in `plugin.json` as `OMNIS_VERIFY_GATE`, `OMNIS_GATE_COMMAND`, `OMNIS_GATE_MINUTES` using `${user_config.*}`).

README: two new sections ("The verification gate", "The scope fence"), the settings list, and the "What it runs and what it sends" section updated for the child process. `docs/event-log.md`: two rows. Version 0.4.0.

## 5. Security

- The command never comes from a tool argument. A model can only choose the task and a registered worktree. An agent can already run any command with Bash, so running the repo's own scripts gives it nothing new; the gate runs with the server's rights, which are the user's.
- `worktree` is checked after `realpath`, so a symlink can't point the gate outside the repo's worktrees.
- The log is written only under `.omnis-swarm/gates/`, named from the swarm id and task id, both already validated.
- `owns` patterns are validated at input and only ever matched, never used to build a path.
- The reply's log tail is redacted with `SECRETISH`. The full log file isn't (it's the user's own test output, kept in the git-ignored `.omnis-swarm/`).
- The security reviewer looks at the runner, the worktree check, the pattern validator and the `omnis_fence` tool.

## 6. How long a tool call may run (settled 2026-10-24)

From https://code.claude.com/docs/en/mcp.md:
- The per-call wall-clock limit is `MCP_TOOL_TIMEOUT`, or a server's own `timeout` (ms), and defaults to about 28 hours. Progress notifications don't extend it.
- Separately, a call with no response and no progress for the idle window is aborted: 30 min for stdio (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`).
- A main-conversation call still running after 2 minutes becomes a background task, so the lead's turn carries on.

So: `gateMinutes` stays 1 to 60. When the call carries a `progressToken`, the server sends `notifications/progress` every 30 s while the gate runs, which keeps the idle timer alive past 30 min. `plugin.json` sets the server's `timeout` to 3,900,000 ms (65 min) so a 60-minute gate isn't cut off by a lower global setting (the integrator checks a plugin server honours `timeout`; if not, the README notes it). On `notifications/cancelled` for the call, the gate's process tree is killed.
