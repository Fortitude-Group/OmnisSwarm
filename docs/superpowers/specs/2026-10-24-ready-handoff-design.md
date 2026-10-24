# OmnisSwarm: ready-task list and stuck-task handoff

Asked for by Rob on 2026-10-24 ("go ahead with the ready-task and stuck handoff spec"). These are features 3 and 4 from the RuFlo list. It extends the gate and fence spec (`2026-10-24-gate-fence-design.md`), which extends the main design and the clash spec. Anything not said here follows those. It also takes on the three 0.4.0 follow-ups (section 4). Version 0.5.0.

## 1. Goals and non-goals

Goals:
- When a task closes, the lead is told straight away which tasks can now start. Nobody has to re-read the board to find them.
- When an agent is stuck for good, the next agent starts from a note with what the first one did, what failed and which files it touched, instead of from nothing.
- Both come from the log, measured, as the gate and fence do. The handoff note holds facts the recorder saw, never a model's summary of them.

Non-goals:
- Assigning or spawning agents. OmnisSwarm says what's ready and the lead decides. RuFlo's idle auto-assign has no equivalent here: Claude Code has no idle teammate to hand a task to, and the lead spawns agents.
- Stopping an agent. The mod can't, so a handoff never moves a task away from an agent that may still be running. The lead does that (section 3.5).
- Refusing work on a task whose dependencies aren't done. The reply mentions it and the work goes ahead.
- Any dependency.

## 2. Ready-task list

### 2.1 What ready means

A task is **ready** when its state is `pending` and every task in its `dependsOn` is `done`. A task with no `dependsOn` that is `pending` is ready too.

A task is **waiting** when it's `pending` and at least one dependency isn't `done`. It's **stranded** when one of those dependencies is `failed`.

These are pure functions in a new `src/core/ready.ts`, used by the server, the fold and the report, and covered by node:test:
- `readyTasks(state): TaskEntry[]` (in id order, `t2` before `t10`)
- `newlyReady(before: SwarmState['tasks'], after: SwarmState['tasks']): TaskEntry[]` (ready after, not before)
- `waitsOn(state, id): { id: string; state: TaskState }[]` (unfinished dependencies)
- `strandedBy(state, id): string[]` (failed dependencies)
- `wouldCycle(tasks, id, deps): boolean`

### 2.2 dependsOn on update

`omnis_task_update` gains `dependsOn` (up to 20 task ids, as on create). It replaces the list, and `dependsOn: []` clears it. It is refused when:
- a task in it doesn't exist: `dependsOn: no task <id> in swarm <swarm>.` (the create wording)
- it names the task itself, or would close a loop: `dependsOn would make a loop: <id> → <dep> → … → <id>.` (the path found, at most 8 ids, then `…`)

`task.updated` gains `dependsOn?: string[]`. The fold replaces the task's list when it's present, applying the same cleaning as `task.created`. Create can't make a loop, because a task can only depend on tasks that already exist.

Only main may change `dependsOn`. The fence guard already refuses a subagent's `owns`, `assignee` and `worktree` changes; `dependsOn` joins that list, with the same refusal text pattern.

### 2.3 What the lead sees

**When a task closes.** The `omnis_task_update` reply for `state: "done"` gains a last line, only when some task became ready because of this call:

`Now ready: t4 Build the parser (dev-3), t5 Write the docs (no assignee).`

Titles are clipped to 40 characters, and at most 8 tasks are listed, then `and <n> more`. In block mode, a gate failure that keeps the task open adds nothing, because nothing became ready.

**When a task fails.** The reply for `state: "failed"` gains `Now stranded: t4, t5 (they depend on <id>).` when some pending task depends on it.

**When work starts early.** The reply for `state: "active"` on a task that's still waiting gains `Note: <id> still waits on t3 (active), t6 (pending).` The update goes ahead.

**Status.** `omnis_swarm_status` gains two lines after `Tasks:`, each only when it isn't empty:
- `Ready: t4 (dev-3), t5 (no assignee)`
- `Waiting: t6 on t4, t7 on t4 t5`, with stranded tasks marked: `t8 on t3 (failed)`

Each line lists at most 10 tasks, then `and <n> more`.

**When a subagent closes a task.** The reply goes to the subagent, not the lead. So when a subagent's `omnis_task_update` call succeeds and its reply has a `Now ready:` line, the mod appends that line to main, exactly as `[OmnisSwarm] <agent> closed <id>. Now ready: …` (the rest of the line as the server gave it). This is a new observe-only `tool.call` hook in `src/mod/ready-relay.ts`, registered after the gate guard. It reads only its own server's reply, and only the line that starts with `Now ready: `.

### 2.4 Feed, pane and report

- Fold: when a `task.updated` sets a task to `done`, every task that `newlyReady` returns gets a feed line, kind `task`: `task t4 ready`. The pane needs no drawing change.
- Run report, under Tasks: `- Never started: t5, waiting on failed t3.` for each stranded task that is still pending when the report is written.

## 3. Stuck-task handoff

### 3.1 What the recorder keeps for it

At the moment the log says that a call failed but not why. This adds the why:

- `agent.tool` with `phase: "end"` and `isError: true` gains `error?: string`. The mod takes the first text block of the result (or the deny reason for a refused call), and the server's `omnis_record` cleans it the way `cleanText` does, blanks `SECRETISH` runs (`src/mcp/redact.ts`) and clips it to 160 characters before writing. Calls that succeed never carry it.
- The fold keeps two short lists on each agent. Both are optional fields, absent until first used, like `stuckBy`:
  - `trail`: the last 8 tool calls that ended, oldest first, each `{ tool, subject, ok }`.
  - `errs`: the last 3 failed calls, each `{ tool, subject, text, at }`.
- `state-check.ts` accepts both.

### 3.2 When a handoff note is written

There are three triggers.

1. **Stuck again.** In the same run, the stuck guard hits the same agent a second time, with either pattern. The agent no longer gets the step-back nudge. It gets this instead: `You're still stuck. Stop here, and report to main what you tried and what's blocking you.` The mod then calls the internal tool `omnis_handoff` with `{ agent: <agentId>, why: "stuck" }`. A run ends when the agent's turn ends, and `StuckWatch` counts hits per run (`forget` already resets it).
2. **Finished while stuck.** A subagent's turn ends while one of its stuck patterns has fired and hasn't re-armed. The mod calls `omnis_handoff` with `{ agent, why: "finished" }`. This only happens if trigger 1 hasn't already fired in that run.
3. **The lead asks.** `omnis_task_update` gains `handoff: true` (section 3.4).

### 3.3 What omnis_handoff does

`omnis_handoff` is an internal tool. It joins `INTERNAL_TOOL` in `src/core/recording.ts` (as `HANDOFF_TOOL`) and the guard's `DENY_REASON` list, so the model can't call it while the mod is loaded.

1. It finds the agent's open tasks: those whose assignee is the agent's name, with state `active` or `pending`. Active tasks come first, then by id, at most 3.
2. If there are none, it returns `{ notes: [] }` and writes nothing.
3. For each task, it builds the note (section 3.6), stores it in swarm memory under `handoff/<id>` (`putMemory`, writer `omnis`), and emits `memory.put` and `task.handoff` (section 3.7).
4. It returns `{ notes: ["handoff/t3", …] }`. The task's state and assignee don't change.

The mod then appends this to main:

`[OmnisSwarm] <agent> is stuck on <ids> (<pattern>). Its handoff note is in memory: handoff/<id>. To hand it on, stop <agent>, then give <id> a new assignee and tell it to read handoff/<id> first.`

For trigger 2, the words `is stuck on` become `finished while stuck on`. When there are no open tasks, the mod appends `[OmnisSwarm] <agent> is stuck (<pattern>) and has no open task to hand on.` for trigger 1, and nothing for trigger 2.

As with the fence, any error or a reply slower than 2 s is ignored (fail open). The worst that can happen is a missing note.

### 3.4 handoff on omnis_task_update

`handoff: true` writes the note for the task's **current** assignee, from the state before this call, and then applies the rest of the call as usual. So one call can hand a task on:

`omnis_task_update { id: "t3", state: "pending", assignee: "dev-5", handoff: true, note: "dev-2 stuck on the parser" }`

- It is refused when the task has no assignee, or when that agent has never recorded a tool call: `<id> has no agent's work to hand on.`
- It is refused together with `state: "done"`: `A done task has nothing to hand on.`
- Only main may use it. The mod refuses a subagent's call that carries `handoff`, with `Only main can hand a task on. Report what's blocking you to main instead.` The refusal lives in the same `tool.check` hook as `skipGate`.
- The reply gains `Handoff note saved as handoff/<id>.`, and the `task.handoff` event has `why: "lead"`.

### 3.5 Why the task isn't released automatically

The mod can't stop a subagent. A task moved to a new assignee while the old agent is still running would leave two agents on it. Worse, it would lift the old agent's fence, because the fence follows the assignee (gate and fence spec, section 3.2). So OmnisSwarm writes the note and says what to do, and the lead stops the agent before reassigning. The README says this.

### 3.6 The note

The note is plain text, built by the pure function `handoffNote(state, taskId, agentId): string` in `src/core/handoff.ts`. It is at most `MAX_VALUE_BYTES` (4,096). When it would be bigger, sections are cut from the bottom of the `Read` list first, then the trail. Lines appear in this order, and a line with nothing to say is left out:

```
Handoff for t3: Build the parser
From dev-2 (stuck: failing, nudged 2 times). 14 min, 63 tool calls, 11 failed.
Owns: src/parser/**, tests/parser/**. Worktree: C:/repo-wt/gf2.
Gate: ✕ exit 1 then ✕ exit 1.
Edited: src/parser/lex.ts, src/parser/parse.ts
Read, not edited: src/core/events.ts, docs/grammar.md
Last calls, oldest first:
  ✓ Read src/parser/lex.ts
  ✕ Bash npm run check
Last errors:
  Bash npm run check: tests/parser/lex.test.ts:41 expected 3 tokens, got 2
Last said to main: parser fails on nested brackets, unsure why
Note on the task: dev-2 stuck on the parser
```

- **Edited:** the agent's paths in `state.edits` that weren't blocked, at most 20.
- **Read, not edited:** `agent.files` minus the edited ones, at most 10.
- **Last said to main:** the newest summary on the agent's link to the lead.
- **Gate:** the task's gate history, worded as in the run report.
- The time and call counts come from `agentStats`.
- Every path and text field is used as the fold already cleaned it. The note is data that the next agent reads, and it never runs.

### 3.7 Event

`task.handoff` (src `mcp`, no `agent`): `{ task, agent, why: 'stuck' | 'finished' | 'lead' }`, where `agent` is the agent's id.

- Fold: the task gets `handoffs` (a count, optional). Feed line, kind `task`: `task <id> handoff note from <name>`.
- Run report, under Problems: `- <id> was handed on from <name> (<why>).`
- `docs/event-log.md` gets a row for it, plus the `error` field on `agent.tool`, `dependsOn` on `task.updated` and `gatePin` on `task.created` (section 4.1).

## 4. 0.4.0 follow-ups

### 4.1 Gate pins survive a restart

The pin moves from `src/mcp/gate/pins.ts` (in memory) to the log. `task.created` gains `gatePin?: string` (64 lowercase hex), and the fold stores it as `task.gatePin: string | null`. `omnis_task_create` computes the digest before emitting, as it does now, and puts it on the event. `pinnedGate` then reads the folded task. `pins.ts` is deleted.

The fold also ignores a `task.created` for an id that already exists, so the first one wins. The server never writes a second one, and this stops a forged line from resetting a task's pin or state.

### 4.2 A changed gate doesn't waste a prompt

`omnis_gate_plan` checks the pin the way `gateForDone` does. When the digest differs from the task's pin, it answers `{ run: false, changed: true }`. The gate guard then refuses the call before asking about Bash, with the text the server would have given:

`Gate failed for <id> (the gate changed since the task was created, 0 s): <command>. The task stays <state>.`

Both sides use `PINNED_WHY`, so the wording can't drift.

### 4.3 The POSIX kill is run once

- `tests/mcp/gate-run.test.ts` line 166: on POSIX, `kills.length <= 1` becomes `=== 1`.
- The gate tests then run once under WSL Ubuntu, which is installed on this machine. Node 22 is installed there with nvm if it's missing. That's a dev environment, so it's fine to change.
- The result goes in the review file. If the kill doesn't happen, it's fixed in this release.

## 5. Settings and docs

There are no new settings. Ready lines and handoff notes cost nothing when nobody uses `dependsOn` or nobody gets stuck.

The README gets:
- two new sections, "Ready tasks" and "Handing on a stuck task", including the stop-first advice from section 3.5
- the error text in "What it records"
- the Limits line about pins being lost on restart removed

`docs/event-log.md` gets the rows from section 3.7, and the version goes to 0.5.0.

## 6. Security

- **Error text.** Error text now reaches the log. It's clipped to 160 characters and blanked with `SECRETISH` on the server, which is the one place every recorder event passes. The log stays in the git-ignored `.omnis-swarm/`. `omnis_export` and `omnis_replay` must not show `error` (a test checks this).
- **Handoff notes.** They are built only from folded, already-cleaned state, and written under a fixed key shape (`handoff/t<digits>`). `omnis_handoff` takes an agent id and a fixed `why` enum, and nothing else.
- **dependsOn.** It's validated against existing ids, and loops are refused at input, and every walk in `ready.ts` also stops after `MAX_TASKS` (500) steps, so a forged log line can't hang it.
- **First wins.** `task.created` first-wins (section 4.1) closes one forged-line route. An agent with Bash can still append to the log, as before. This is the same trust as the rest of the log, and the README already says Bash is a blind spot.
- **Review scope.** The security reviewer looks at the `error` field path (mod → `omnis_record` → fold → note), `omnis_handoff`, the subagent refusal of `handoff` and `dependsOn`, and the first-wins fold change.

## 7. Build plan (for the task breakdown)

| Task | Owns | Depends on |
|---|---|---|
| T1 Groundwork | `src/core/events.ts`, `fold.ts`, `fold-tasks.ts`, `state-check.ts`, new `src/core/ready.ts`, `recording.ts` (`HANDOFF_TOOL`), fold and ready tests | none |
| T2 Ready list | `src/mcp/tools.ts` (status lines, the `dependsOn` update, reply lines), new `src/mod/ready-relay.ts`, `src/core/report.ts` (Never started), the fence guard's `dependsOn` refusal | T1 |
| T3 Handoff | new `src/core/handoff.ts`, new `src/mcp/tools/handoff.ts`, `src/mcp/tools/record.ts` (`error`), `src/mod/record-events.ts`, `stuck.ts`, `stuck-guard.ts`, `guard.ts`, the `handoff` arg in `tools.ts`'s `taskUpdate` handler only, `report.ts` Problems line | T1 |
| T4 Follow-ups | `src/mcp/gate/*` (`pins.ts` removed), `tools/gate-plan.ts`, `src/mod/gate-guard.ts`, the pin lines in `tools.ts`'s create handler, `tests/mcp/gate-run.test.ts`, the WSL run | T1 |
| T5 Docs | `README.md`, `docs/event-log.md` | T2 to T4 merged |

T2, T3 and T4 run in parallel, each in its own worktree. They all touch `tools.ts`, but in separate handlers and line ranges, so the lead merges them T4, T3, T2 and resolves by keeping both sides. `registry.ts`, `register.ts`, `plugin.json`, `package.json` and the version belong to the lead. T1 stays serial because the other three build on its types. A security review runs on T3 before the merge.
