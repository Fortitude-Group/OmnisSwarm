# Clash guard, stuck nudges and run report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** OmnisSwarm acts on file clashes and stuck agents instead of only drawing them, and writes a short markdown report of every run.

**Architecture:** Task 1 lays the shared contract (three new events, their fold, stats, the record tool, the internal-tool guard, an agent-name helper). Then five tasks run in parallel worktrees: the clash guard (a `tool.check` hook with in-memory holds), stuck nudges (a `tool.call` observer with a pure tracker), the report core and server tool, the report trigger and `/omnis report` in the mod, and the pane's ` (blocked)` wording. Task 7 integrates (register.ts, plugin.json, README).

**Tech Stack:** TypeScript on Node 24 (`node --test` for pure code), the Claude Code mod kit (`claude plugin test` via `npm run test:mod`) for hooks, no dependencies.

**Spec:** `docs/superpowers/specs/2026-10-23-clash-stuck-report-design.md`. Read it before your task.

## Global Constraints

- No dependencies. Web APIs only in `src/mod/**` and anything it imports; timers only through `$.clock`.
- Never store `$`. Never pass `$` through a property call (`obj.fn($)` is refused by the validator); plain function calls only.
- Every gating hook's `.catch` passes `next(e)` (fail open).
- Every kit test (`src/mod/*.test.ts`) takes `KIT` (or `{ ...KIT, options: {...} }`) from `src/mod/test-engine.ts`. The kit loads `register.ts` itself: a kit test never calls a `register*` function again, and a test's own import of a mod module is a separate copy, so drive behaviour through `$.tool.check`, `$.tool.call`, `$.turn.complete`, `$.agent.spawn`, `$.command.run`.
- Gate before every commit: `set -o pipefail; npm run typecheck 2>&1 | tee .superpowers/gate-typecheck.txt && npm test 2>&1 | tee .superpowers/gate-test.txt && npm run test:mod 2>&1 | tee .superpowers/gate-mod.txt`. All three green.
- Files under 500 lines.
- Commit messages: plain British English, no em dashes, no semicolons, no AI attribution or `Co-Authored-By` trailer.
- `HOLD_IDLE_MS = 600_000`. `STUCK_NUDGE_AFTER = 5`. `REPEAT_NUDGE_AFTER = 4`. Clash events deduped per agent and path within `60_000` ms.
- Refusal text, exactly: `<holder> is editing <path>. Message them, or wait until they finish.`
- Warn text, exactly: `[OmnisSwarm clash guard] <agent> edited <path> while <holder> holds it.`
- Failing nudge, exactly: `Your last 5 tool calls failed. Step back and try another approach, or report to main what's blocking you.`
- Repeating nudge, exactly: `You've run <tool> on <subject> 4 times with no change in between. Step back and try another approach, or report to main.`
- Main conversation line, exactly: `[OmnisSwarm] <name> looks stuck (<pattern>) and was asked to step back.` plus, when not delivered, ` The message was not delivered: <reason>.` (or ` The message was not delivered.` with no reason).
- Report pointer, exactly: `Swarm report: <path> · <n> agents · <minutes> min · ≈$<cost>.` (`agent` when n is 1, cost to two decimals).
- Report file: `.omnis-swarm/reports/<swarm>-<yyyymmdd>-<hhmm>.md`, local time, `-2`, `-3` for later ones in the same minute.
- userConfig `clashGuard`: `block` (default) / `warn` / `off`. Anything else is `block`.

## Decisions this plan makes where the spec is silent

Recorded so reviewers can check them against intent:

1. **The clash guard uses `tool.check`.** It runs after every `tool.call` hook, so the recorder has already recorded the refused call's `agent.tool` start (an `edit` entry in `state.edits`). The `clash.blocked` fold therefore marks that entry `blocked: true` rather than adding a second one, and adds an entry only when none from that agent is within 5 s. The event's `path` is the recorder's subject for the call (`toolSubject`), so it matches the `state.edits` key.
2. **A hold is taken only after the engine's verdict beneath is not `deny`**, so an edit the permission rules refuse holds nothing.
3. **Repeating only counts `read`, `bash`, `search` and `web` tools with a non-empty subject.** Sending the same agent four messages or calling an internal tool four times isn't a loop.
4. **The quiet trigger waits `QUIET_AFTER_MS = 30_000`** after the last running subagent finishes, and is cancelled if another subagent starts. Without it a lead that spawns in waves gets a report between every wave.
5. **`omnis_swarm_end` skips its report when nothing happened since the last one** (no subagent activity after `lastReport.at`), so a quiet-trigger report followed by an end doesn't write the same report twice. Its reply carries the pointer line itself (the lead reads the tool reply, so no extra append).
6. **The report counts subagents** in `<n> agents` and the heading (the lead is the table's first row but isn't counted).
7. **`stuckBy` keeps history**: `{ on, p, s, n }` (currently stuck, last pattern, last subject, nudges so far), so the report can list stuck nudges after they re-armed.

## File map

| File | Task | Responsibility |
|---|---|---|
| `src/core/events.ts` | 1 | three event types, `STUCK_PATTERNS`, `CLASH_MODES` |
| `src/core/fold.ts` | 1 | fold the three events, `stuckBy`, blocked edits, `lastReport` |
| `src/core/state-check.ts` | 1 | accept the new optional fields |
| `src/core/stats.ts` | 1 | `Clash.blocked`, `AgentStats.blockedClashes`, stuck from `stuckBy` |
| `src/core/recording.ts` | 1 | recorder types, `REPORT_TOOL`, `INTERNAL_TOOL` |
| `src/mcp/tools/record.ts` | 1 | validate `clash.blocked`, `agent.stuck` |
| `src/mod/guard.ts` | 1 | deny text names omnis_report |
| `src/mod/agent-name.ts` | 1 | `agentLabel($, id)` shared by tasks 2 and 3 |
| `docs/event-log.md` | 1 | three event rows |
| `src/mod/holds.ts` | 2 | pure: path normalising, holds, dedupe |
| `src/mod/clash-guard.ts` | 2 | `tool.check` and `turn.complete` hooks |
| `src/mod/stuck.ts` | 3 | pure: the two patterns and re-arming |
| `src/mod/stuck-guard.ts` | 3 | `tool.call` and `turn.complete` hooks, nudge |
| `src/core/report.ts` | 4 | pure `reportMarkdown`, `reportSummary`, `pointerText` |
| `src/mcp/out-file.ts` | 4 | `stamp`, `writeUnique` (moved out of export.ts) |
| `src/mcp/tools/report.ts` | 4 | `omnis_report`, `writeReport` |
| `src/mcp/tools.ts` | 4 | omnis_swarm_end writes a report |
| `src/mod/run-report.ts` | 5 | quiet trigger, `reportSub`, `reportCommand` |
| `src/mod/commands.ts` | 5 | `/omnis report` |
| `src/render/spotlight.ts` | 6 | ` (blocked)` |
| `docs/design/pane.md` | 6 | §14 |
| `src/mod/register.ts` | 2, 3, 5 | one line each (the integrator merges) |
| `.claude-plugin/plugin.json`, `README.md` | 7 | setting and docs |

## Parallelism

- **Task 1 first, alone.** Everything imports its types.
- **Tasks 2, 3, 4, 5 and 6 then run in parallel**, each in its own worktree off Task 1's merge. They touch disjoint files except `src/mod/register.ts` (Tasks 2, 3 and 5 each add one import and one call: the integrator keeps all three lines).
- **Task 7 last**: the integrator merges the wave in order 4, 5, 2, 3, 6, adds the manifest entry and the README.

---

### Task 1: Event contract, fold and shared helpers

**Files:**
- Modify: `src/core/events.ts`, `src/core/fold.ts`, `src/core/state-check.ts`, `src/core/stats.ts`, `src/core/recording.ts`, `src/mcp/tools/record.ts`, `src/mod/guard.ts`, `docs/event-log.md`
- Create: `src/mod/agent-name.ts`, `src/mod/agent-name.test.ts`, `tests/core/fold-clash-stuck.test.ts`
- Modify tests: `tests/mcp/record.test.ts`, `src/mod/guard.test.ts`

**Interfaces:**
- Produces:
  - `STUCK_PATTERNS = ['failing', 'repeating'] as const`, `type StuckPattern`, `CLASH_MODES = ['block', 'warn'] as const`, `type ClashMode` (events.ts)
  - `EventData['clash.blocked'] = { path: string; holder: string; mode: ClashMode }`
  - `EventData['agent.stuck'] = { pattern: StuckPattern; count: number; subject: string; delivered: boolean; reason?: string }`
  - `EventData['report.written'] = { path: string; agents: number; minutes: number; costUsd: number }`
  - `type AgentStuck = { on: boolean; p: StuckPattern; s: string; n: number }`, `AgentState.stuckBy?: AgentStuck`, edit entries `{ agent: string; at: number; blocked?: true }`, `SwarmState.lastReport?: { path: string; at: number }` (fold.ts)
  - `Clash = { path: string; agents: string[]; blocked: boolean }`, `AgentStats.blockedClashes: string[]` (stats.ts)
  - `RECORDER_TYPES` gains `'clash.blocked', 'agent.stuck'`; `REPORT_TOOL = 'omnis_report'`; `INTERNAL_TOOL = /^mcp__.+__omnis_(record|feed|replay|export|report)$/` (recording.ts)
  - `agentLabel($: EngineInterface, id: string | null): Promise<string>` (agent-name.ts): `'main'` for null, else the agent's name, else its description, else the id

- [ ] **Step 1: Write the failing fold and stats tests**

Create `tests/core/fold-clash-stuck.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldAll, fold, LEAD } from '../../src/core/fold.ts'
import { agentStats, fileClashes } from '../../src/core/stats.ts'
import { isSwarmState } from '../../src/core/state-check.ts'
import type { ToolKind } from '../../src/core/events.ts'
import { at, ev } from '../helpers.ts'

const started = (id: string, name: string) => ev('agent.started', { name, role: 'coder', description: '', parent: LEAD }, { agent: id, atSec: 0 })
const tool = (id: string, phase: 'start' | 'end', name: string, kind: ToolKind, subject: string, isError: boolean, atSec: number) =>
  ev('agent.tool', { phase, tool: name, kind, subject, isError }, { agent: id, atSec })
const edit = (id: string, path: string, atSec: number) => tool(id, 'start', 'Edit', 'edit', path, false, atSec)
const roundTrip = (s: unknown) => JSON.parse(JSON.stringify(s))

test('a refused edit marks the recorder entry blocked, and the clash says so', () => {
  const s = foldAll('s1', [
    started('a1', 'coder-1'), started('a2', 'coder-2'), edit('a1', 'src/x.ts', 1), edit('a2', 'src/x.ts', 2),
    ev('clash.blocked', { path: 'src/x.ts', holder: 'a1', mode: 'block' }, { agent: 'a2', atSec: 2 }),
  ])
  assert.deepEqual(s.edits['src/x.ts'], [{ agent: 'a1', at: at(1) }, { agent: 'a2', at: at(2), blocked: true }])
  assert.deepEqual(fileClashes(s), [{ path: 'src/x.ts', agents: ['a1', 'a2'], blocked: true }])
  assert.deepEqual(agentStats(s, 'a2', at(3))!.blockedClashes, ['src/x.ts'])
  assert.equal(s.feed.at(-1)!.text, 'coder-2 was refused: coder-1 holds src/x.ts')
  assert.ok(isSwarmState(roundTrip(s), 's1'))
})

test('with no recorder entry nearby a clash.blocked adds one, and warn mode is not blocked', () => {
  const s = foldAll('s1', [
    started('a1', 'coder-1'), started('a2', 'coder-2'), edit('a1', 'src/x.ts', 1),
    ev('clash.blocked', { path: 'src/x.ts', holder: 'a1', mode: 'warn' }, { agent: 'a2', atSec: 30 }),
  ])
  assert.deepEqual(s.edits['src/x.ts'], [{ agent: 'a1', at: at(1) }, { agent: 'a2', at: at(30) }])
  assert.deepEqual(fileClashes(s), [{ path: 'src/x.ts', agents: ['a1', 'a2'], blocked: false }])
  assert.equal(s.feed.at(-1)!.text, 'coder-2 edited src/x.ts while coder-1 holds it')
})

test('a clash.blocked with a bad mode or an empty path is skipped', () => {
  const s = foldAll('s1', [
    started('a1', 'coder-1'), edit('a1', 'src/x.ts', 1),
    ev('clash.blocked', { path: 'src/x.ts', holder: 'a1', mode: 'maybe' as never }, { agent: 'a2', atSec: 2 }),
    ev('clash.blocked', { path: '', holder: 'a1', mode: 'block' }, { agent: 'a2', atSec: 3 }),
  ])
  assert.deepEqual(s.edits['src/x.ts'], [{ agent: 'a1', at: at(1) }])
  assert.equal(s.agents.a2, undefined)
})

test('a failing agent.stuck shows the stuck look until a tool call succeeds', () => {
  const s = foldAll('s1', [started('a1', 'coder-1'), ev('agent.stuck', { pattern: 'failing', count: 5, subject: 'npm test', delivered: true }, { agent: 'a1', atSec: 10 })])
  assert.deepEqual(s.agents.a1!.stuckBy, { on: true, p: 'failing', s: 'npm test', n: 1 })
  assert.equal(agentStats(s, 'a1', at(10))!.stuck, true)
  assert.equal(s.feed.at(-1)!.text, 'coder-1 looks stuck (failing), asked to step back')
  fold(s, tool('a1', 'end', 'Bash', 'bash', 'npm test', false, 11))
  assert.deepEqual(s.agents.a1!.stuckBy, { on: false, p: 'failing', s: 'npm test', n: 1 })
  assert.equal(agentStats(s, 'a1', at(11))!.stuck, false)
  assert.ok(isSwarmState(roundTrip(s), 's1'))
})

test('a repeating agent.stuck holds while the subject repeats and re-arms on another subject or an edit', () => {
  const s = foldAll('s1', [started('a1', 'coder-1'), ev('agent.stuck', { pattern: 'repeating', count: 4, subject: 'src/a.ts', delivered: false, reason: 'gone' }, { agent: 'a1', atSec: 10 })])
  assert.equal(s.feed.at(-1)!.text, 'coder-1 looks stuck (repeating), asked to step back (not delivered)')
  fold(s, tool('a1', 'start', 'Read', 'read', 'src/a.ts', false, 11))
  assert.equal(s.agents.a1!.stuckBy!.on, true)
  fold(s, tool('a1', 'start', 'Read', 'read', 'src/b.ts', false, 12))
  assert.equal(s.agents.a1!.stuckBy!.on, false)
  fold(s, ev('agent.stuck', { pattern: 'failing', count: 5, subject: 'npm test', delivered: true }, { agent: 'a1', atSec: 13 }))
  assert.deepEqual(s.agents.a1!.stuckBy, { on: true, p: 'failing', s: 'npm test', n: 2 })
  fold(s, edit('a1', 'src/b.ts', 14))
  assert.equal(s.agents.a1!.stuckBy!.on, false)
})

test('agent.stuck for the lead or with a bad pattern is skipped', () => {
  const s = foldAll('s1', [
    ev('agent.stuck', { pattern: 'failing', count: 5, subject: 'x', delivered: true }, { atSec: 1 }),
    started('a1', 'coder-1'),
    ev('agent.stuck', { pattern: 'looping' as never, count: 5, subject: 'x', delivered: true }, { agent: 'a1', atSec: 2 }),
  ])
  assert.equal(s.agents[LEAD]?.stuckBy, undefined)
  assert.equal(s.agents.a1!.stuckBy, undefined)
})

test('report.written sets lastReport', () => {
  const s = foldAll('s1', [ev('report.written', { path: '.omnis-swarm/reports/s1-20261023-1000.md', agents: 2, minutes: 12, costUsd: 1.5 }, { atSec: 5 })])
  assert.deepEqual(s.lastReport, { path: '.omnis-swarm/reports/s1-20261023-1000.md', at: at(5) })
  assert.ok(isSwarmState(roundTrip(s), 's1'))
})

test('state-check refuses a malformed stuckBy, blocked flag or lastReport', () => {
  const s = roundTrip(foldAll('s1', [started('a1', 'coder-1'), edit('a1', 'src/x.ts', 1)]))
  assert.ok(isSwarmState(s, 's1'))
  assert.equal(isSwarmState({ ...s, agents: { a1: { ...s.agents.a1, stuckBy: { on: true, p: 'nope', s: '', n: 1 } } } }, 's1'), false)
  assert.equal(isSwarmState({ ...s, edits: { 'src/x.ts': [{ agent: 'a1', at: 1, blocked: false }] } }, 's1'), false)
  assert.equal(isSwarmState({ ...s, lastReport: { path: 'x' } }, 's1'), false)
})
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/core/fold-clash-stuck.test.ts`
Expected: FAIL (typecheck-free run: `clash.blocked` events fold to nothing, `blocked`/`stuckBy` missing).

- [ ] **Step 3: Add the event types**

In `src/core/events.ts`, after `GUARD_MAX`:

```ts
export const STUCK_PATTERNS = ['failing', 'repeating'] as const
export type StuckPattern = (typeof STUCK_PATTERNS)[number]
/** How a clash was handled: refused, or let through with a warning to the lead. */
export const CLASH_MODES = ['block', 'warn'] as const
export type ClashMode = (typeof CLASH_MODES)[number]
```

Add to `EventData` after `'guard.blocked'`:

```ts
  /** agent: the refused (or warned) agent. path: the recorder's subject for the call. holder: the holding agent's id. */
  'clash.blocked': { path: string; holder: string; mode: ClashMode }
  /** agent: the stuck agent. subject: the last tool call's subject. */
  'agent.stuck': { pattern: StuckPattern; count: number; subject: string; delivered: boolean; reason?: string }
  /** path: the report file, relative to the project. */
  'report.written': { path: string; agents: number; minutes: number; costUsd: number }
```

and to `EVENT_TYPES` after `'guard.blocked'`: `'clash.blocked', 'agent.stuck', 'report.written',`.

- [ ] **Step 4: Fold them**

In `src/core/fold.ts`:

Import `CLASH_MODES, STUCK_PATTERNS, type StuckPattern` from `./events.ts`.

Add the types after `AgentGuard`:

```ts
/**
 * Set once the stuck guard nudges the agent. on: still stuck (until the pattern re-arms). p: the last pattern. s: the
 * last subject. n: nudges so far. Kept after it re-arms, so the run report can list it.
 */
export type AgentStuck = { on: boolean; p: StuckPattern; s: string; n: number }
export type EditEntry = { agent: string; at: number; blocked?: true }
```

In `AgentState`, after `route?`:

```ts
  /** Absent until the stuck guard first nudges the agent. */
  stuckBy?: AgentStuck
```

In `SwarmState`: change `edits: Record<string, { agent: string; at: number }[]>` to `edits: Record<string, EditEntry[]>`, and add after `guard`:

```ts
  /** The latest run report; absent until one is written. */
  lastReport?: { path: string; at: number }
```

Add a constant after `SPEND_KEEP_MS`:

```ts
/** A clash.blocked marks the refused agent's own edit entry when the recorder's start for it is this close. */
const CLASH_MATCH_MS = 5_000
```

In `revive`, before `a.runs++`: `if (a.stuckBy !== undefined) a.stuckBy.on = false`.

In `case 'agent.tool'`, inside `if (d.phase === 'start') { ... }` at its end:

```ts
        if (a.stuckBy?.on === true && (kind === 'edit' || (a.stuckBy.p === 'repeating' && subject !== a.stuckBy.s))) a.stuckBy.on = false
```

and in the `else` branch's success arm (`a.errorsInRow = 0`), add: `if (a.stuckBy?.p === 'failing') a.stuckBy.on = false`.

Add three cases before `case 'task.updated'`:

```ts
    case 'clash.blocked': {
      const d = e.data
      const path = text(d.path, 80)
      if (path === '' || !isSafeKey(path) || !isOneOf(CLASH_MODES, d.mode)) break
      const a = agentOf(state, who, at)
      const holderId = text(d.holder, 64)
      const holder = Object.hasOwn(state.agents, holderId) ? state.agents[holderId]!.name : holderId
      const list = Object.hasOwn(state.edits, path) ? state.edits[path]! : (state.edits[path] = [])
      // The recorder's start for the refused call usually landed first: mark it rather than add a second entry.
      let entry: EditEntry | undefined
      for (let i = list.length - 1; i >= 0 && entry === undefined; i--) {
        if (list[i]!.agent === a.id && Math.abs(at - list[i]!.at) <= CLASH_MATCH_MS) entry = list[i]
      }
      if (entry === undefined) {
        entry = { agent: a.id, at }
        list.push(entry)
        trim(list, MAX_EDITS)
      }
      if (d.mode === 'block') entry.blocked = true
      a.lastActivity = at
      feed(state, { at, kind: 'agent', agent: a.id, text: d.mode === 'block' ? `${a.name} was refused: ${holder} holds ${path}` : `${a.name} edited ${path} while ${holder} holds it` })
      break
    }
    case 'agent.stuck': {
      const d = e.data
      if (who === LEAD || !isOneOf(STUCK_PATTERNS, d.pattern)) break
      const a = agentOf(state, who, at)
      a.stuckBy = { on: true, p: d.pattern, s: text(d.subject, 80), n: (a.stuckBy?.n ?? 0) + 1 }
      feed(state, { at, kind: 'agent', agent: a.id, text: `${a.name} looks stuck (${d.pattern}), asked to step back${d.delivered === true ? '' : ' (not delivered)'}` })
      break
    }
    case 'report.written': {
      const path = text(e.data.path, 120)
      if (path !== '') state.lastReport = { path, at }
      break
    }
```

- [ ] **Step 5: Accept the new fields in state-check**

In `src/core/state-check.ts`, import `STUCK_PATTERNS` from `./events.ts`, then:

```ts
const stuckRec = (x: unknown): boolean =>
  exact(x, ['on', 'p', 's', 'n']) && typeof x.on === 'boolean' && isOneOf(STUCK_PATTERNS, x.p) && str(x.s, 80) && num(x.n)
const editRec = (e: unknown): boolean => {
  if (!isPlain(e)) return false
  return exact(e, Object.hasOwn(e, 'blocked') ? ['agent', 'at', 'blocked'] : ['agent', 'at']) &&
    str(e.agent, 130) && num(e.at) && (!Object.hasOwn(e, 'blocked') || e.blocked === true)
}
const lastReport = (x: unknown): boolean => exact(x, ['path', 'at']) && str(x.path, 120) && num(x.at)
const STATE_KEYS = ['swarm', 'session', 'agents', 'byName', 'links', 'memory', 'tasks', 'feed', 'edits', 'spend', 'events', 'lastAt', 'gaps', 'budget', 'guard']
```

`OPTIONAL_AGENT_KEYS = ['guard', 'route', 'stuckBy']` and add to `agent`: `&& (!Object.hasOwn(x, 'stuckBy') || stuckRec(x.stuckBy))`.

In `isSwarmState`, replace the first `exact(...)` with
`exact(x, isPlain(x) && Object.hasOwn(x, 'lastReport') ? [...STATE_KEYS, 'lastReport'] : STATE_KEYS)`,
the edits check with `record(x.edits, v => list(v, MAX_EDITS, editRec))`, and append
`&& (!Object.hasOwn(x, 'lastReport') || lastReport(x.lastReport))`.

- [ ] **Step 6: Stats**

In `src/core/stats.ts`:

```ts
export type Clash = { path: string; agents: string[]; blocked: boolean }
```

In `fileClashes`, push `{ path, agents: [...agents].sort(), blocked: edits.at(-1)?.blocked === true }` (the latest edit on the path was refused).

`AgentStats` gains `blockedClashes: string[]` (after `clashes`), filled with
`clashes.filter(c => c.blocked && c.agents.includes(a.id)).map(c => c.path)`.

`stuck` becomes `a.outcome === null && (a.errorsInRow >= STUCK_AFTER || a.stuckBy?.on === true)`.

Run `npm run typecheck` and fix any literal `Clash`/`AgentStats` objects in tests or render code the compiler names (add `blocked: false` / `blockedClashes: []`).

- [ ] **Step 7: Run the fold tests**

Run: `node --test tests/core/fold-clash-stuck.test.ts tests/core/fold.test.ts tests/core/stats.test.ts tests/core/state-check.test.ts`
Expected: PASS. If an existing `fileClashes` deepEqual fails only for the new `blocked: false`, update that expectation.

- [ ] **Step 8: Write the failing record-tool tests**

Append to `tests/mcp/record.test.ts` (uses the file's `setup`, `SID`, `TS`, `SWARM`):

```ts
test('clash.blocked and agent.stuck are recorded with an agent, and refused without one or with bad data', () => {
  const { call, events } = setup()
  call({ sessionId: SID, ts: TS, type: 'clash.blocked', agent: 'a2', data: { path: 'src/x.ts', holder: 'a1', mode: 'block' } })
  call({ sessionId: SID, ts: TS, type: 'agent.stuck', agent: 'a2', data: { pattern: 'repeating', count: 4, subject: 'npm test', delivered: false, reason: 'gone' } })
  const got = events(SWARM).slice(-2)
  assert.deepEqual(got.map(e => [e.type, e.agent, e.data]), [
    ['clash.blocked', 'a2', { path: 'src/x.ts', holder: 'a1', mode: 'block' }],
    ['agent.stuck', 'a2', { pattern: 'repeating', count: 4, subject: 'npm test', delivered: false, reason: 'gone' }],
  ])
  const bad = [
    { type: 'clash.blocked', data: { path: 'src/x.ts', holder: 'a1', mode: 'block' } },
    { type: 'clash.blocked', agent: 'a2', data: { path: '', holder: 'a1', mode: 'block' } },
    { type: 'clash.blocked', agent: 'a2', data: { path: 'x', holder: 'a 1', mode: 'block' } },
    { type: 'clash.blocked', agent: 'a2', data: { path: 'x', holder: 'a1', mode: 'off' } },
    { type: 'agent.stuck', data: { pattern: 'failing', count: 5, subject: 'x', delivered: true } },
    { type: 'agent.stuck', agent: 'a2', data: { pattern: 'looping', count: 5, subject: 'x', delivered: true } },
    { type: 'agent.stuck', agent: 'a2', data: { pattern: 'failing', count: 5, subject: 'x' } },
    { type: 'agent.stuck', agent: 'a2', data: { pattern: 'failing', count: -1, subject: 'x', delivered: true } },
  ]
  for (const b of bad) assert.throws(() => call({ sessionId: SID, ts: TS, ...b }), InputError, JSON.stringify(b))
})

test('report.written is the server\'s own event: omnis_record refuses it', () => {
  const { call } = setup()
  assert.throws(() => call({ sessionId: SID, ts: TS, type: 'report.written', data: { path: 'x', agents: 1, minutes: 1, costUsd: 1 } }), InputError)
})
```

- [ ] **Step 9: Validate the two events in omnis_record**

`src/core/recording.ts`:

```ts
export const RECORDER_TYPES = ['agent.started', 'agent.finished', 'agent.usage', 'agent.tool', 'message.sent', 'session.measure', 'budget.set', 'guard.warned', 'guard.nudged', 'guard.blocked', 'clash.blocked', 'agent.stuck'] as const

/** The internal tool that writes a run report. */
export const REPORT_TOOL = 'omnis_report'

export const INTERNAL_TOOL = /^mcp__.+__omnis_(record|feed|replay|export|report)$/
```

(Update the `INTERNAL_TOOL` doc comment's tool list too.)

`src/mcp/tools/record.ts`: import `CLASH_MODES, STUCK_PATTERNS` from events, add two cases to `dataFor`:

```ts
    case 'clash.blocked':
      return { path: text(d, 'path', LIMITS.subject, true), holder: agentName(d, 'holder'), mode: oneOf(d, 'mode', CLASH_MODES) }
    case 'agent.stuck': {
      if (typeof d.delivered !== 'boolean') throw new InputError('data.delivered must be true or false')
      return {
        pattern: oneOf(d, 'pattern', STUCK_PATTERNS), count: count(d, 'count', 1000), subject: text(d, 'subject', LIMITS.subject),
        delivered: d.delivered, ...(d.reason !== undefined && { reason: text(d, 'reason', LIMITS.reason) }),
      }
    }
```

and in the handler, change `agentLevel` to
`const agentLevel = type === 'guard.nudged' || type === 'clash.blocked' || type === 'agent.stuck' || (type === 'guard.warned' && (data as EventData['guard.warned']).limit !== 'swarmCost')`
with the error message `` `${type} needs agent` `` when it's one of the two new types (keep the existing message for guard events).

- [ ] **Step 10: Guard text and test**

`src/mod/guard.ts` `DENY_REASON`:
`'omnis_record, omnis_feed, omnis_replay, omnis_export and omnis_report are internal to the omnis-swarm plugin and only its own hooks may call them. Use the public omnis_* tools instead.'`

`src/mod/guard.test.ts`: add `const REPORT = 'mcp__plugin_omnis-swarm_omnis-swarm__omnis_report'` and put it in the first test's list.

- [ ] **Step 11: The agent-name helper and its kit test**

Create `src/mod/agent-name.ts`:

```ts
/** What a person calls an agent in a message: its name, else its task description, else its id. The lead is main. */
import type { EngineInterface } from 'claude-code'
import { cleanText } from './record-events.ts'

export async function agentLabel($: EngineInterface, id: string | null): Promise<string> {
  if (id === null) return 'main'
  try {
    const found = (await $.agent.list()).find(a => a.id === id)
    return cleanText(found?.name, 64) || cleanText(found?.description, 64) || cleanText(id, 64)
  } catch {
    return cleanText(id, 64)
  }
}
```

Create `src/mod/agent-name.test.ts`. The kit gives no plugin-free way to call the helper, so it rides on a throwaway command registered by a test plugin:

```ts
import { expect, test } from 'claude-code/testing'
import { agentLabel } from './agent-name.ts'
import { KIT } from './test-engine.ts'

const AGENTS = [
  { id: 'a1', name: 'coder-1', description: 'fix the parser', type: 'coder' },
  { id: 'a2', name: '', description: 'write the docs', type: 'writer' },
  { id: 'a3', name: '', description: '', type: 'agent' },
]

test('names an agent by name, then description, then id, and the lead as main', {
  ...KIT,
  plugins: [{
    name: 'probe',
    register(on) {
      on('session.start', async ($, e, next) => {
        const result = await next(e)
        const labels = await Promise.all([null, 'a1', 'a2', 'a3', 'a9'].map(id => agentLabel($, id)))
        $.ui.status(labels.join('|'))
        return result
      })
    },
  }],
}, async ($, on) => {
  const statuses: string[] = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('agent.list', () => ({ value: AGENTS as never }))
  on('ui.status', (_$, e) => {
    statuses.push(String(e.text))
    return { value: undefined }
  })
  await $.session.start({ cwd: '/p', surface: null, isInteractive: false })
  expect(statuses).toContain('main|coder-1|write the docs|a3|a9')
})
```

(If the kit's `ui.status` input names its text differently, copy how `src/mod/guard.test.ts`'s "another plugin is refused too" test reads it.)

- [ ] **Step 12: Document the events**

In `docs/event-log.md`, add three rows after `guard.blocked` in the events table, same column layout:

```
| `clash.blocked` | recorder | `path` (≤80, the recorder's subject for the refused call), `holder` (the holding agent's id), `mode` (`block`\|`warn`). `agent` (the refused or warned agent) is required. Repeats for the same agent and path within 60 s are not recorded |
| `agent.stuck` | recorder | `pattern` (`failing`\|`repeating`), `count`, `subject` (≤80), `delivered` (bool), `reason?` (≤80). `agent` is required |
| `report.written` | mcp | `path` (the report file, relative to the project), `agents` (subagents), `minutes`, `costUsd`. Written by `omnis_report` and `omnis_swarm_end` |
```

- [ ] **Step 13: Gate and commit**

Run the gate (Global Constraints). Expected: all green.

```bash
git add src/core src/mcp/tools/record.ts src/mod/guard.ts src/mod/guard.test.ts src/mod/agent-name.ts src/mod/agent-name.test.ts tests docs/event-log.md
git commit -m "Add the clash, stuck and report events and fold them"
```

---

### Task 2: Clash guard

**Files:**
- Create: `src/mod/holds.ts`, `tests/mod/holds.test.ts`, `src/mod/clash-guard.ts`, `src/mod/clash-guard.test.ts`
- Modify: `src/mod/register.ts`

**Interfaces:**
- Consumes (Task 1): `CLASH_MODES`, `RecordBody<'clash.blocked'>`, `agentLabel`, `record($, body)` from `./recorder.ts`, `toolSubject`, `cleanPath` from `./record-events.ts`.
- Produces: `registerClashGuard(on: On, options: PluginOptions): void`; from holds.ts `HOLD_IDLE_MS`, `BLOCK_DEDUPE_MS`, `clashSettingFrom`, `normalisePath`, `Holds`.

- [ ] **Step 1: Write the failing pure tests**

Create `tests/mod/holds.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BLOCK_DEDUPE_MS, HOLD_IDLE_MS, Holds, clashSettingFrom, normalisePath } from '../../src/mod/holds.ts'

test('paths resolve against the cwd, use / and fold case only under a drive letter', () => {
  assert.deepEqual(normalisePath('src\\x.ts', 'C:\\proj'), { key: 'c:/proj/src/x.ts', shown: 'src/x.ts' })
  assert.deepEqual(normalisePath('C:/Proj/SRC/x.ts', 'c:\\proj'), { key: 'c:/proj/src/x.ts', shown: 'SRC/x.ts' })
  assert.deepEqual(normalisePath('/home/me/p/src/X.ts', '/home/me/p'), { key: '/home/me/p/src/X.ts', shown: 'src/X.ts' })
  assert.deepEqual(normalisePath('./a/../b//c.ts', '/p'), { key: '/p/b/c.ts', shown: 'b/c.ts' })
  assert.deepEqual(normalisePath('/elsewhere/c.ts', '/p'), { key: '/elsewhere/c.ts', shown: '/elsewhere/c.ts' })
  assert.equal(normalisePath('', '/p'), null)
  assert.equal(normalisePath(42, '/p'), null)
})

test('a long shown path is cut from the left to 80', () => {
  const shown = normalisePath(`${'d/'.repeat(60)}file.ts`, '/p')!.shown
  assert.equal(shown.length, 80)
  assert.ok(shown.startsWith('…') && shown.endsWith('/file.ts'))
})

test('the setting reads block, warn or off, and anything else as block', () => {
  assert.equal(clashSettingFrom('warn'), 'warn')
  assert.equal(clashSettingFrom('off'), 'off')
  for (const x of ['block', undefined, 'WARN', 3]) assert.equal(clashSettingFrom(x), 'block')
})

test('the first subagent takes the hold, another clashes, the holder does not, the lead never holds', () => {
  const h = new Holds()
  assert.equal(h.clashWith('/p/x', 'a1', 0), null)
  h.take('/p/x', 'a1', 0)
  assert.equal(h.clashWith('/p/x', 'a2', 1), 'a1')
  assert.equal(h.clashWith('/p/x', null, 1), 'a1')
  assert.equal(h.clashWith('/p/x', 'a1', 1), null)
  h.take('/p/y', null, 0)
  assert.equal(h.clashWith('/p/y', 'a2', 1), null)
})

test('a hold ends when its holder finishes or goes idle for HOLD_IDLE_MS, and an edit keeps it alive', () => {
  const h = new Holds()
  h.take('/p/x', 'a1', 0)
  h.take('/p/x', 'a1', HOLD_IDLE_MS - 1)
  assert.equal(h.clashWith('/p/x', 'a2', 2 * HOLD_IDLE_MS - 2), 'a1')
  assert.equal(h.clashWith('/p/x', 'a2', 2 * HOLD_IDLE_MS - 1), null)
  h.take('/p/z', 'a1', 0)
  h.releaseAll('a1')
  assert.equal(h.clashWith('/p/z', 'a2', 1), null)
})

test('take never overwrites another live holder', () => {
  const h = new Holds()
  h.take('/p/x', 'a1', 0)
  h.take('/p/x', 'a2', 1)
  assert.equal(h.clashWith('/p/x', 'a2', 2), 'a1')
})

test('a refusal is recorded once per agent and path in BLOCK_DEDUPE_MS', () => {
  const h = new Holds()
  assert.equal(h.shouldRecord('a2', '/p/x', 0), true)
  assert.equal(h.shouldRecord('a2', '/p/x', BLOCK_DEDUPE_MS - 1), false)
  assert.equal(h.shouldRecord('a3', '/p/x', 1), true)
  assert.equal(h.shouldRecord('a2', '/p/x', BLOCK_DEDUPE_MS), true)
})
```

- [ ] **Step 2: Run, see it fail**

Run: `node --test tests/mod/holds.test.ts` → FAIL (module missing).

- [ ] **Step 3: Write holds.ts**

```ts
/** The clash guard's file holds (spec section 2.1). Pure and mod-safe; node:test covers it. */
import { cleanPath } from './record-events.ts'

export const HOLD_IDLE_MS = 600_000
export const BLOCK_DEDUPE_MS = 60_000
const SHOWN_MAX = 80
/** Past this many holds, idle ones are swept on the next take. */
const SWEEP_AT = 256

export const CLASH_SETTINGS = ['block', 'warn', 'off'] as const
export type ClashSetting = (typeof CLASH_SETTINGS)[number]
export const clashSettingFrom = (x: unknown): ClashSetting => (x === 'warn' || x === 'off' ? x : 'block')

export type FilePath = { key: string; shown: string }
const DRIVE = /^[A-Za-z]:\//
const ABSOLUTE = /^([A-Za-z]:\/|\/)/

/** Drops `.`, empty segments and `..` (never above the root), keeping `/`, `C:/` or `//server/`. */
function squash(p: string): string {
  const m = /^([A-Za-z]:\/|\/\/[^/]+\/|\/)?(.*)$/.exec(p)!
  const out: string[] = []
  for (const part of (m[2] ?? '').split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return (m[1] ?? '') + out.join('/')
}

/**
 * The path a file tool names, as a hold key and as shown to a person. Relative paths resolve against the cwd, `\` becomes
 * `/`, and the key folds case when the cwd has a drive letter (the mod can't read process.platform).
 */
export function normalisePath(raw: unknown, cwd: string): FilePath | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const base = squash(cwd.replace(/\\/g, '/'))
  const p = raw.trim().replace(/\\/g, '/')
  const full = squash(ABSOLUTE.test(p) ? p : `${base}/${p}`)
  const fold = DRIVE.test(base)
  const key = fold ? full.toLowerCase() : full
  const baseKey = fold ? base.toLowerCase() : base
  const prefix = baseKey.endsWith('/') ? baseKey : `${baseKey}/`
  const inside = key.startsWith(prefix) && key.length > prefix.length
  return { key, shown: cleanPath(inside ? full.slice(prefix.length) : full, SHOWN_MAX) }
}

type Hold = { holder: string; lastAt: number }

export class Holds {
  #holds = new Map<string, Hold>()
  #told = new Map<string, number>()

  /** The live holder of `key`; an idle hold is let go first. */
  #holderOf(key: string, now: number): string | null {
    const h = this.#holds.get(key)
    if (h === undefined) return null
    if (now - h.lastAt >= HOLD_IDLE_MS) {
      this.#holds.delete(key)
      return null
    }
    return h.holder
  }

  /** The live holder `agent` would clash with by editing `key` (null for the lead), or null. */
  clashWith(key: string, agent: string | null, now: number): string | null {
    const holder = this.#holderOf(key, now)
    return holder !== null && holder !== agent ? holder : null
  }

  /** A subagent's edit went ahead: take the hold, or refresh its own. The lead never holds, and another live holder keeps it. */
  take(key: string, agent: string | null, now: number): void {
    if (agent === null) return
    const holder = this.#holderOf(key, now)
    if (holder !== null && holder !== agent) return
    if (this.#holds.size >= SWEEP_AT) for (const k of [...this.#holds.keys()]) this.#holderOf(k, now)
    this.#holds.set(key, { holder: agent, lastAt: now })
  }

  /** The holder finished: every hold it had ends. */
  releaseAll(agent: string): void {
    for (const [k, h] of this.#holds) if (h.holder === agent) this.#holds.delete(k)
  }

  /** True at most once per agent and path in BLOCK_DEDUPE_MS: whether this refusal or warning is recorded. */
  shouldRecord(agent: string, key: string, now: number): boolean {
    for (const [k, t] of this.#told) if (now - t >= BLOCK_DEDUPE_MS) this.#told.delete(k)
    const id = `${agent}\n${key}`
    if (this.#told.has(id)) return false
    this.#told.set(id, now)
    return true
  }
}
```

- [ ] **Step 4: Run the pure tests**

Run: `node --test tests/mod/holds.test.ts` → PASS.

- [ ] **Step 5: Write the failing kit tests**

Create `src/mod/clash-guard.test.ts`:

```ts
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { KIT } from './test-engine.ts'

const SID = 'abcdef12-3456-7890-abcd-ef1234567890'
const T0 = Date.parse('2026-10-23T10:00:00.000Z')
const REFUSED = 'coder-1 is editing src/x.ts. Message them, or wait until they finish.'
type Seen = { records: Array<{ type: string; agent?: string; data: Record<string, unknown> }>; readonly appends: string[]; beneath: 'allow' | 'deny' }

function engine(on: On): Seen {
  const session = mock.session(on)
  const seen: Seen = { records: [], beneath: 'allow', get appends() { return session.appended().map(row => JSON.stringify(row.message)) } }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SID }))
  on('session.cwd', () => ({ value: '/p' }))
  on('state.get', () => ({ value: { value: undefined, version: 0 } }))
  on('state.set', () => ({ value: { isSet: true as const, version: 1 } }))
  on('agent.list', () => ({ value: [{ id: 'a1', name: 'coder-1', description: '', type: 'coder' }, { id: 'a2', name: 'coder-2', description: '', type: 'coder' }] as never }))
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'plugin:omnis-swarm:omnis-swarm' } }))
  on('mcp.call', (_$, e) => {
    const a = e.args as { type: string; agent?: string; data: Record<string, unknown> }
    seen.records.push({ type: a.type, ...(a.agent !== undefined && { agent: a.agent }), data: a.data })
    return { value: { content: [{ type: 'text', text: 'ok s1' }], isError: false } }
  })
  on('tool.check', () => ({ decision: seen.beneath }))
  on('turn.complete', () => ({ text: '' }))
  return seen
}

async function boot($: Engine, on: On) {
  const clock = mock.clock(on, { now: T0 })
  const seen = engine(on)
  await $.session.start({ cwd: '/p', surface: null, isInteractive: false })
  await clock.settle()
  return { clock, seen }
}

let n = 0
const editAs = ($: Engine, agentId: string | undefined, file: string, tool = 'Edit') =>
  $.tool.check({ tool, input: tool === 'NotebookEdit' ? { notebook_path: file } : { file_path: file }, tool_use_id: `toolu_${++n}`, ...(agentId !== undefined && { agentId }) } as never)
const finish = ($: Engine, agentId: string) => $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: `t${++n}`, agentId, reason: 'answer' })
const clashes = (seen: Seen) => seen.records.filter(r => r.type === 'clash.blocked')

test('a second subagent editing a held file is refused with the holder named, and one event is recorded', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  expect((await editAs($, 'a1', 'src/x.ts')).decision).toBe('allow')
  const refused = await editAs($, 'a2', '/p/src/x.ts', 'Write')
  expect(refused).toEqual({ decision: 'deny', reason: REFUSED })
  await editAs($, 'a2', 'src/x.ts')
  await clock.settle()
  expect(clashes(seen)).toEqual([{ type: 'clash.blocked', agent: 'a2', data: { path: '/p/src/x.ts', holder: 'a1', mode: 'block' } }])
})

test('the holder keeps editing, the lead is refused but never holds, and a finished holder lets go', KIT, async ($, on) => {
  const { seen } = await boot($, on)
  await editAs($, 'a1', 'src/x.ts')
  expect((await editAs($, 'a1', 'src/x.ts')).decision).toBe('allow')
  expect((await editAs($, undefined, 'src/x.ts')).decision).toBe('deny')
  expect((await editAs($, undefined, 'src/lead.ts')).decision).toBe('allow')
  expect((await editAs($, 'a2', 'src/lead.ts')).decision).toBe('allow')
  await finish($, 'a1')
  expect((await editAs($, 'a2', 'src/x.ts')).decision).toBe('allow')
  expect(seen.records.filter(r => r.type === 'clash.blocked').length).toBe(1)
})

test('a hold lapses after 10 idle minutes', KIT, async ($, on) => {
  const { clock } = await boot($, on)
  await editAs($, 'a1', 'src/x.nb', 'NotebookEdit')
  await clock.advance(9 * 60_000)
  expect((await editAs($, 'a2', 'src/x.nb', 'NotebookEdit')).decision).toBe('deny')
  await clock.advance(60_000)
  expect((await editAs($, 'a2', 'src/x.nb', 'NotebookEdit')).decision).toBe('allow')
})

test('an edit the engine refuses takes no hold', KIT, async ($, on) => {
  const { seen } = await boot($, on)
  seen.beneath = 'deny'
  await editAs($, 'a1', 'src/x.ts')
  seen.beneath = 'allow'
  expect((await editAs($, 'a2', 'src/x.ts')).decision).toBe('allow')
})

test('warn lets the edit through and tells the lead', { ...KIT, options: { clashGuard: 'warn' } }, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await editAs($, 'a1', 'src/x.ts')
  expect((await editAs($, 'a2', 'src/x.ts')).decision).toBe('allow')
  await clock.settle()
  expect(seen.appends.some(a => a.includes('[OmnisSwarm clash guard] coder-2 edited src/x.ts while coder-1 holds it.'))).toBe(true)
  expect(clashes(seen).map(r => r.data.mode)).toEqual(['warn'])
})

test('off keeps no holds', { ...KIT, options: { clashGuard: 'off' } }, async ($, on) => {
  const { seen } = await boot($, on)
  await editAs($, 'a1', 'src/x.ts')
  expect((await editAs($, 'a2', 'src/x.ts')).decision).toBe('allow')
  expect(clashes(seen)).toEqual([])
})

test('other tools and a query without a call id are left alone', KIT, async ($, on) => {
  await boot($, on)
  await editAs($, 'a1', 'src/x.ts')
  expect((await $.tool.check({ tool: 'Read', input: { file_path: 'src/x.ts' }, tool_use_id: 'toolu_r', agentId: 'a2' } as never)).decision).toBe('allow')
  expect((await $.tool.check({ tool: 'Edit', input: { file_path: 'src/x.ts' } })).decision).toBe('allow')
})
```

If the kit answers `$.session.cwd()` from `session.start`'s `cwd` without a `session.cwd` hook, keep the stub anyway (it is harmless); if the kit rejects an unknown hook name, find the right one in `types/claude-code/index.d.ts` (search `cwd: () => Promise<string>`).

- [ ] **Step 6: Run, see them fail**

Run: `npm run test:mod 2>&1 | tail -40` → the clash-guard tests FAIL (edits all allowed).

- [ ] **Step 7: Write clash-guard.ts**

```ts
/**
 * The clash guard (spec section 2): a subagent that edits a file holds it until it finishes or goes idle, and another
 * agent's edit of a held file is refused (block), let through with a word to the lead (warn), or not checked (off).
 * tool.check runs after every tool.call hook, so the recorder has already recorded the refused call's start; the
 * clash.blocked event marks it. A failure in here fails open.
 */
import type { EngineInterface, On, PluginOptions } from 'claude-code'
import { LEAD } from '../core/fold.ts'
import { agentLabel } from './agent-name.ts'
import { Holds, clashSettingFrom, normalisePath, type ClashSetting } from './holds.ts'
import { toolSubject, type Fields } from './record-events.ts'
import { record } from './recorder.ts'

const CLASH_TOOLS = ['Edit', 'Write', 'NotebookEdit']

export const refusalText = (holder: string, path: string): string => `${holder} is editing ${path}. Message them, or wait until they finish.`
export const warnText = (agent: string, path: string, holder: string): string =>
  `[OmnisSwarm clash guard] ${agent} edited ${path} while ${holder} holds it.`

/** Module state; a hot reload drops every hold, which is safe: the next edit takes a fresh one. */
let holds = new Holds()
let setting: ClashSetting = 'block'

type Look = { key: string; shown: string; subject: string; agent: string | null; holder: string | null; now: number }

/** What a real file-tool call is about, or null when it isn't the guard's business. */
async function look($: EngineInterface, e: { tool: string; input: unknown; tool_use_id?: string; agentId?: string }): Promise<Look | null> {
  if (e.tool_use_id === undefined) return null
  const input = (typeof e.input === 'object' && e.input !== null ? e.input : {}) as Fields
  const path = normalisePath(input.file_path ?? input.notebook_path, await $.session.cwd())
  if (path === null) return null
  const now = await $.clock.now()
  const agent = e.agentId ?? null
  return { ...path, subject: toolSubject(e.tool, input), agent, holder: holds.clashWith(path.key, agent, now), now }
}

/** Records the clash (once a minute per agent and path) and answers the refusal, or null in warn mode after telling the lead. */
async function clashed($: EngineInterface, l: Look, holder: string): Promise<{ decision: 'deny'; reason: string } | null> {
  const [holderName, agentName] = await Promise.all([agentLabel($, holder), agentLabel($, l.agent)])
  const who = l.agent ?? LEAD
  if (holds.shouldRecord(who, l.key, l.now)) {
    void record($, { type: 'clash.blocked', agent: who, data: { path: l.subject || l.shown, holder, mode: setting === 'warn' ? 'warn' : 'block' } })
  }
  if (setting !== 'warn') return { decision: 'deny', reason: refusalText(holderName, l.shown) }
  void $.session.append({ message: { type: 'user', content: [{ type: 'text', text: warnText(agentName, l.shown, holderName) }] } }).catch(() => undefined)
  return null
}

export function registerClashGuard(on: On, options: PluginOptions): void {
  holds = new Holds()
  setting = clashSettingFrom((options as Readonly<Record<string, unknown>>).clashGuard)
  if (setting === 'off') return

  on('tool.check', { tool: CLASH_TOOLS }, async ($, e, next) => {
    const l = await look($, e)
    if (l !== null && l.holder !== null) {
      const refused = await clashed($, l, l.holder)
      if (refused !== null) return refused
    }
    const result = await next(e)
    if (l !== null && result.decision !== 'deny') holds.take(l.key, l.agent, l.now)
    return result
  }).catch((_$, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) holds.releaseAll(e.agentId)
    return result
  })
}
```

Then `src/mod/register.ts`: `import { registerClashGuard } from './clash-guard.ts'` and `registerClashGuard(on, options)` after `registerBudgetGuard(on, options)`.

- [ ] **Step 8: Run the kit tests**

Run: `npm run test:mod 2>&1 | tail -40` → PASS.

- [ ] **Step 9: Gate and commit**

```bash
git add src/mod/holds.ts tests/mod/holds.test.ts src/mod/clash-guard.ts src/mod/clash-guard.test.ts src/mod/register.ts
git commit -m "Refuse an edit to a file another agent is editing"
```

---

### Task 3: Stuck nudges

**Files:**
- Create: `src/mod/stuck.ts`, `tests/mod/stuck.test.ts`, `src/mod/stuck-guard.ts`, `src/mod/stuck-guard.test.ts`
- Modify: `src/mod/register.ts`

**Interfaces:**
- Consumes (Task 1): `StuckPattern`, `RecordBody<'agent.stuck'>`, `agentLabel`, `INTERNAL_TOOL`; `record` from `./recorder.ts`; `toolKind`, `toolSubject`, `cleanText` from `./record-events.ts`.
- Produces: `registerStuckGuard(on: On): void`; from stuck.ts `STUCK_NUDGE_AFTER`, `REPEAT_NUDGE_AFTER`, `StuckWatch`, `nudgeFor(hit)`, `stuckMainText(name, pattern, delivered, reason?)`.

- [ ] **Step 1: Write the failing pure tests**

Create `tests/mod/stuck.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { REPEAT_NUDGE_AFTER, STUCK_NUDGE_AFTER, StuckWatch, nudgeFor, stuckMainText } from '../../src/mod/stuck.ts'

test('five failed calls in a row is one failing hit; a success re-arms it', () => {
  const w = new StuckWatch()
  for (let i = 1; i < STUCK_NUDGE_AFTER; i++) assert.equal(w.end('a1', 'Bash', 'npm test', true), null)
  assert.deepEqual(w.end('a1', 'Bash', 'npm test', true), { pattern: 'failing', count: 5, tool: 'Bash', subject: 'npm test' })
  assert.equal(w.end('a1', 'Bash', 'npm test', true), null)
  w.end('a1', 'Bash', 'npm test', false)
  for (let i = 1; i < STUCK_NUDGE_AFTER; i++) w.end('a1', 'Bash', 'x', true)
  assert.equal(w.end('a1', 'Bash', 'x', true)?.pattern, 'failing')
})

test('an edit start re-arms failing and starts the count again', () => {
  const w = new StuckWatch()
  for (let i = 0; i < STUCK_NUDGE_AFTER; i++) w.end('a1', 'Bash', 'x', true)
  w.start('a1', 'Edit', 'edit', 'src/a.ts')
  for (let i = 1; i < STUCK_NUDGE_AFTER; i++) assert.equal(w.end('a1', 'Bash', 'x', true), null)
  assert.equal(w.end('a1', 'Bash', 'x', true)?.count, 5)
})

test('four starts of the same tool on the same subject is one repeating hit', () => {
  const w = new StuckWatch()
  for (let i = 1; i < REPEAT_NUDGE_AFTER; i++) assert.equal(w.start('a1', 'Bash', 'bash', 'npm test'), null)
  assert.deepEqual(w.start('a1', 'Bash', 'bash', 'npm test'), { pattern: 'repeating', count: 4, tool: 'Bash', subject: 'npm test' })
  assert.equal(w.start('a1', 'Bash', 'bash', 'npm test'), null)
})

test('another subject or tool, or an edit, breaks the run and re-arms it', () => {
  const w = new StuckWatch()
  for (let i = 0; i < 3; i++) w.start('a1', 'Read', 'read', 'a.ts')
  w.start('a1', 'Grep', 'search', 'a.ts')
  for (let i = 0; i < 3; i++) assert.equal(w.start('a1', 'Read', 'read', 'a.ts'), null)
  w.start('a1', 'Edit', 'edit', 'a.ts')
  for (let i = 0; i < 3; i++) assert.equal(w.start('a1', 'Read', 'read', 'a.ts'), null)
  assert.equal(w.start('a1', 'Read', 'read', 'a.ts')?.pattern, 'repeating')
})

test('agent and other kinds, and empty subjects, never repeat', () => {
  const w = new StuckWatch()
  for (let i = 0; i < 6; i++) {
    assert.equal(w.start('a1', 'SendMessage', 'agent', 'main'), null)
    assert.equal(w.start('a2', 'TodoWrite', 'other', ''), null)
    assert.equal(w.start('a3', 'Bash', 'bash', ''), null)
  }
})

test('agents are tracked apart, and forget drops one', () => {
  const w = new StuckWatch()
  for (let i = 0; i < 4; i++) w.end('a1', 'Bash', 'x', true)
  assert.equal(w.end('a2', 'Bash', 'x', true), null)
  w.forget('a1')
  assert.equal(w.end('a1', 'Bash', 'x', true), null)
})

test('the words', () => {
  assert.equal(nudgeFor({ pattern: 'failing', count: 5, tool: 'Bash', subject: 'npm test' }),
    "Your last 5 tool calls failed. Step back and try another approach, or report to main what's blocking you.")
  assert.equal(nudgeFor({ pattern: 'repeating', count: 4, tool: 'Bash', subject: 'npm test' }),
    "You've run Bash on npm test 4 times with no change in between. Step back and try another approach, or report to main.")
  assert.equal(stuckMainText('coder-1', 'failing', true), '[OmnisSwarm] coder-1 looks stuck (failing) and was asked to step back.')
  assert.equal(stuckMainText('coder-1', 'repeating', false, 'gone'), '[OmnisSwarm] coder-1 looks stuck (repeating) and was asked to step back. The message was not delivered: gone.')
  assert.equal(stuckMainText('coder-1', 'repeating', false), '[OmnisSwarm] coder-1 looks stuck (repeating) and was asked to step back. The message was not delivered.')
})
```

- [ ] **Step 2: Run, see it fail**

Run: `node --test tests/mod/stuck.test.ts` → FAIL.

- [ ] **Step 3: Write stuck.ts**

```ts
/** The stuck guard's two patterns (spec section 3). Pure and mod-safe; node:test covers it. */
import type { StuckPattern, ToolKind } from '../core/events.ts'

export const STUCK_NUDGE_AFTER = 5
export const REPEAT_NUDGE_AFTER = 4
/** Re-reading, re-running, re-searching, re-fetching. Messages and other tools are not a loop. */
const REPEAT_KINDS: readonly ToolKind[] = ['read', 'bash', 'search', 'web']
/** At most this many agents are tracked; the oldest is dropped. */
const MAX_AGENTS = 500

export type StuckHit = { pattern: StuckPattern; count: number; tool: string; subject: string }

type Track = { failing: number; failFired: boolean; repeatKey: string | null; repeats: number; repeatFired: boolean }

export class StuckWatch {
  #agents = new Map<string, Track>()

  #track(agent: string): Track {
    let t = this.#agents.get(agent)
    if (t === undefined) {
      if (this.#agents.size >= MAX_AGENTS) this.#agents.delete(this.#agents.keys().next().value!)
      t = { failing: 0, failFired: false, repeatKey: null, repeats: 0, repeatFired: false }
      this.#agents.set(agent, t)
    }
    return t
  }

  /** A tool call started. An edit re-arms both patterns; the same tool on the same subject again may be a repeating hit. */
  start(agent: string, tool: string, kind: ToolKind, subject: string): StuckHit | null {
    const t = this.#track(agent)
    if (kind === 'edit') {
      Object.assign(t, { failing: 0, failFired: false, repeatKey: null, repeats: 0, repeatFired: false })
      return null
    }
    const key = REPEAT_KINDS.includes(kind) && subject !== '' ? `${tool}\n${subject}` : null
    if (key === null || key !== t.repeatKey) {
      Object.assign(t, { repeatKey: key, repeats: key === null ? 0 : 1, repeatFired: false })
      return null
    }
    t.repeats++
    if (t.repeats < REPEAT_NUDGE_AFTER || t.repeatFired) return null
    t.repeatFired = true
    return { pattern: 'repeating', count: t.repeats, tool, subject }
  }

  /** A tool call ended. A success re-arms failing; the fifth failure in a row is a failing hit. */
  end(agent: string, tool: string, subject: string, isError: boolean): StuckHit | null {
    const t = this.#track(agent)
    if (!isError) {
      t.failing = 0
      t.failFired = false
      return null
    }
    t.failing++
    if (t.failing < STUCK_NUDGE_AFTER || t.failFired) return null
    t.failFired = true
    return { pattern: 'failing', count: t.failing, tool, subject }
  }

  forget(agent: string): void {
    this.#agents.delete(agent)
  }
}

export const nudgeFor = (hit: StuckHit): string =>
  hit.pattern === 'failing'
    ? `Your last ${STUCK_NUDGE_AFTER} tool calls failed. Step back and try another approach, or report to main what's blocking you.`
    : `You've run ${hit.tool} on ${hit.subject} ${REPEAT_NUDGE_AFTER} times with no change in between. Step back and try another approach, or report to main.`

export function stuckMainText(name: string, pattern: StuckPattern, delivered: boolean, reason?: string): string {
  const tail = delivered ? '' : ` The message was not delivered${reason === undefined || reason === '' ? '' : `: ${reason}`}.`
  return `[OmnisSwarm] ${name} looks stuck (${pattern}) and was asked to step back.${tail}`
}
```

- [ ] **Step 4: Run the pure tests** → PASS.

- [ ] **Step 5: Write the failing kit tests**

Create `src/mod/stuck-guard.test.ts`:

```ts
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { KIT } from './test-engine.ts'

const SID = 'abcdef12-3456-7890-abcd-ef1234567890'
type Seen = { records: Array<{ type: string; agent?: string; data: Record<string, unknown> }>; sends: Array<{ to: unknown; text: string }>; readonly appends: string[]; fail: boolean; deliver: boolean }

function engine(on: On): Seen {
  const session = mock.session(on)
  const seen: Seen = { records: [], sends: [], fail: true, deliver: true, get appends() { return session.appended().map(row => JSON.stringify(row.message)) } }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SID }))
  on('state.get', () => ({ value: { value: undefined, version: 0 } }))
  on('state.set', () => ({ value: { isSet: true as const, version: 1 } }))
  on('agent.list', () => ({ value: [{ id: 'a1', name: 'coder-1', description: '', type: 'coder' }] as never }))
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'plugin:omnis-swarm:omnis-swarm' } }))
  on('mcp.call', (_$, e) => {
    const a = e.args as { type: string; agent?: string; data: Record<string, unknown> }
    seen.records.push({ type: a.type, ...(a.agent !== undefined && { agent: a.agent }), data: a.data })
    return { value: { content: [{ type: 'text', text: 'ok s1' }], isError: false } }
  })
  on('session.send', (_$, e) => {
    seen.sends.push({ to: e.to, text: e.text })
    return seen.deliver ? { isDelivered: true } : { isDelivered: false, reason: 'No agent is reachable' }
  })
  on('tool.call', () => ({ result: { content: 'x' } as never, text: 'x', ...(seen.fail && { isError: true }) }))
  on('turn.complete', () => ({ text: '' }))
  return seen
}

async function boot($: Engine, on: On) {
  const clock = mock.clock(on, { now: Date.parse('2026-10-23T10:00:00.000Z') })
  const seen = engine(on)
  await $.session.start({ cwd: '/p', surface: null, isInteractive: false })
  await clock.settle()
  return { clock, seen }
}

let n = 0
const run = ($: Engine, tool: string, args: Record<string, unknown>, agentId?: string) =>
  $.tool.call({ tool, tool_use_id: `toolu_${++n}`, ...args, ...(agentId !== undefined && { agentId }) } as never)
const stuck = (seen: Seen) => seen.records.filter(r => r.type === 'agent.stuck')

test('five failures in a row: one nudge, a line to main and agent.stuck', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  for (let i = 0; i < 6; i++) await run($, 'Bash', { command: `try ${i}` }, 'a1')
  await clock.settle()
  expect(seen.sends).toEqual([{ to: 'a1', text: "Your last 5 tool calls failed. Step back and try another approach, or report to main what's blocking you." }])
  expect(seen.appends.some(a => a.includes('[OmnisSwarm] coder-1 looks stuck (failing) and was asked to step back.'))).toBe(true)
  expect(stuck(seen)).toEqual([{ type: 'agent.stuck', agent: 'a1', data: { pattern: 'failing', count: 5, subject: 'try 4', delivered: true } }])
})

test('the same read four times with no edit: a repeating nudge, once, until an edit re-arms it', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  seen.fail = false
  for (let i = 0; i < 5; i++) await run($, 'Read', { file_path: 'src/a.ts' }, 'a1')
  await clock.settle()
  expect(seen.sends.map(s => s.text)).toEqual(["You've run Read on src/a.ts 4 times with no change in between. Step back and try another approach, or report to main."])
  await run($, 'Edit', { file_path: 'src/a.ts' }, 'a1')
  for (let i = 0; i < 4; i++) await run($, 'Read', { file_path: 'src/a.ts' }, 'a1')
  await clock.settle()
  expect(seen.sends.length).toBe(2)
})

test('a nudge that is not delivered says so to main and in the event', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  seen.deliver = false
  for (let i = 0; i < 5; i++) await run($, 'Bash', { command: 'x' }, 'a1')
  await clock.settle()
  expect(seen.appends.some(a => a.includes('The message was not delivered: No agent is reachable.'))).toBe(true)
  expect(stuck(seen)[0]!.data).toEqual({ pattern: 'failing', count: 5, subject: 'x', delivered: false, reason: 'No agent is reachable' })
})

test('the lead and internal tools are never nudged, and a finished agent starts over', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  for (let i = 0; i < 6; i++) await run($, 'Bash', { command: 'x' })
  for (let i = 0; i < 6; i++) await run($, 'mcp__plugin_omnis-swarm_omnis-swarm__omnis_record', {}, 'a1')
  for (let i = 0; i < 4; i++) await run($, 'Bash', { command: 'x' }, 'a1')
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', agentId: 'a1', reason: 'answer' })
  await run($, 'Bash', { command: 'x' }, 'a1')
  await clock.settle()
  expect(seen.sends).toEqual([])
})
```

- [ ] **Step 6: Run, see them fail** → `npm run test:mod` FAIL for stuck-guard tests.

- [ ] **Step 7: Write stuck-guard.ts**

```ts
/**
 * The stuck guard (spec section 3): watches each subagent's tool calls, and when one fails five times in a row or runs
 * the same thing four times with no edit in between, asks it once to step back, tells the lead and records agent.stuck.
 * Observe-only: every hook calls next once and returns its result unchanged.
 */
import type { EngineInterface, On } from 'claude-code'
import { INTERNAL_TOOL } from '../core/recording.ts'
import { agentLabel } from './agent-name.ts'
import { cleanText, toolKind, toolSubject, type Fields } from './record-events.ts'
import { record } from './recorder.ts'
import { StuckWatch, nudgeFor, stuckMainText, type StuckHit } from './stuck.ts'

/** Module state; a hot reload starts every count over. */
let watch = new StuckWatch()

async function nudge($: EngineInterface, agentId: string, hit: StuckHit): Promise<void> {
  const name = await agentLabel($, agentId)
  let delivered = false
  let reason: string | undefined
  try {
    const sent = await $.session.send({ to: { agentId }, text: nudgeFor(hit) })
    delivered = sent.isDelivered
    reason = sent.isDelivered ? undefined : cleanText(String(sent.reason ?? ''), 80) || undefined
  } catch (err) {
    reason = cleanText(err instanceof Error ? err.message : 'the send failed', 80) || undefined
  }
  void record($, { type: 'agent.stuck', agent: agentId, data: { pattern: hit.pattern, count: hit.count, subject: hit.subject, delivered, ...(reason !== undefined && { reason }) } })
  void $.session.append({ message: { type: 'user', content: [{ type: 'text', text: stuckMainText(name, hit.pattern, delivered, reason) }] } }).catch(() => undefined)
}

export function registerStuckGuard(on: On): void {
  watch = new StuckWatch()

  on('tool.call', async ($, e, next) => {
    const agent = e.agentId
    const tool = cleanText(String(e.tool), 80)
    const watched = typeof agent === 'string' && tool !== '' && !INTERNAL_TOOL.test(tool)
    let subject = ''
    if (watched) {
      try {
        subject = toolSubject(tool, e as unknown as Fields)
        const hit = watch.start(agent, tool, toolKind(tool), subject)
        if (hit !== null) void nudge($, agent, hit).catch(() => undefined)
      } catch {
        // A miscount costs a nudge, never the call.
      }
    }
    const result = await next(e)
    if (watched) {
      try {
        const hit = watch.end(agent, tool, subject, result.isError === true || result.deny !== undefined)
        if (hit !== null) void nudge($, agent, hit).catch(() => undefined)
      } catch {
        // As above.
      }
    }
    return result
  }).catch((_$, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) watch.forget(e.agentId)
    return result
  })
}
```

`src/mod/register.ts`: `import { registerStuckGuard } from './stuck-guard.ts'` and `registerStuckGuard(on)` after `registerBudgetGuard(on, options)`.

- [ ] **Step 8: Run the kit tests** → PASS.

- [ ] **Step 9: Gate and commit**

```bash
git add src/mod/stuck.ts tests/mod/stuck.test.ts src/mod/stuck-guard.ts src/mod/stuck-guard.test.ts src/mod/register.ts
git commit -m "Ask an agent that keeps failing or repeating itself to step back"
```

---

### Task 4: Report core and the omnis_report tool

**Files:**
- Create: `src/core/report.ts`, `tests/core/report.test.ts`, `src/mcp/out-file.ts`, `src/mcp/tools/report.ts`, `tests/mcp/report.test.ts`
- Modify: `src/mcp/tools/export.ts` (use out-file.ts), `src/mcp/registry.ts`, `src/mcp/tools.ts` (omnis_swarm_end), `tests/e2e/mcp-server.test.ts` (tool list), `tests/mcp/tools.test.ts` (end reply)

**Interfaces:**
- Consumes (Task 1): `SwarmState.lastReport`, edit `blocked`, `stuckBy`, `Clash.blocked`, `REPORT_TOOL`, `report.written`.
- Produces:
  - `reportMarkdown(state: SwarmState, nowMs: number, tzOffsetMin: number): string`
  - `reportSummary(state: SwarmState, nowMs: number): { agents: number; minutes: number; costUsd: number }`
  - `pointerText(path: string, s: { agents: number; minutes: number; costUsd: number }): string`
  - `stamp(d: Date): string`, `writeUnique(root: string, folder: 'exports' | 'reports', base: string, ext: '.gif' | '.md', data: string | Uint8Array): string` (out-file.ts; returns the file name)
  - `writeReport(root: string, session: Session, swarm: string, now: Date): string` (tools/report.ts; returns the pointer text, records `report.written`)
  - the `omnis_report` tool: input `{ swarm?: string }`, reply the pointer text.

- [ ] **Step 1: Write the failing report tests (golden text)**

Create `tests/core/report.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldAll, LEAD } from '../../src/core/fold.ts'
import { pointerText, reportMarkdown, reportSummary } from '../../src/core/report.ts'
import type { SwarmEvent, ToolKind } from '../../src/core/events.ts'
import { at, ev } from '../helpers.ts'

const tool = (id: string, kind: ToolKind, subject: string, atSec: number) => ev('agent.tool', { phase: 'start', tool: kind === 'edit' ? 'Edit' : 'Bash', kind, subject, isError: false }, { agent: id, atSec })
const usage = (id: string, output: number, atSec: number, requested?: string, model = 'claude-opus-5-5') =>
  ev('agent.usage', { model, input: 0, output, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...(requested !== undefined && { requested }) }, { agent: id, atSec })

function busy(): SwarmEvent[] {
  return [
    ev('swarm.started', { name: 'auth refactor', topology: 'hierarchical', implicit: false }, { atSec: 0 }),
    usage(LEAD, 10_000, 1),
    ev('agent.started', { name: 'coder-1', role: 'coder', description: '', parent: LEAD }, { agent: 'a1', atSec: 60 }),
    ev('agent.started', { name: 'coder-2', role: 'coder', description: '', parent: LEAD }, { agent: 'a2', atSec: 60 }),
    usage('a1', 50_000, 120, 'claude-opus-5-5', 'claude-sonnet-5-5'),
    usage('a2', 100_000, 130),
    tool('a1', 'edit', 'src/a.ts', 200), tool('a1', 'edit', 'src/b.ts', 210), tool('a2', 'edit', 'src/a.ts', 220),
    ev('clash.blocked', { path: 'src/a.ts', holder: 'a1', mode: 'block' }, { agent: 'a2', atSec: 220 }),
    ev('agent.stuck', { pattern: 'repeating', count: 4, subject: 'npm test', delivered: true }, { agent: 'a2', atSec: 300 }),
    ev('guard.warned', { limit: 'time', value: 20.1, threshold: 20 }, { agent: 'a2', atSec: 1260 }),
    ev('agent.finished', { outcome: 'answer' }, { agent: 'a1', atSec: 600 }),
    ev('agent.finished', { outcome: 'failed', reason: 'refusal' }, { agent: 'a2', atSec: 1320 }),
    ev('task.created', { id: 't1', title: 'Split the token module' }, { atSec: 70 }),
    ev('task.created', { id: 't2', title: 'Fix the flaky login test' }, { atSec: 71 }),
    ev('task.updated', { id: 't1', state: 'done' }, { atSec: 600 }),
    ev('task.updated', { id: 't2', state: 'failed' }, { atSec: 1320 }),
    ev('swarm.ended', { outcome: 'done' }, { atSec: 1380 }),
  ]
}

test('the report of a busy swarm', () => {
  const s = foldAll('auth-refactor', busy())
  // at(0) is the helpers' epoch; the expected times below are that epoch in UTC+60.
  const md = reportMarkdown(s, at(1400), 60)
  assert.equal(md, EXPECTED_BUSY)
})

test('a quiet swarm leaves out Problems, Routing and Tasks and says it is still running', () => {
  const s = foldAll('s1', [
    ev('swarm.started', { name: 's1', topology: 'mesh', implicit: true }, { atSec: 0 }),
    ev('agent.started', { name: 'tester', role: 'tester', description: '', parent: LEAD }, { agent: 'a1', atSec: 10 }),
  ])
  const md = reportMarkdown(s, at(130), 0)
  assert.match(md, /still running/)
  assert.doesNotMatch(md, /## Problems|## Routing|## Tasks/)
  assert.match(md, /\| tester \| tester \| running \| 2 min \|/)
})

test('a name or path with a pipe cannot break the table', () => {
  const s = foldAll('s1', [
    ev('agent.started', { name: 'a|b', role: 'coder', description: '', parent: LEAD }, { agent: 'a1', atSec: 0 }),
    tool('a1', 'edit', 'x|y.ts', 1),
  ])
  assert.match(reportMarkdown(s, at(60), 0), /\| a\\\|b \| coder \| running \| 1 min \| ≈\$0\.00 \| 0 \| x\\\|y\.ts \|/)
})

test('six files show five and +1 more', () => {
  const events: SwarmEvent[] = [ev('agent.started', { name: 'c', role: 'coder', description: '', parent: LEAD }, { agent: 'a1', atSec: 0 })]
  for (let i = 1; i <= 6; i++) events.push(tool('a1', 'edit', `f${i}.ts`, i))
  assert.match(reportMarkdown(foldAll('s1', events), at(60), 0), /f1\.ts, f2\.ts, f3\.ts, f4\.ts, f5\.ts, \+1 more \|/)
})

test('the summary and the pointer line', () => {
  const s = foldAll('auth-refactor', busy())
  const sum = reportSummary(s, at(1400))
  assert.deepEqual(sum, { agents: 2, minutes: 23, costUsd: Math.round(s.agents[LEAD]!.costUsd * 100 + s.agents.a1!.costUsd * 100 + s.agents.a2!.costUsd * 100) / 100 })
  assert.equal(pointerText('.omnis-swarm/reports/x.md', { agents: 2, minutes: 23, costUsd: 4.5 }), 'Swarm report: .omnis-swarm/reports/x.md · 2 agents · 23 min · ≈$4.50.')
  assert.equal(pointerText('r.md', { agents: 1, minutes: 0, costUsd: 0 }), 'Swarm report: r.md · 1 agent · 0 min · ≈$0.00.')
})
```

`EXPECTED_BUSY` is the golden text. Write `reportMarkdown` (Step 3) first, print its output for the busy swarm once (`node -e` is not allowed for TS imports here, so add a temporary `console.log(md)` in the test and run it), check it line by line against the format in Step 3, then paste it into the test as a template literal constant at the bottom of the file and remove the log. The reviewer checks the golden against Step 3's format, so it must match exactly: heading, summary line, table with `main` first, `## Problems` with the guard, clash, stuck and failed lines in that order, `## Routing`, `## Tasks`.

- [ ] **Step 2: Run, see them fail** → `node --test tests/core/report.test.ts` FAIL (module missing).

- [ ] **Step 3: Write report.ts**

```ts
/** The run report (spec section 4.2): plain markdown from the folded state. Pure. */
import { LEAD, limitText, type AgentState, type SwarmState } from './fold.ts'
import { TASK_STATES } from './events.ts'
import { fileClashes, totalTokens } from './stats.ts'

const MAX_FILES = 5
const pad2 = (n: number): string => String(n).padStart(2, '0')
/** yyyy-mm-dd hh:mm at `tzOffsetMin` minutes east of UTC. */
const local = (ms: number, tz: number): string => {
  const d = new Date(ms + tz * 60_000)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
}
const minutes = (ms: number): number => Math.round(Math.max(0, ms) / 60_000)
const usd = (x: number): string => `≈$${x.toFixed(2)}`
const int = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
/** A table cell: a pipe would end the cell. */
const cell = (s: string): string => s.replace(/\|/g, '\\|')
const times = (n: number): string => (n === 1 ? '1 time' : `${n} times`)

const shown = (s: SwarmState): AgentState[] => {
  const all = Object.values(s.agents).filter(a => !a.placeholder)
  return [...all.filter(a => a.id === LEAD), ...all.filter(a => a.id !== LEAD).sort((x, y) => x.startedAt - y.startedAt)]
}
const runMs = (a: AgentState, now: number): number => a.activeMs + (a.finishedAt === null ? Math.max(0, now - a.startedAt) : 0)
const nameOf = (s: SwarmState, id: string): string => (Object.hasOwn(s.agents, id) ? s.agents[id]!.name : id)
const wallMs = (s: SwarmState, now: number): number => (s.swarm.endedAt ?? now) - (s.swarm.startedAt ?? now)

function filesEdited(s: SwarmState, id: string): string {
  const paths = Object.entries(s.edits).filter(([, list]) => list.some(e => e.agent === id && e.blocked !== true)).map(([p]) => p)
  if (paths.length === 0) return '–'
  const more = paths.length - MAX_FILES
  return paths.slice(0, MAX_FILES).join(', ') + (more > 0 ? `, +${more} more` : '')
}

function outcome(a: AgentState): string {
  if (a.id === LEAD) return '–'
  if (a.outcome === null) return 'running'
  return a.outcome === 'answer' ? 'done' : a.outcome
}

function problems(s: SwarmState): string[] {
  const out: string[] = []
  if (s.guard.warn !== null) out.push(`- Swarm passed half its budget (${limitText('swarmCost', s.guard.warn)}).`)
  if (s.guard.block !== null) out.push(`- Swarm reached its ${limitText('swarmCost', s.guard.block)} budget and new agents were blocked.`)
  for (const a of shown(s)) {
    const g = a.guard
    if (g === undefined) continue
    if (g.timeWarn !== null) out.push(`- ${a.name} passed its ${limitText('time', g.timeWarn)} time-box warning.`)
    if (g.timeAct !== null) out.push(`- ${a.name} was asked to wrap up at its ${limitText('time', g.timeAct)} time-box.`)
    if (g.costWarn !== null) out.push(`- ${a.name} passed its ${limitText('agentCost', g.costWarn)} warning.`)
    if (g.costAct !== null) out.push(`- ${a.name} was asked to wrap up at its ${limitText('agentCost', g.costAct)} budget.`)
  }
  for (const c of fileClashes(s)) out.push(`- Clash on ${c.path}: ${c.agents.map(id => nameOf(s, id)).join(', ')}${c.blocked ? ' (blocked)' : ''}.`)
  for (const a of shown(s)) {
    if (a.stuckBy !== undefined) out.push(`- ${a.name} looked stuck ${times(a.stuckBy.n)} and was asked to step back (last: ${a.stuckBy.p}, ${a.stuckBy.s || 'no subject'}).`)
  }
  for (const a of shown(s)) if (a.outcome === 'failed') out.push(`- ${a.name} failed${a.reason === null ? '' : `: ${a.reason}`}.`)
  return out
}

function routing(s: SwarmState): string[] {
  const routed = shown(s).filter(a => a.route !== undefined)
  if (routed.length === 0) return []
  const lines = routed.map(a => `- ${a.name}: asked for ${a.route!.q}, answered by ${a.model ?? 'an unknown model'}, saved ${usd(a.route!.d)}.`)
  lines.push(`- Total saved: ${usd(routed.reduce((t, a) => t + a.route!.d, 0))}.`)
  return lines
}

function tasks(s: SwarmState): string[] {
  const all = Object.values(s.tasks)
  if (all.length === 0) return []
  const counts = TASK_STATES.map(k => `${all.filter(t => t.state === k).length} ${k}`).join(', ')
  return [`${counts}.`, ...all.filter(t => t.state === 'failed').map(t => `- Failed: ${t.id} ${t.title}`)]
}

export function reportSummary(s: SwarmState, nowMs: number): { agents: number; minutes: number; costUsd: number } {
  const agents = shown(s)
  return {
    agents: agents.filter(a => a.id !== LEAD).length,
    minutes: minutes(wallMs(s, nowMs)),
    costUsd: Math.round(agents.reduce((t, a) => t + a.costUsd, 0) * 100) / 100,
  }
}

export function reportMarkdown(s: SwarmState, nowMs: number, tzOffsetMin: number): string {
  const sum = reportSummary(s, nowMs)
  const started = local(s.swarm.startedAt ?? nowMs, tzOffsetMin)
  const ended = s.swarm.endedAt === null ? 'still running' : `ended ${local(s.swarm.endedAt, tzOffsetMin)}`
  const lines = [
    `# Swarm report: ${s.swarm.name}`,
    '',
    `${s.swarm.topology} · started ${started} · ${ended} · ${sum.minutes} min · ${usd(sum.costUsd)} · ${sum.agents} agent${sum.agents === 1 ? '' : 's'}`,
    '',
    '| Agent | Role | Outcome | Time | Cost | Tokens | Files edited |',
    '|---|---|---|---|---|---|---|',
  ]
  for (const a of shown(s)) {
    const cost = usd(a.costUsd) + (a.costKnown ? '' : '+')
    const name = a.id === LEAD ? 'main' : a.name
    lines.push(`| ${cell(name)} | ${cell(a.role)} | ${outcome(a)} | ${minutes(runMs(a, nowMs))} min | ${cost} | ${int(totalTokens(a.tokens))} | ${cell(filesEdited(s, a.id))} |`)
  }
  for (const [title, body] of [['Problems', problems(s)], ['Routing', routing(s)], ['Tasks', tasks(s)]] as const) {
    if (body.length > 0) lines.push('', `## ${title}`, '', ...body)
  }
  return `${lines.join('\n')}\n`
}

export const pointerText = (path: string, s: { agents: number; minutes: number; costUsd: number }): string =>
  `Swarm report: ${path} · ${s.agents} agent${s.agents === 1 ? '' : 's'} · ${s.minutes} min · ${usd(s.costUsd)}.`
```

- [ ] **Step 4: Fill in the golden and run** → `node --test tests/core/report.test.ts` PASS.

- [ ] **Step 5: Move the file naming out of export.ts**

Create `src/mcp/out-file.ts`:

```ts
/** Files the server writes for a person (GIF exports, run reports): named by swarm and local minute, never overwritten. */
import { lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isLink, logPaths } from '../core/log.ts'

/** Second and later files in the same minute get -2, -3, … after the stamp. */
const MAX_SAME_MINUTE = 99
const pad2 = (n: number): string => String(n).padStart(2, '0')
const taken = (path: string): boolean => lstatSync(path, { throwIfNoEntry: false }) !== undefined

/** yyyymmdd-hhmm in the server machine's local time zone (sorts by time within a zone). */
export const stamp = (d: Date): string => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`

/**
 * Writes `data` to .omnis-swarm/<folder>/<base><ext>, or <base>-2<ext> and on when taken, through a temp file and a
 * rename. The name is built only from the caller's validated base, a counter and the extension. No await between
 * choosing it and the rename, so two writes in this server cannot pick the same name. Answers the file name.
 */
export function writeUnique(root: string, folder: 'exports' | 'reports', base: string, ext: '.gif' | '.md', data: string | Uint8Array): string {
  const dir = join(logPaths(root).dir, folder)
  if (isLink(dir)) throw new Error(`refusing a link for the ${folder} folder`)
  mkdirSync(dir, { recursive: true })
  let n = 1
  while (n <= MAX_SAME_MINUTE && taken(join(dir, n === 1 ? `${base}${ext}` : `${base}-${n}${ext}`))) n++
  if (n > MAX_SAME_MINUTE) throw new Error(`too many ${folder} this minute`)
  const name = n === 1 ? `${base}${ext}` : `${base}-${n}${ext}`
  const target = join(dir, name)
  const temp = `${target}.${process.pid}.tmp`
  try {
    rmSync(temp, { force: true })
    writeFileSync(temp, data, { flag: 'wx' })
    renameSync(temp, target)
  } finally {
    rmSync(temp, { force: true })
  }
  return name
}
```

In `src/mcp/tools/export.ts`: delete `MAX_SAME_MINUTE`, `taken`, `pad2`, `stamp` and the naming/write block, import `{ stamp, writeUnique }` from `../out-file.ts`, and replace the block inside the `try` after `renderGif` with:

```ts
        const name = writeUnique(root, 'exports', `${swarm}-${stamp(clock())}`, '.gif', gif)
        return { text: `GIF written to .omnis-swarm/exports/${name} (${Math.round(gif.length / 1024)} KB, ${speed}× speed).` }
```

Drop the now unused fs and path imports. Run `node --test tests/mcp/export.test.ts` → PASS, unchanged.

- [ ] **Step 6: Write the failing server tests**

Create `tests/mcp/report.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendEvent, readEvents, swarmLogPath } from '../../src/core/log.ts'
import { Session } from '../../src/mcp/session.ts'
import { createReportTools } from '../../src/mcp/tools/report.ts'
import { createTools } from '../../src/mcp/tools.ts'
import { InputError } from '../../src/mcp/validate.ts'
import { ev, tmpRoot } from '../helpers.ts'

const NOW = new Date('2026-10-23T10:05:00.000Z')
const setup = () => {
  const root = tmpRoot()
  const session = new Session(root)
  const ctx = { root, session, now: () => NOW }
  const [report] = createReportTools(ctx)
  const tools = createTools(ctx)
  const tool = (name: string, args: Record<string, unknown> = {}) => tools.find(t => t.name === name)!.handler(args)
  return { root, session, report: report!, tool }
}
const reports = (root: string) => readdirSync(join(root, '.omnis-swarm', 'reports')).sort()

test('omnis_report writes the running swarm\'s report, records report.written and answers the pointer', () => {
  const { root, report, tool } = setup()
  tool('omnis_swarm_init', { name: 'auth', topology: 'hierarchical' })
  appendEvent(root, ev('agent.started', { name: 'coder-1', role: 'coder', description: '', parent: 'lead' }, { agent: 'a1', swarm: 'auth', atSec: 1 }))
  const reply = report.handler({}).text
  const [name] = reports(root)
  assert.match(name!, /^auth-\d{8}-\d{4}\.md$/)
  assert.equal(reply, `Swarm report: .omnis-swarm/reports/${name} · 1 agent · ${reply.match(/· (\d+) min/)![1]} min · ≈$0.00.`)
  assert.match(readFileSync(join(root, '.omnis-swarm', 'reports', name!), 'utf8'), /^# Swarm report: auth\n/)
  const last = readEvents(swarmLogPath(root, 'auth')).events.at(-1)!
  assert.equal(last.type, 'report.written')
  assert.deepEqual(last.data, { path: `.omnis-swarm/reports/${name}`, agents: 1, minutes: (last.data as { minutes: number }).minutes, costUsd: 0 })
})

test('a second report in the same minute gets -2, and a named swarm can be reported', () => {
  const { root, report, tool } = setup()
  tool('omnis_swarm_init', { name: 'auth', topology: 'mesh' })
  report.handler({})
  report.handler({ swarm: 'auth' })
  assert.deepEqual(reports(root).map(n => n.replace(/\d{8}-\d{4}/, 'STAMP')), ['auth-STAMP-2.md', 'auth-STAMP.md'])
})

test('no swarm, a bad id or an unknown swarm is a plain error', () => {
  const { report } = setup()
  assert.throws(() => report.handler({}), InputError)
  assert.throws(() => report.handler({ swarm: '../x' }), InputError)
  assert.throws(() => report.handler({ swarm: 'nope' }), InputError)
})

test('omnis_swarm_end writes a report and names it, but not twice for an unchanged swarm', () => {
  const { root, report, tool } = setup()
  tool('omnis_swarm_init', { name: 'auth', topology: 'mesh' })
  appendEvent(root, ev('agent.started', { name: 'coder-1', role: 'coder', description: '', parent: 'lead' }, { agent: 'a1', swarm: 'auth', atSec: 1 }))
  report.handler({})
  const reply = tool('omnis_swarm_end', { outcome: 'done' }).text
  assert.equal(reply, 'Swarm auth ended.')
  assert.equal(reports(root).length, 1)
})

test('omnis_swarm_end with new work since the last report writes one and puts the pointer in its reply', () => {
  const { root, tool } = setup()
  tool('omnis_swarm_init', { name: 'auth', topology: 'mesh' })
  appendEvent(root, ev('agent.started', { name: 'coder-1', role: 'coder', description: '', parent: 'lead' }, { agent: 'a1', swarm: 'auth', atSec: 1 }))
  const reply = tool('omnis_swarm_end', {}).text
  assert.match(reply, /^Swarm auth ended\. Swarm report: \.omnis-swarm\/reports\/auth-\d{8}-\d{4}\.md · 1 agent · \d+ min · ≈\$0\.00\.$/)
  assert.ok(existsSync(join(root, '.omnis-swarm', 'reports')))
})
```

(`ev`'s `atSec` is relative to the helpers' epoch; if that epoch is far from `NOW`, the minutes figure is large but the tests read it back rather than fixing it.)

- [ ] **Step 7: Run, see them fail** → FAIL (module missing).

- [ ] **Step 8: Write tools/report.ts and wire it**

```ts
/**
 * omnis_report (spec section 4.3): writes the run report of a swarm to .omnis-swarm/reports and answers the pointer
 * line. Internal (the mod's guard refuses the model). omnis_swarm_end calls writeReport directly.
 */
import { isValidSwarmId, makeEvent } from '../../core/events.ts'
import { appendEvent, isLink, swarmLogPath } from '../../core/log.ts'
import { REPORT_TOOL } from '../../core/recording.ts'
import { pointerText, reportMarkdown, reportSummary } from '../../core/report.ts'
import { existsSync } from 'node:fs'
import { stamp, writeUnique } from '../out-file.ts'
import type { Args, ToolDef } from '../protocol.ts'
import type { Session } from '../session.ts'
import type { ToolContext } from '../tools.ts'
import { InputError, optString } from '../validate.ts'

const FAILED = 'Could not write the swarm report (see the server log).'

/** Writes swarm `swarm`'s report and records report.written. Answers the pointer line. */
export function writeReport(root: string, session: Session, swarm: string, now: Date): string {
  const state = session.state(swarm).state
  const md = reportMarkdown(state, now.getTime(), -now.getTimezoneOffset())
  const name = writeUnique(root, 'reports', `${swarm}-${stamp(now)}`, '.md', md)
  const path = `.omnis-swarm/reports/${name}`
  const sum = reportSummary(state, now.getTime())
  if (!appendEvent(root, makeEvent({ type: 'report.written', swarm, src: 'mcp', data: { path, ...sum }, now }))) throw new Error('append failed')
  return pointerText(path, sum)
}

export function createReportTools(ctx: ToolContext): ToolDef[] {
  const { root, session } = ctx
  const clock = ctx.now ?? (() => new Date())
  const tool: ToolDef = {
    name: REPORT_TOOL,
    description: 'Internal to the OmnisSwarm plugin: writes a run report for /omnis report and when a run goes quiet. When the OmnisSwarm mod is loaded it refuses calls from the model.',
    inputSchema: {
      type: 'object',
      properties: { swarm: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,63}$' } },
      additionalProperties: false,
    },
    handler: (args: Args) => {
      const named = optString(args, 'swarm', 64)
      if (named !== undefined && !isValidSwarmId(named)) throw new InputError('swarm is not a valid swarm id')
      const swarm = named ?? session.mySwarm()
      if (swarm === null) throw new InputError('No swarm is running.')
      const file = swarmLogPath(root, swarm)
      if (!existsSync(file) || isLink(file)) throw new InputError(`No swarm ${swarm} here.`)
      try {
        return { text: writeReport(root, session, swarm, clock()) }
      } catch (err) {
        process.stderr.write(`omnis: ${REPORT_TOOL} failed: ${err instanceof Error ? err.message : String(err)}\n`)
        throw new Error(FAILED)
      }
    },
  }
  return [tool]
}
```

`src/mcp/registry.ts`: import `createReportTools` and append it to `toolFactories`.

In `src/mcp/tools.ts`, import `{ writeReport }` from `./tools/report.ts` and `LEAD` from `../core/fold.ts`, and change `omnis_swarm_end`'s owned path to:

```ts
        emit(makeEvent({ type: 'swarm.ended', swarm: id, src: 'mcp', data: outcome === undefined ? {} : { outcome }, now: clock() }))
        if (readCurrent(root) === id) clearCurrent(root)
        session.letGo()
        const s = session.state(id).state
        const lastWork = Math.max(0, ...Object.values(s.agents).filter(a => a.id !== LEAD && !a.placeholder).map(a => a.lastActivity))
        if (s.lastReport !== undefined && lastWork <= s.lastReport.at) return { text: `Swarm ${id} ended.` }
        try {
          return { text: `Swarm ${id} ended. ${writeReport(root, session, id, clock())}` }
        } catch (err) {
          process.stderr.write(`omnis: report on omnis_swarm_end failed: ${err instanceof Error ? err.message : String(err)}\n`)
          return { text: `Swarm ${id} ended. The report could not be written (see the server log).` }
        }
```

If a circular import between `tools.ts` and `tools/report.ts` trips at load (report.ts imports only the `ToolContext` type from tools.ts, which is erased, so it shouldn't), move `writeReport` into `src/mcp/report-file.ts` and import it from both.

Add `'omnis_report'` to the sorted tool list in `tests/e2e/mcp-server.test.ts`.

- [ ] **Step 9: Run** → `node --test tests/mcp/report.test.ts tests/mcp/tools.test.ts tests/mcp/export.test.ts tests/e2e/mcp-server.test.ts` PASS. If an existing `tools.test.ts` end test now sees the pointer in the reply, change it to `assert.match(reply, /^Swarm \S+ ended\./)`.

- [ ] **Step 10: Gate and commit**

```bash
git add src/core/report.ts tests/core/report.test.ts src/mcp tests/mcp tests/e2e/mcp-server.test.ts
git commit -m "Write a markdown report of each swarm run"
```

---

### Task 5: Report trigger and /omnis report

**Files:**
- Create: `src/mod/run-report.ts`, `src/mod/run-report.test.ts`
- Modify: `src/mod/commands.ts`, `src/mod/register.ts`, `src/mod/commands.test.ts` (if it pins the description or hint)

**Interfaces:**
- Consumes (Task 1): `REPORT_TOOL`; `connectServer($)` from `./server.ts`; `Sub` from `./commands.ts`. The server answers `omnis_report` with the pointer text (Task 4); this task's tests stub that reply.
- Produces: `registerRunReport(on: On): void`, `reportSub: Sub`, `reportCommand($, words): Promise<string | null>`, `QUIET_AFTER_MS = 30_000`.

- [ ] **Step 1: Write the failing kit tests**

Create `src/mod/run-report.test.ts`:

```ts
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { KIT, RUN } from './test-engine.ts'

const SID = 'abcdef12-3456-7890-abcd-ef1234567890'
const POINTER = 'Swarm report: .omnis-swarm/reports/s1-20261023-1000.md · 1 agent · 3 min · ≈$0.40.'
type Seen = { reports: number; readonly appends: string[]; reply: { text: string; isError: boolean } }

function engine(on: On): Seen {
  const session = mock.session(on)
  const seen: Seen = { reports: 0, reply: { text: POINTER, isError: false }, get appends() { return session.appended().map(row => JSON.stringify(row.message)) } }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SID }))
  on('state.get', () => ({ value: { value: undefined, version: 0 } }))
  on('state.set', () => ({ value: { isSet: true as const, version: 1 } }))
  on('agent.list', () => ({ value: [] }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'plugin:omnis-swarm:omnis-swarm' } }))
  on('mcp.call', (_$, e) => {
    if (e.tool !== 'omnis_report') return { value: { content: [{ type: 'text', text: 'ok s1' }], isError: false } }
    seen.reports++
    return { value: { content: [{ type: 'text', text: seen.reply.text }], isError: seen.reply.isError } }
  })
  let id = 0
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: `a${++id}` }))
  on('turn.complete', () => ({ text: '' }))
  return seen
}

async function boot($: Engine, on: On) {
  const clock = mock.clock(on, { now: Date.parse('2026-10-23T10:00:00.000Z') })
  const seen = engine(on)
  await $.session.start({ cwd: '/p', surface: null, isInteractive: false })
  await clock.settle()
  return { clock, seen }
}

const spawn = ($: Engine, n: number) => $.agent.spawn({
  tool_use_id: `toolu_${n}`, name: `coder-${n}`, subagentType: 'coder', description: 'x', prompt: 'p',
  provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false,
})
const finish = ($: Engine, agentId: string) => $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: `t-${agentId}`, agentId, reason: 'answer' })
const pointers = (seen: Seen) => seen.appends.filter(a => a.includes('Swarm report: '))

test('when the last subagent finishes and 30 s pass quietly, one report is written and the lead is told', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await spawn($, 1)
  await finish($, 'a1')
  await clock.advance(29_000)
  expect(seen.reports).toBe(0)
  await clock.advance(1_000)
  await clock.settle()
  expect(seen.reports).toBe(1)
  expect(pointers(seen).length).toBe(1)
  expect(pointers(seen)[0]).toContain(POINTER)
  await finish($, 'a1')
  await clock.advance(60_000)
  await clock.settle()
  expect(seen.reports).toBe(1)
})

test('a subagent starting inside the quiet window puts the report off until it finishes too', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await spawn($, 1)
  await finish($, 'a1')
  await clock.advance(10_000)
  await spawn($, 2)
  await clock.advance(60_000)
  expect(seen.reports).toBe(0)
  await finish($, 'a2')
  await clock.advance(30_000)
  await clock.settle()
  expect(seen.reports).toBe(1)
})

test('the lead finishing a turn is not a run going quiet', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await $.turn.complete({ answer: 'x', durationMs: 1, isAborted: false, turnId: 'lead', reason: 'answer' })
  await clock.advance(60_000)
  await clock.settle()
  expect(seen.reports).toBe(0)
})

test('/omnis report answers the pointer, or the server\'s error', KIT, async ($, on) => {
  const { seen } = await boot($, on)
  expect(await $.command.run({ command: 'omnis', args: 'report', ...RUN })).toEqual({ text: POINTER })
  seen.reply = { text: 'No swarm is running.', isError: true }
  expect(await $.command.run({ command: 'omnis', args: 'report', ...RUN })).toEqual({ text: 'No report was written: No swarm is running.' })
  expect(await $.command.run({ command: 'omnis', args: 'report now', ...RUN })).toEqual({ text: 'Usage: /omnis report writes a report of the current swarm.' })
})
```

Before writing these, open `src/mod/commands.test.ts` and `src/mod/budget-command.test.ts` to see exactly what `$.command.run` resolves to in this kit (the expectation shape above is a guess at `{ text }`): match the form those tests assert.

- [ ] **Step 2: Run, see them fail** → FAIL.

- [ ] **Step 3: Write run-report.ts**

```ts
/**
 * The run report's mod side (spec section 4): asks the server for a report when a run goes quiet (no subagent running
 * for QUIET_AFTER_MS after at least one ran since the last report), and on /omnis report. The lead gets the pointer.
 */
import type { EngineInterface, On, Timer } from 'claude-code'
import { REPORT_TOOL } from '../core/recording.ts'
import type { Sub } from './commands.ts'
import { connectServer } from './server.ts'

export const QUIET_AFTER_MS = 30_000
const USAGE = 'Usage: /omnis report writes a report of the current swarm.'

export const reportSub: Sub = {
  name: 'report',
  describe: '/omnis report writes a report of the current swarm',
  hint: 'report',
  usage: USAGE,
}

/** Module state; a hot reload forgets the running subagents, so the next run's report waits for its first spawn. */
const run = { live: new Set<string>(), ranSinceReport: false, timer: null as Timer | null }

/** The server's reply text and whether it is an error, or null when the call failed. */
async function askReport($: EngineInterface): Promise<{ text: string; isError: boolean } | null> {
  try {
    const server = await connectServer($)
    if (server === null) return null
    const result = await $.mcp.call(server, REPORT_TOOL, {})
    const block = result.content[0]
    const text = block !== undefined && block.type === 'text' && typeof block.text === 'string' ? block.text.slice(0, 300) : ''
    if (!result.isError) run.ranSinceReport = false
    return { text, isError: result.isError === true }
  } catch {
    return null
  }
}

async function quiet($: EngineInterface): Promise<void> {
  run.timer = null
  if (run.live.size > 0 || !run.ranSinceReport) return
  const reply = await askReport($)
  if (reply === null || reply.isError || reply.text === '') return
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: reply.text }] } })
}

function cancelQuiet(): void {
  run.timer?.cancel()
  run.timer = null
}

/** `words` are the lower-cased words after /omnis, "report" first. */
export async function reportCommand($: EngineInterface, words: readonly string[]): Promise<string | null> {
  if (words.length !== 1) return USAGE
  const reply = await askReport($)
  if (reply === null) return 'The swarm server is not connected yet; try again in a moment.'
  return reply.isError ? `No report was written: ${reply.text}` : reply.text
}

export function registerRunReport(on: On): void {
  cancelQuiet()
  run.live.clear()
  run.ranSinceReport = false

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    try {
      const id = result.deny === undefined ? result.agentId : undefined
      if (typeof id === 'string') {
        run.live.add(id)
        run.ranSinceReport = true
        cancelQuiet()
      }
    } catch {
      // A missed spawn costs at most one report.
    }
    return result
  }).catch((_$, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    try {
      if (e.agentId !== undefined && run.live.delete(e.agentId) && run.live.size === 0 && run.ranSinceReport && run.timer === null) {
        run.timer = $.clock.after(QUIET_AFTER_MS, () => void quiet($).catch(() => undefined))
      }
    } catch {
      // As above.
    }
    return result
  })
}
```

`src/mod/commands.ts`: import `{ reportCommand, reportSub }` from `./run-report.ts`, put `reportSub` last in `SUBS`, and add `case 'report': return (await reportCommand($, words)) ?? USAGE`.

`src/mod/register.ts`: `import { registerRunReport } from './run-report.ts'` and `registerRunReport(on)` after `registerPane(on, options)`.

(If `$.clock.after`'s callback type or `Timer` import differs, copy how `src/mod/pane-runtime.ts` uses `$.clock.after`.)

- [ ] **Step 4: Run** → `npm run test:mod` PASS (fix any `commands.test.ts` pin of the description or hint to include the report part).

- [ ] **Step 5: Gate and commit**

```bash
git add src/mod/run-report.ts src/mod/run-report.test.ts src/mod/commands.ts src/mod/commands.test.ts src/mod/register.ts
git commit -m "Report a run when it goes quiet, and add /omnis report"
```

---

### Task 6: The pane says when a clash was refused

**Files:**
- Modify: `src/render/spotlight.ts`, `tests/render/spotlight.test.ts`, `docs/design/pane.md`

**Interfaces:**
- Consumes (Task 1): `AgentStats.blockedClashes`, `stuck` now true while `stuckBy.on`.

- [ ] **Step 1: Write the failing test**

Append to `tests/render/spotlight.test.ts` (it already has `state()`, `rect`, `mid`, `Grid`, `CANVAS`, `drawSpotlight`, `agentStats`, `gridText`):

```ts
test('a refused clash says (blocked) after its path, in the same width', () => {
  const s = state()
  const stats = agentStats(s, 'a-cod1', mid)!
  const g = new Grid(110, 6, CANVAS)
  drawSpotlight(g, rect(0, 0, 110, 6), { ...stats, blockedClashes: [stats.clashes[0]!] }, s.agents['a-cod1']!, mid, false)
  assert.match(gridText(g)[5]!, /! clash .* \(blocked\)/)
  const plain = new Grid(110, 6, CANVAS)
  drawSpotlight(plain, rect(0, 0, 110, 6), stats, s.agents['a-cod1']!, mid, false)
  assert.doesNotMatch(gridText(plain)[5]!, /blocked/)
})
```

(`a-cod1` is the fixture agent the existing full-card test shows a clash for. If `stats.clashes` is empty for it, use the agent that test uses.)

- [ ] **Step 2: Run, see it fail** → `node --test tests/render/spotlight.test.ts` FAIL.

- [ ] **Step 3: Implement**

In `src/render/spotlight.ts`, row 5, replace the clash push with:

```ts
    if (s.clashes.length > 0) {
      const path = s.clashes[0]!
      const blocked = s.blockedClashes.includes(path)
      // The same 32 cells either way: ' (blocked)' takes 10 of them from the path.
      right.push(['  ', TEXT.dim], [`${GLYPH.clash} clash ${clipText(path, blocked ? 22 : 32)}${blocked ? ' (blocked)' : ''}`, STATUS.failed])
    }
```

- [ ] **Step 4: pane.md §14**

Append to `docs/design/pane.md`:

```markdown
## 14. Clash guard and stuck nudges

The look of the clash guard and stuck nudges in `docs/superpowers/specs/2026-10-23-clash-stuck-report-design.md`. No new
glyphs, colours or motion: both reuse what §4 and §5 already draw.

**Refused clash.** A refused edit (`clash.blocked`, mode `block`) counts as a clashing edit, so the red dashed line and the
blinking rims of §5 show it unchanged. The spotlight's clash line reads `! clash <path> (blocked)` when the latest edit on
that path was refused. The path gives up 10 of its 32 cells to ` (blocked)`, so the line keeps its width, and it keeps
`STATUS.failed`. A warned clash (mode `warn`) reads as any other clash.

**Stuck nudge.** A nudged agent wears the §4 stuck look (amber outline, `!`, `stuck` on the spotlight's tools line) while
its pattern holds, whether it was failing or repeating. It drops when the pattern re-arms (an edit, a success, or a
different subject). The feed says `<name> looks stuck (<pattern>), asked to step back`, with ` (not delivered)` when the
message didn't reach it.
```

The designer reviews this section and the rendered card in the wave review (Task 7 dispatch note).

- [ ] **Step 5: Run and commit**

Run: `node --test tests/render/spotlight.test.ts tests/render/golden.test.ts` → PASS. Gate.

```bash
git add src/render/spotlight.ts tests/render/spotlight.test.ts docs/design/pane.md
git commit -m "Say when a clash was refused on the spotlight card"
```

---

### Task 7: Integrate, manifest and README

**Files:**
- Modify: `src/mod/register.ts` (merge), `.claude-plugin/plugin.json`, `README.md`

- [ ] **Step 1: Merge the wave**

Integrator: merge Tasks 4, 5, 2, 3, 6 into master in that order with `--no-ff`. `register.ts` conflicts are expected: keep every import and call. The end state:

```ts
export const register: Register = (on, options) => {
  registerGuard(on)
  registerRecorder(on, guardObserver)
  registerBudgetGuard(on, options)
  registerClashGuard(on, options)
  registerStuckGuard(on)
  registerPane(on, options)
  registerRunReport(on)
}
```

Run the full gate after each merge.

- [ ] **Step 2: The setting**

In `.claude-plugin/plugin.json` `userConfig`, after `panel`:

```json
    "clashGuard": {
      "type": "string",
      "title": "File clash guard",
      "description": "block (the default): an agent can't edit a file another live agent is editing. warn: the edit goes ahead and the lead is told. off: no check.",
      "default": "block",
      "options": ["block", "warn", "off"]
    },
```

Run: `claude plugin validate .` → passes with no warnings.

- [ ] **Step 3: README**

The writer (omnis-writer, writing-no-slop voice) adds to `README.md`, in the features part, about 150 to 250 words covering: the clash guard and its `clashGuard` setting (block, warn, off); that it only sees Edit, Write and NotebookEdit, so writes through Bash (`sed -i`, `>`, `mv`) get past it; stuck nudges (5 failures in a row, or the same thing 4 times with no edit); the run report, where it lands (`.omnis-swarm/reports/`), when it is written (a run going quiet, `omnis_swarm_end`, `/omnis report`). The lead commits it.

- [ ] **Step 4: Final gate, push**

Full gate on master, then `git push`.

---

## Self-review notes

- Spec §2.1 to §2.4: Tasks 1 (fold, stats), 2 (holds, refusal, warn, off, dedupe), 6 (spotlight), 7 (setting). §2.4's "designer confirms" is the §14 review.
- Spec §3: Task 3 (patterns, texts, send, append, event, re-arm), Task 1 (fold `stuckBy`, stuck look).
- Spec §4: Task 4 (`reportMarkdown`, file naming, `omnis_report`, `omnis_swarm_end`), Task 5 (quiet trigger, `/omnis report`, lead append).
- Spec §5: Task 1. §6: tests in every task. §7: Tasks 6 and 7.
- Names checked across tasks: `agentLabel`, `REPORT_TOOL`, `blockedClashes`, `stuckBy {on,p,s,n}`, `writeReport(root, session, swarm, now)`, `registerClashGuard(on, options)`, `registerStuckGuard(on)`, `registerRunReport(on)`.
