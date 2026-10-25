# Model Hints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tell the lead, at `omnis_swarm_init`, which roles have done fine (or badly) on a cheaper model in past runs, from outcome rows the server keeps.

**Architecture:** Two pure core modules (`history.ts` builds and parses outcome rows from the folded state; `hints.ts` turns rows into hint lines and a table). One server module (`history-store.ts`) reads and writes the project and machine `history.jsonl` stores, backfills from old logs and is called from the report path and `omnis_swarm_init`. An internal `omnis_hints` tool serves `/omnis hints` in the mod.

**Tech Stack:** TypeScript run directly by Node 24 (type stripping), `node:test`, the Claude Code mod kit (`claude-code/testing`). No dependencies.

Spec: `docs/superpowers/specs/2026-10-25-model-hints-design.md`.

## Global Constraints

- Node >= 24, no new dependencies; TypeScript must be strip-only (no enums, no parameter properties, no namespaces); relative imports end in `.ts`.
- `src/core/*` stays pure and mod-safe: no `node:*` imports (`tests/core/mod-safe.test.ts` enforces it).
- Files under 500 lines. `src/mcp/tools.ts` is at 431: add as little there as possible.
- Gate: `npm run check` (typecheck + node tests + kit tests) must pass before every commit.
- Thresholds, verbatim from the spec: 5 runs per tier; cheaper when no more than 10 points below; keep when 25 or more points below; at most 5 hint lines; newest 500 rows per store.
- Rows store no prompts, descriptions, subjects or file paths. `project` is the first 16 hex of SHA-256 of the project path.
- Commit messages: plain British English, as a person would write them. No `Co-Authored-By` trailer and no AI attribution of any kind.
- Without `ctx.hints` a `ToolContext` has hints off, so every existing test's output is unchanged.

## Parallelism

| Wave | Tasks | Why |
|---|---|---|
| 1 | T1, T2, T3 in parallel, one worktree each | Disjoint files; T2 only needs the `HistoryRow` type, which is fixed below; T3 only needs the tool name and that the reply is plain text |
| 2 | T4 | Uses T1, T2 and T3's `HINTS_TOOL` |
| Lead | Manifest, version, README | `plugin.json`, `package.json`, `server.ts` version and README are lead-owned |

## Shared contract (fixed now, all tasks rely on it)

```ts
// src/core/history.ts
export type HistoryRow = { v: 1; id: string; role: string; model: string; clean: boolean; costUsd: number; minutes: number; at: string; project: string }
export function rowsFromState(s: SwarmState, project: string): HistoryRow[]
export function parseRow(line: string): HistoryRow | null
export const rowLine: (r: HistoryRow) => string   // JSON + '\n'

// src/core/hints.ts
export type Tier = 1 | 2 | 3
export function tierOf(model: string): Tier | null
export type HintStat = { role: string; tier: Tier; runs: number; clean: number; avgUsd: number; avgMin: number; source: 'project' | 'machine' }
export function hintStats(project: HistoryRow[], machine: HistoryRow[]): HintStat[]
export function hintLines(project: HistoryRow[], machine: HistoryRow[]): string[]
export function hintsText(project: HistoryRow[], machine: HistoryRow[]): string

// src/core/recording.ts
export const HINTS_TOOL = 'omnis_hints'   // internal; the server answers plain text
```

---

### Task 1: Outcome rows (`src/core/history.ts`)

**Files:**
- Create: `src/core/history.ts`
- Test: `tests/core/history.test.ts`

**Interfaces:**
- Consumes: `SwarmState`, `AgentState`, `LEAD` from `src/core/fold.ts`; `foldAll` and the `ev` / `at` test helpers.
- Produces: the `history.ts` part of the shared contract, plus `isClean(s: SwarmState, a: AgentState): boolean` and `ROLE: RegExp`.

- [ ] **Step 1: Write the failing tests** in `tests/core/history.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldAll } from '../../src/core/fold.ts'
import { isClean, parseRow, rowLine, rowsFromState, type HistoryRow } from '../../src/core/history.ts'
import type { SwarmEvent } from '../../src/core/events.ts'
import { at, ev } from '../helpers.ts'

const P = '0123456789abcdef'
const usage = (agent: string, model: string, atSec: number) =>
  ev('agent.usage', { model, input: 1000, output: 500, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, { agent, atSec })
const started = (agent: string, role: string, atSec = 1) => ev('agent.started', { name: agent, role, description: 'do the thing', parent: 'lead' }, { agent, atSec })
const finished = (agent: string, outcome: 'answer' | 'failed' | 'aborted', atSec: number) => ev('agent.finished', { outcome }, { agent, atSec })
const swarm = (events: SwarmEvent[]) => foldAll('s1', [ev('swarm.started', { name: 's1', topology: 'hierarchical', implicit: false }, { src: 'mcp' }), ...events])

test('a finished subagent gives one row with its role, answering model, cost, minutes and finish time', () => {
  const s = swarm([started('dev-1', 'omnis-developer'), usage('dev-1', 'claude-sonnet-5-5', 2), finished('dev-1', 'answer', 181)])
  const [row, ...rest] = rowsFromState(s, P)
  assert.equal(rest.length, 0)
  assert.equal(row!.id, 's1/dev-1')
  assert.equal(row!.role, 'omnis-developer')
  assert.equal(row!.model, 'claude-sonnet-5-5')
  assert.equal(row!.clean, true)
  assert.equal(row!.at, new Date(at(181)).toISOString())
  assert.equal(row!.project, P)
  assert.equal(row!.v, 1)
  assert.equal(typeof row!.minutes, 'number')
  assert.equal(Math.round(row!.costUsd * 100), row!.costUsd * 100)
  assert.equal(JSON.stringify(row).includes('do the thing'), false)
})

test('the lead, unfinished agents and agents with no usage get no row', () => {
  const s = swarm([
    started('dev-1', 'omnis-developer'), usage('dev-1', 'claude-opus-5-5', 2),
    started('dev-2', 'omnis-developer'), finished('dev-2', 'answer', 5),
    usage('lead', 'claude-opus-5-5', 3),
  ])
  assert.deepEqual(rowsFromState(s, P), [])
})

test('a bad project key gives no rows', () => {
  const s = swarm([started('dev-1', 'omnis-developer'), usage('dev-1', 'claude-opus-5-5', 2), finished('dev-1', 'answer', 5)])
  assert.deepEqual(rowsFromState(s, 'nothex'), [])
})

test('a plugin agent type with colons is a valid role', () => {
  const s = swarm([started('x', 'searchfit-seo:seo-auditor:AGENT'), usage('x', 'claude-haiku-5-5', 2), finished('x', 'answer', 5)])
  assert.equal(rowsFromState(s, P)[0]!.role, 'searchfit-seo:seo-auditor:AGENT')
})

test('clean needs an answer: failed and aborted are not clean', () => {
  for (const outcome of ['failed', 'aborted'] as const) {
    const s = swarm([started('dev-1', 'r'), usage('dev-1', 'claude-opus-5-5', 2), finished('dev-1', outcome, 5)])
    assert.equal(rowsFromState(s, P)[0]!.clean, false, outcome)
  }
})

test('an agent the stuck guard nudged is not clean', () => {
  const s = swarm([started('dev-1', 'r'), usage('dev-1', 'claude-opus-5-5', 2),
    ev('agent.stuck', { pattern: 'failing', count: 3, subject: 'npm test', delivered: true }, { agent: 'dev-1', atSec: 3, src: 'recorder' }),
    finished('dev-1', 'answer', 5)])
  assert.equal(rowsFromState(s, P)[0]!.clean, false)
})

test('an agent asked to wrap up by the time-box or its budget is not clean', () => {
  for (const limit of ['time', 'agentCost'] as const) {
    const s = swarm([started('dev-1', 'r'), usage('dev-1', 'claude-opus-5-5', 2),
      ev('guard.nudged', { limit, value: 40, threshold: 30, delivered: true }, { agent: 'dev-1', atSec: 3, src: 'recorder' }),
      finished('dev-1', 'answer', 5)])
    assert.equal(rowsFromState(s, P)[0]!.clean, false, limit)
  }
})

test('every task the agent held must end done with its gate passed, none or not run', () => {
  const base = (extra: SwarmEvent[]) => swarm([started('dev-1', 'r'), usage('dev-1', 'claude-opus-5-5', 2),
    ev('task.created', { id: 't1', title: 'a', assignee: 'dev-1' }, { src: 'mcp', atSec: 1 }), ...extra, finished('dev-1', 'answer', 9)])
  const done = ev('task.updated', { id: 't1', state: 'done' }, { src: 'mcp', atSec: 6 })
  const gate = (result: 'passed' | 'failed' | 'none' | 'skipped') => ev('gate.ran', { task: 't1', result, ms: 10, mode: 'block' }, { src: 'mcp', atSec: 5 })
  assert.equal(rowsFromState(base([done]), P)[0]!.clean, true)
  assert.equal(rowsFromState(base([gate('passed'), done]), P)[0]!.clean, true)
  assert.equal(rowsFromState(base([gate('none'), done]), P)[0]!.clean, true)
  assert.equal(rowsFromState(base([gate('failed'), done]), P)[0]!.clean, false)
  assert.equal(rowsFromState(base([gate('skipped'), done]), P)[0]!.clean, false)
  assert.equal(rowsFromState(base([]), P)[0]!.clean, false)
})

test('isClean is exported and agrees with the row', () => {
  const s = swarm([started('dev-1', 'r'), usage('dev-1', 'claude-opus-5-5', 2), finished('dev-1', 'answer', 5)])
  assert.equal(isClean(s, s.agents['dev-1']!), true)
})

const good: HistoryRow = { v: 1, id: 's1/dev-1', role: 'omnis-developer', model: 'claude-sonnet-5-5', clean: true, costUsd: 0.41, minutes: 6, at: '2026-10-25T10:00:00.000Z', project: P }

test('rowLine and parseRow round-trip a row', () => {
  const line = rowLine(good)
  assert.ok(line.endsWith('\n'))
  assert.deepEqual(parseRow(line.trim()), good)
})

test('parseRow refuses bad JSON, wrong version and bad fields, and drops extra fields', () => {
  assert.equal(parseRow('{'), null)
  assert.equal(parseRow('[]'), null)
  for (const patch of [{ v: 2 }, { id: '' }, { id: 'x'.repeat(131) }, { role: 'has space' }, { model: 'a/b' }, { clean: 'yes' },
    { costUsd: -1 }, { costUsd: Number.MAX_VALUE }, { minutes: 'six' }, { at: 'never' }, { project: 'ABC' }]) {
    assert.equal(parseRow(JSON.stringify({ ...good, ...patch })), null, JSON.stringify(patch))
  }
  assert.deepEqual(parseRow(JSON.stringify({ ...good, prompt: 'secret' })), good)
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test tests/core/history.test.ts`
Expected: FAIL, cannot find module `src/core/history.ts`.

- [ ] **Step 3: Implement** `src/core/history.ts`:

```ts
/** Outcome rows for model hints (spec 2026-10-25 section 2): one per finished subagent, from the folded state. Pure. */
import { LEAD, type AgentState, type SwarmState } from './fold.ts'

/** Roles and models a row may carry. Colons allow plugin agent types such as `plugin:agent`. */
export const ROLE = /^[A-Za-z0-9._:-]{1,64}$/
const PROJECT = /^[0-9a-f]{16}$/
const MAX_ID = 130
const MAX_NUMBER = 1e6
const CLEAN_GATES: ReadonlySet<string> = new Set(['passed', 'none'])

export type HistoryRow = { v: 1; id: string; role: string; model: string; clean: boolean; costUsd: number; minutes: number; at: string; project: string }

/** Answered, never stuck, never asked to wrap up, and every task it held ended done with its gate passed, none or not run. */
export function isClean(s: SwarmState, a: AgentState): boolean {
  if (a.outcome !== 'answer' || a.stuckBy !== undefined) return false
  if (a.guard !== undefined && (a.guard.timeAct !== null || a.guard.costAct !== null)) return false
  for (const t of Object.values(s.tasks)) {
    if (t.assignee === null || (t.assignee !== a.name && t.assignee !== a.id)) continue
    if (t.state !== 'done') return false
    if (t.gate !== null && !CLEAN_GATES.has(t.gate.result)) return false
  }
  return true
}

/** One row per finished subagent with a known model and a valid role. None for a bad project key. */
export function rowsFromState(s: SwarmState, project: string): HistoryRow[] {
  if (!PROJECT.test(project)) return []
  const rows: HistoryRow[] = []
  for (const a of Object.values(s.agents)) {
    if (a.id === LEAD || a.placeholder || a.finishedAt === null || a.model === null) continue
    if (!ROLE.test(a.role) || !ROLE.test(a.model)) continue
    const id = `${s.swarm.id}/${a.id}`
    if (id.length > MAX_ID) continue
    rows.push({
      v: 1, id, role: a.role, model: a.model, clean: isClean(s, a),
      costUsd: Math.round(a.costUsd * 100) / 100,
      minutes: Math.round(Math.max(0, a.activeMs) / 60_000),
      at: new Date(a.finishedAt).toISOString(), project,
    })
  }
  return rows
}

const count = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= MAX_NUMBER
const str = (x: unknown): x is string => typeof x === 'string'

/** A stored row, or null for anything that fails a check. Extra fields are dropped. */
export function parseRow(line: string): HistoryRow | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const { id, role, model, clean, costUsd, minutes, at, project } = r
  if (r.v !== 1 || !str(id) || id.length === 0 || id.length > MAX_ID) return null
  if (!str(role) || !ROLE.test(role) || !str(model) || !ROLE.test(model) || typeof clean !== 'boolean') return null
  if (!count(costUsd) || !count(minutes) || !str(at) || Number.isNaN(Date.parse(at)) || !str(project) || !PROJECT.test(project)) return null
  return { v: 1, id, role, model, clean, costUsd, minutes, at, project }
}

export const rowLine = (r: HistoryRow): string => `${JSON.stringify(r)}\n`
```

Check `fold.ts` for how `agent.stuck` sets `stuckBy` and `guard.nudged` sets `guard.timeAct`/`costAct`; if an event in the tests needs another field to fold, fix the test event, not the module.

- [ ] **Step 4: Run the tests to see them pass**

Run: `node --test tests/core/history.test.ts` then `npm run check`
Expected: PASS, and `mod-safe` still passes.

- [ ] **Step 5: Commit**

```bash
git add src/core/history.ts tests/core/history.test.ts
git commit -m "Build outcome rows for model hints from the folded state"
```

---

### Task 2: The hint rule (`src/core/hints.ts`)

**Files:**
- Create: `src/core/hints.ts`
- Test: `tests/core/hints.test.ts`

**Interfaces:**
- Consumes: `type HistoryRow` from `src/core/history.ts` (type-only import; T1 builds that file in parallel, so until merge declare nothing else from it). Tests build rows by hand.
- Produces: the `hints.ts` part of the shared contract.

Note for the worktree: T1 lands `history.ts` in parallel. To typecheck alone, create a temporary `src/core/history.ts` holding only the `HistoryRow` type from the shared contract, and do **not** commit it (`git add` only your two files). The integrator merges T1's real file.

- [ ] **Step 1: Write the failing tests** in `tests/core/hints.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hintLines, hintStats, hintsText, tierOf } from '../../src/core/hints.ts'
import type { HistoryRow } from '../../src/core/history.ts'

let n = 0
const row = (role: string, model: string, clean: boolean, costUsd = 1, minutes = 5): HistoryRow =>
  ({ v: 1, id: `s/a${n++}`, role, model, clean, costUsd, minutes, at: '2026-10-25T10:00:00.000Z', project: '0123456789abcdef' })
/** `cleanCount` clean rows then the rest not clean, `runs` in all. */
const runs = (role: string, model: string, runCount: number, cleanCount: number, costUsd = 1): HistoryRow[] =>
  Array.from({ length: runCount }, (_, i) => row(role, model, i < cleanCount, costUsd))
const H = 'claude-haiku-5-5', S = 'claude-sonnet-5-5', O = 'claude-opus-5-5'

test('tierOf reads haiku, sonnet and opus from the model id, and nothing else', () => {
  assert.equal(tierOf(H), 1)
  assert.equal(tierOf('Claude-Sonnet-4-6'), 2)
  assert.equal(tierOf(O), 3)
  assert.equal(tierOf('gpt-5'), null)
})

test('a cheaper tier within 10 points gets a try line with both records and average costs', () => {
  const lines = hintLines([...runs('dev', S, 8, 7, 0.41), ...runs('dev', O, 10, 9, 1.8)], [])
  assert.deepEqual(lines, ["dev: Sonnet finished clean 7 of 8 (≈$0.41 avg) vs Opus 9 of 10 (≈$1.80). Try model: 'sonnet'."])
})

test('exactly 10 points below still counts as cheaper; 11 does not', () => {
  assert.equal(hintLines([...runs('dev', S, 5, 4), ...runs('dev', O, 10, 9)], []).length, 1)
  assert.deepEqual(hintLines([...runs('dev', S, 100, 79), ...runs('dev', O, 10, 9)], []), [])
})

test('the cheapest tier that qualifies is the one hinted', () => {
  const lines = hintLines([...runs('dev', H, 5, 5), ...runs('dev', S, 5, 5), ...runs('dev', O, 5, 5)], [])
  assert.match(lines[0]!, /^dev: Haiku .* vs Opus .*Try model: 'haiku'\.$/)
})

test('25 or more points below gives a keep line; 24 gives nothing', () => {
  assert.deepEqual(hintLines([...runs('sec', H, 5, 3), ...runs('sec', S, 20, 17)], []), ['sec: Haiku finished clean 3 of 5 vs Sonnet 17 of 20. Keep it on Sonnet.'])
  assert.deepEqual(hintLines([...runs('sec', H, 25, 15), ...runs('sec', S, 25, 21)], []), [])
})

test('fewer than 5 runs on a tier, or one tier only, gives no hint', () => {
  assert.deepEqual(hintLines([...runs('dev', S, 4, 4), ...runs('dev', O, 10, 10)], []), [])
  assert.deepEqual(hintLines(runs('dev', O, 50, 50), []), [])
})

test('a role short of evidence in the project falls back to machine rows, labelled', () => {
  const machine = [...runs('dev', S, 6, 6, 0.5), ...runs('dev', O, 6, 6, 2)]
  assert.deepEqual(hintLines(runs('dev', O, 3, 3), machine), ["dev: Sonnet finished clean 6 of 6 (≈$0.50 avg) vs Opus 6 of 6 (≈$2.00). Try model: 'sonnet' (across projects)."])
  assert.deepEqual(hintLines([...runs('sec', H, 6, 1), ...runs('sec', S, 6, 6)].map(r => r), []), ['sec: Haiku finished clean 1 of 6 vs Sonnet 6 of 6. Keep it on Sonnet.'])
  assert.deepEqual(hintLines([], [...runs('sec', H, 6, 1), ...runs('sec', S, 6, 6)]), ['sec: Haiku finished clean 1 of 6 vs Sonnet 6 of 6. Keep it on Sonnet (across projects).'])
})

test('project rows win when they qualify, even when machine rows disagree', () => {
  const project = [...runs('dev', S, 5, 5), ...runs('dev', O, 5, 5)]
  const machine = [...runs('dev', S, 50, 0), ...runs('dev', O, 50, 50)]
  assert.match(hintLines(project, machine)[0]!, /Try model: 'sonnet'\.$/)
})

test('at most 5 lines, largest sample first, then by role', () => {
  const rows = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].flatMap((role, i) => [...runs(role, S, 5 + i, 5 + i), ...runs(role, O, 5, 5)])
  const lines = hintLines(rows, [])
  assert.equal(lines.length, 5)
  assert.deepEqual(lines.map(l => l.split(':')[0]), ['g', 'f', 'e', 'd', 'c'])
  const tie = hintLines([...runs('b', S, 5, 5), ...runs('b', O, 5, 5), ...runs('a', S, 5, 5), ...runs('a', O, 5, 5)], [])
  assert.deepEqual(tie.map(l => l.split(':')[0]), ['a', 'b'])
})

test('rows with an unknown model are left out of tiering', () => {
  assert.deepEqual(hintLines([...runs('dev', 'gpt-5', 10, 10), ...runs('dev', O, 10, 10)], []), [])
})

test('hintStats averages cost and minutes per role and tier from the chosen source', () => {
  const stats = hintStats([row('dev', S, true, 1, 4), row('dev', S, false, 2, 8)], [])
  assert.deepEqual(stats, [{ role: 'dev', tier: 2, runs: 2, clean: 1, avgUsd: 1.5, avgMin: 6, source: 'project' }])
})

test('hintsText says so when there is no history, and lists the table and hints when there is', () => {
  assert.equal(hintsText([], []), 'No run history yet. Hints appear once a role has 5 or more finished runs on each of two models.')
  const text = hintsText([...runs('dev', S, 8, 7, 0.41), ...runs('dev', O, 10, 9, 1.8)], [])
  assert.match(text, /^Model history \(role · model · runs · clean · avg cost · avg minutes · source\):\n- dev · Sonnet · 8 · 7 · ≈\$0\.41 · 5 · project\n- dev · Opus · 10 · 9 · ≈\$1\.80 · 5 · project\n\nHints:\n- dev: Sonnet/)
  assert.match(hintsText(runs('dev', O, 3, 3), []), /\n\nNo hints yet: no role has 5 or more runs on each of two models\.$/)
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test tests/core/hints.test.ts`
Expected: FAIL, cannot find module `src/core/hints.ts`.

- [ ] **Step 3: Implement** `src/core/hints.ts`:

```ts
/** Model hints (spec 2026-10-25 section 5): from outcome rows to at most five lines for the lead. Pure. */
import type { HistoryRow } from './history.ts'

export type Tier = 1 | 2 | 3
export type Source = 'project' | 'machine'
export type HintStat = { role: string; tier: Tier; runs: number; clean: number; avgUsd: number; avgMin: number; source: Source }

export const MIN_RUNS = 5
export const CHEAPER_WITHIN = 10
export const KEEP_BELOW = 25
export const MAX_HINTS = 5
const MAX_TABLE = 40
const NAMES: Record<Tier, string> = { 1: 'Haiku', 2: 'Sonnet', 3: 'Opus' }
const ALIAS: Record<Tier, string> = { 1: 'haiku', 2: 'sonnet', 3: 'opus' }
const NO_HISTORY = 'No run history yet. Hints appear once a role has 5 or more finished runs on each of two models.'
const NO_HINTS = 'No hints yet: no role has 5 or more runs on each of two models.'

export function tierOf(model: string): Tier | null {
  const m = model.toLowerCase()
  if (m.includes('haiku')) return 1
  if (m.includes('sonnet')) return 2
  if (m.includes('opus')) return 3
  return null
}

const round = (x: number, places: number): number => Math.round(x * 10 ** places) / 10 ** places

/** Per role, its tiers' stats in tier order. Rows with an unknown model are skipped. */
function statsBy(rows: readonly HistoryRow[], source: Source): Map<string, HintStat[]> {
  const sums = new Map<string, { role: string; tier: Tier; runs: number; clean: number; usd: number; min: number }>()
  for (const r of rows) {
    const tier = tierOf(r.model)
    if (tier === null) continue
    const key = `${r.role}\u0000${tier}`
    const s = sums.get(key) ?? { role: r.role, tier, runs: 0, clean: 0, usd: 0, min: 0 }
    s.runs += 1
    s.clean += r.clean ? 1 : 0
    s.usd += r.costUsd
    s.min += r.minutes
    sums.set(key, s)
  }
  const out = new Map<string, HintStat[]>()
  for (const s of sums.values()) {
    const list = out.get(s.role) ?? []
    list.push({ role: s.role, tier: s.tier, runs: s.runs, clean: s.clean, avgUsd: round(s.usd / s.runs, 2), avgMin: round(s.min / s.runs, 1), source })
    out.set(s.role, list)
  }
  for (const list of out.values()) list.sort((a, b) => a.tier - b.tier)
  return out
}

const qualifies = (stats: readonly HintStat[]): boolean => stats.filter(s => s.runs >= MIN_RUNS).length >= 2
/** Clean rate in points. Integer maths first, so 3 of 5 is exactly 60. */
const rate = (s: HintStat): number => (s.clean * 100) / s.runs
const usd = (x: number): string => `≈$${x.toFixed(2)}`
const byRole = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** Each role's stats from the project when they qualify, else the machine when those do, else whichever has rows. */
export function hintStats(project: readonly HistoryRow[], machine: readonly HistoryRow[]): HintStat[] {
  const p = statsBy(project, 'project')
  const m = statsBy(machine, 'machine')
  const roles = [...new Set([...p.keys(), ...m.keys()])].sort(byRole)
  return roles.flatMap(role => {
    const ps = p.get(role) ?? []
    const ms = m.get(role) ?? []
    return qualifies(ps) ? ps : qualifies(ms) ? ms : ps.length > 0 ? ps : ms
  })
}

type Hint = { role: string; runs: number; text: string }

function hintFor(role: string, stats: readonly HintStat[]): Hint | null {
  const q = stats.filter(s => s.runs >= MIN_RUNS)
  if (q.length < 2) return null
  const top = q[q.length - 1]!
  const cheaper = q.slice(0, -1)
  const label = top.source === 'machine' ? ' (across projects)' : ''
  const low = cheaper.find(s => rate(s) >= rate(top) - CHEAPER_WITHIN)
  if (low !== undefined) {
    return {
      role, runs: low.runs + top.runs,
      text: `${role}: ${NAMES[low.tier]} finished clean ${low.clean} of ${low.runs} (${usd(low.avgUsd)} avg) vs ${NAMES[top.tier]} ${top.clean} of ${top.runs} (${usd(top.avgUsd)}). Try model: '${ALIAS[low.tier]}'${label}.`,
    }
  }
  const bad = cheaper.find(s => rate(s) <= rate(top) - KEEP_BELOW)
  if (bad === undefined) return null
  return {
    role, runs: bad.runs + top.runs,
    text: `${role}: ${NAMES[bad.tier]} finished clean ${bad.clean} of ${bad.runs} vs ${NAMES[top.tier]} ${top.clean} of ${top.runs}. Keep it on ${NAMES[top.tier]}${label}.`,
  }
}

/** At most MAX_HINTS lines, largest sample first, then by role. */
export function hintLines(project: readonly HistoryRow[], machine: readonly HistoryRow[]): string[] {
  const grouped = new Map<string, HintStat[]>()
  for (const s of hintStats(project, machine)) grouped.set(s.role, [...(grouped.get(s.role) ?? []), s])
  const hints = [...grouped].map(([role, stats]) => hintFor(role, stats)).filter((h): h is Hint => h !== null)
  hints.sort((a, b) => b.runs - a.runs || byRole(a.role, b.role))
  return hints.slice(0, MAX_HINTS).map(h => h.text)
}

/** /omnis hints: the table, then the hint lines. */
export function hintsText(project: readonly HistoryRow[], machine: readonly HistoryRow[]): string {
  const stats = hintStats(project, machine)
  if (stats.length === 0) return NO_HISTORY
  const table = stats.slice(0, MAX_TABLE).map(s => `- ${s.role} · ${NAMES[s.tier]} · ${s.runs} · ${s.clean} · ${usd(s.avgUsd)} · ${s.avgMin} · ${s.source}`)
  const lines = hintLines(project, machine)
  const tail = lines.length > 0 ? ['Hints:', ...lines.map(l => `- ${l}`)] : [NO_HINTS]
  return ['Model history (role · model · runs · clean · avg cost · avg minutes · source):', ...table, '', ...tail].join('\n')
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `node --test tests/core/hints.test.ts` then `npm run check`
Expected: PASS.

- [ ] **Step 5: Commit** (only your two files; never the temporary `history.ts`)

```bash
git add src/core/hints.ts tests/core/hints.test.ts
git commit -m "Turn outcome rows into model hints"
```

---

### Task 3: `/omnis hints` in the mod

**Files:**
- Modify: `src/core/recording.ts` (add `HINTS_TOOL`, extend `INTERNAL_TOOL`)
- Modify: `src/mod/guard.ts` (`DENY_REASON` names `omnis_hints`)
- Create: `src/mod/hints-command.ts`
- Modify: `src/mod/commands.ts` (one import, one `SUBS` entry, one `case`)
- Test: `src/mod/hints-command.test.ts` (kit), and update any test asserting `INTERNAL_TOOL` or `DENY_REASON` text (`tests/core/recording.test.ts`, `tests/mcp/record-guard.test.ts`, `src/mod/guard.test.ts`, `src/mod/commands.test.ts`).

**Interfaces:**
- Consumes: `connectServer` from `src/mod/server.ts` (as `run-report.ts` uses it), `RUN`, `engine` from `src/mod/test-engine.ts`.
- Produces: `HINTS_TOOL = 'omnis_hints'` in `src/core/recording.ts`; `/omnis hints` calls it with `{}` and shows its text.

- [ ] **Step 1: Write the failing kit test** `src/mod/hints-command.test.ts`:

```ts
// src/mod/hints-command.test.ts
import { expect, test, type TestBody } from 'claude-code/testing'
import { RUN, engine } from './test-engine.ts'

const LOADED = { timeoutMs: 60000 }
const start = ($: Parameters<TestBody>[0]) => $.session.start({ cwd: '/p', surface: null, isInteractive: true })

test('/omnis hints asks the server and shows its text', LOADED, async ($, on) => {
  const seen = engine(on)
  seen.onTool = tool => (tool === 'omnis_hints' ? 'Model history (role · model · runs · clean · avg cost · avg minutes · source):\n- dev · Opus · 3 · 3 · ≈$1.00 · 5 · project' : null)
  await start($)
  const reply = await $.command.run({ command: 'omnis', args: 'hints', ...RUN })
  expect(reply.text).toBe('Model history (role · model · runs · clean · avg cost · avg minutes · source):\n- dev · Opus · 3 · 3 · ≈$1.00 · 5 · project')
  expect(seen.calls.find(c => c.tool === 'omnis_hints')!.args).toEqual({})
})

test('/omnis hints with extra words answers the usage and calls nothing', LOADED, async ($, on) => {
  const seen = engine(on)
  await start($)
  expect((await $.command.run({ command: 'omnis', args: 'hints now', ...RUN })).text).toBe('Usage: /omnis hints shows which models past runs did well on.')
  expect(seen.calls.some(c => c.tool === 'omnis_hints')).toBe(false)
})
```

Read `src/mod/test-engine.ts` first: if `engine` answers an unknown tool differently or needs a server connect step, follow how `src/mod/export-command.test.ts` and the report command's kit test do it.

- [ ] **Step 2: Run to see it fail**

Run: `npm run test:mod`
Expected: FAIL on the hints tests (the command answers the usage for `hints`).

- [ ] **Step 3: Implement.**

`src/core/recording.ts`, beside the other tool names (keep the doc-comment style of its neighbours):

```ts
/** Internal: the model hints table for /omnis hints (spec 2026-10-25 section 6). */
export const HINTS_TOOL = 'omnis_hints'
```

and change the pattern to:

```ts
export const INTERNAL_TOOL = /^mcp__.+__omnis_(record|feed|replay|export|report|fence|gate_plan|gate_approve|handoff|hints)$/
```

`src/mod/guard.ts` `DENY_REASON`: insert `omnis_hints` so it reads `... omnis_gate_approve, omnis_handoff and omnis_hints are internal ...` (keep the rest of the sentence).

`src/mod/hints-command.ts`:

```ts
/** /omnis hints (spec 2026-10-25 section 6): the model history table and hint lines, from the server. */
import type { EngineInterface } from 'claude-code'
import { HINTS_TOOL } from '../core/recording.ts'
import type { Sub } from './commands.ts'
import { connectServer } from './server.ts'

const USAGE = 'Usage: /omnis hints shows which models past runs did well on.'
const MAX_TEXT = 4000

export const hintsSub: Sub = {
  name: 'hints',
  describe: '/omnis hints shows which models past runs did well on',
  hint: 'hints',
  usage: USAGE,
}

/** `words` are the lower-cased words after /omnis, "hints" first. */
export async function hintsCommand($: EngineInterface, words: readonly string[]): Promise<string | null> {
  if (words.length !== 1) return USAGE
  try {
    const server = await connectServer($)
    if (server === null) return 'The swarm server is not connected yet; try again in a moment.'
    const result = await $.mcp.call(server, HINTS_TOOL, {})
    const block = result.content[0]
    const text = block !== undefined && block.type === 'text' && typeof block.text === 'string' ? block.text.slice(0, MAX_TEXT) : ''
    if (text === '') return 'The model history could not be read.'
    return result.isError === true ? `No hints: ${text}` : text
  } catch {
    return 'The model history could not be read.'
  }
}
```

`src/mod/commands.ts`: add `import { hintsCommand, hintsSub } from './hints-command.ts'`, append `hintsSub` to `SUBS` (after `reportSub`), and add `case 'hints': return (await hintsCommand($, words)) ?? USAGE`.

Then update the tests that pin `INTERNAL_TOOL` matches, `DENY_REASON` text, `COMMAND_DESCRIPTION`, `COMMAND_HINT` or `USAGE`, to include hints. Search: `grep -rn "gate_approve\|COMMAND_HINT\|COMMAND_DESCRIPTION\|omnis_handoff" tests src/mod/*.test.ts`.

- [ ] **Step 4: Run to see it pass**

Run: `npm run check`
Expected: PASS (node and kit).

- [ ] **Step 5: Commit**

```bash
git add src/core/recording.ts src/mod/guard.ts src/mod/hints-command.ts src/mod/hints-command.test.ts src/mod/commands.ts <the updated tests>
git commit -m "Add /omnis hints and keep omnis_hints internal"
```

---

### Task 4: Stores, backfill and server wiring

**Files:**
- Create: `src/mcp/history-store.ts`, `src/mcp/tools/hints.ts`
- Modify: `src/mcp/tools.ts` (`ToolContext.hints`, the init reply, pass hints to `writeReport` on swarm end), `src/mcp/tools/report.ts` (`writeReport` records rows and adds hints), `src/core/report.ts` (`reportMarkdown` takes hint lines), `src/mcp/registry.ts` (one factory)
- Test: `tests/mcp/history-store.test.ts`, `tests/mcp/hints-tool.test.ts`, one new case in `tests/core/report.test.ts`

Do **not** edit `.claude-plugin/plugin.json`, `src/mcp/server.ts`, `package.json` or the README: the lead does those.

**Interfaces:**
- Consumes: `HistoryRow`, `rowsFromState`, `parseRow`, `rowLine` (T1); `hintLines`, `hintsText` (T2); `HINTS_TOOL` (T3); `foldAll`, `readEvents`, `sortEvents`, `swarmLogPath`, `logPaths`, `ensureLogDirs`, `isLink`.
- Produces (the lead wires `server.ts` with these):

```ts
export type HintsMode = 'on' | 'project' | 'off'
export type HintsOptions = { mode: HintsMode; machineDir: string | null }
export const HINTS_OFF: HintsOptions
export function hintsOptions(env: Record<string, string | undefined>): HintsOptions  // reads OMNIS_MODEL_HINTS, OMNIS_DATA_DIR
export function projectKey(root: string): string
export function readRows(file: string): HistoryRow[]                 // newest first, at most MAX_ROWS
export function ensureBackfill(root: string, skip?: string): void
export function recordRun(root: string, session: Session, swarm: string, opts: HintsOptions): void
export function loadRows(root: string, opts: HintsOptions): { project: HistoryRow[]; machine: HistoryRow[] }
export function hintBlock(root: string, opts: HintsOptions): string  // '' or '\n\nModel hints from past runs:\n- …'
```

- [ ] **Step 1: Write the failing store tests** `tests/mcp/history-store.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendEvent } from '../../src/core/log.ts'
import { rowLine, type HistoryRow } from '../../src/core/history.ts'
import { ensureBackfill, hintBlock, hintsOptions, loadRows, projectKey, readRows, recordRun } from '../../src/mcp/history-store.ts'
import { Session } from '../../src/mcp/session.ts'
import { ev, tmpRoot } from '../helpers.ts'

const store = (root: string) => join(root, '.omnis-swarm', 'history.jsonl')
const lines = (file: string) => readFileSync(file, 'utf8').split('\n').filter(Boolean)

/** One swarm `id` with one finished agent `agent` on `model`. */
function runSwarm(root: string, id: string, agent: string, model = 'claude-sonnet-5-5') {
  appendEvent(root, ev('swarm.started', { name: id, topology: 'hierarchical', implicit: false }, { swarm: id, src: 'mcp' }))
  appendEvent(root, ev('agent.started', { name: agent, role: 'omnis-developer', description: 'secret prompt words', parent: 'lead' }, { swarm: id, agent, atSec: 1 }))
  appendEvent(root, ev('agent.usage', { model, input: 10, output: 10, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, { swarm: id, agent, atSec: 2 }))
  appendEvent(root, ev('agent.finished', { outcome: 'answer' }, { swarm: id, agent, atSec: 60 }))
}
const on = (machineDir: string | null) => ({ mode: 'on' as const, machineDir })

test('hintsOptions: on by default, project and off honoured, the data folder only when on, absolute and expanded', () => {
  assert.deepEqual(hintsOptions({}), { mode: 'on', machineDir: null })
  assert.equal(hintsOptions({ OMNIS_MODEL_HINTS: 'project', OMNIS_DATA_DIR: '/d' }).machineDir, null)
  assert.equal(hintsOptions({ OMNIS_MODEL_HINTS: 'off' }).mode, 'off')
  assert.equal(hintsOptions({ OMNIS_MODEL_HINTS: 'nonsense' }).mode, 'on')
  assert.equal(hintsOptions({ OMNIS_DATA_DIR: '${CLAUDE_PLUGIN_DATA}' }).machineDir, null)
  assert.equal(hintsOptions({ OMNIS_DATA_DIR: 'relative/dir' }).machineDir, null)
  assert.notEqual(hintsOptions({ OMNIS_DATA_DIR: tmpRoot() }).machineDir, null)
})

test('projectKey is 16 lowercase hex and stable for the same folder', () => {
  const root = tmpRoot()
  assert.match(projectKey(root), /^[0-9a-f]{16}$/)
  assert.equal(projectKey(root), projectKey(`${root}/`))
})

test('recordRun writes each finished agent once to the project and machine stores, with no prompt text', () => {
  const root = tmpRoot()
  const machine = tmpRoot()
  runSwarm(root, 'alpha', 'dev-1')
  const session = new Session(root)
  recordRun(root, session, 'alpha', on(machine))
  recordRun(root, session, 'alpha', on(machine))
  assert.equal(lines(store(root)).length, 1)
  assert.equal(lines(join(machine, 'history.jsonl')).length, 1)
  assert.equal(readFileSync(store(root), 'utf8').includes('secret prompt words'), false)
})

test('off writes nothing; project never touches the machine store', () => {
  const root = tmpRoot()
  const machine = tmpRoot()
  runSwarm(root, 'alpha', 'dev-1')
  recordRun(root, new Session(root), 'alpha', { mode: 'off', machineDir: machine })
  assert.equal(existsSync(store(root)), false)
  recordRun(root, new Session(root), 'alpha', { mode: 'project', machineDir: machine })
  assert.equal(lines(store(root)).length, 1)
  assert.equal(existsSync(join(machine, 'history.jsonl')), false)
})

test('a machine store that cannot be written is skipped and the project store still gets the row', () => {
  const root = tmpRoot()
  runSwarm(root, 'alpha', 'dev-1')
  const blocker = join(tmpRoot(), 'file')
  writeFileSync(blocker, 'x')
  recordRun(root, new Session(root), 'alpha', on(join(blocker, 'sub')))
  assert.equal(lines(store(root)).length, 1)
})

test('backfill folds every old log once, the first time the store is missing', () => {
  const root = tmpRoot()
  runSwarm(root, 'alpha', 'dev-1')
  runSwarm(root, 'beta', 'dev-2', 'claude-opus-5-5')
  ensureBackfill(root)
  assert.deepEqual(lines(store(root)).map(l => (JSON.parse(l) as HistoryRow).id).sort(), ['alpha/dev-1', 'beta/dev-2'])
  runSwarm(root, 'gamma', 'dev-3')
  ensureBackfill(root)
  assert.equal(lines(store(root)).length, 2)
})

test('backfill with no log folder creates nothing', () => {
  const root = tmpRoot()
  ensureBackfill(root)
  assert.equal(existsSync(join(root, '.omnis-swarm')), false)
})

test('readRows reads newest first, skips bad lines, caps at 500 and refuses a link', () => {
  const root = tmpRoot()
  mkdirSync(join(root, '.omnis-swarm'))
  const row = (i: number): HistoryRow => ({ v: 1, id: `s/a${i}`, role: 'r', model: 'claude-opus-5-5', clean: true, costUsd: 0, minutes: 0, at: '2026-10-25T10:00:00.000Z', project: '0123456789abcdef' })
  writeFileSync(store(root), [...Array.from({ length: 600 }, (_, i) => rowLine(row(i))), 'not json\n'].join(''))
  const rows = readRows(store(root))
  assert.equal(rows.length, 500)
  assert.equal(rows[0]!.id, 's/a599')
  const link = join(root, 'link.jsonl')
  try {
    symlinkSync(store(root), link)
  } catch {
    return // no symlink rights on this machine
  }
  assert.deepEqual(readRows(link), [])
  assert.deepEqual(readRows(join(root, 'missing.jsonl')), [])
})

test('hintBlock is empty without enough evidence and lists hints when there is', () => {
  const root = tmpRoot()
  assert.equal(hintBlock(root, on(null)), '')
  for (let i = 0; i < 5; i++) runSwarm(root, `s${i}`, `a${i}`, 'claude-sonnet-5-5')
  for (let i = 5; i < 10; i++) runSwarm(root, `s${i}`, `a${i}`, 'claude-opus-5-5')
  const block = hintBlock(root, on(null))
  assert.match(block, /^\n\nModel hints from past runs:\n- omnis-developer: Sonnet finished clean 5 of 5 /)
  assert.equal(hintBlock(root, { mode: 'off', machineDir: null }), '')
  assert.deepEqual(loadRows(root, { mode: 'off', machineDir: null }), { project: [], machine: [] })
})
```

- [ ] **Step 2: Run to see them fail**

Run: `node --test tests/mcp/history-store.test.ts`
Expected: FAIL, cannot find module `src/mcp/history-store.ts`.

- [ ] **Step 3: Implement** `src/mcp/history-store.ts`:

```ts
/**
 * The outcome-row stores for model hints (spec 2026-10-25 sections 3, 4, 7, 8): `.omnis-swarm/history.jsonl` and one
 * `history.jsonl` in the plugin's data folder. Best effort throughout: nothing here may fail a report, an init or a call.
 */
import { createHash } from 'node:crypto'
import { appendFileSync, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { isOneOf, isValidSwarmId } from '../core/events.ts'
import { foldAll } from '../core/fold.ts'
import { hintLines } from '../core/hints.ts'
import { parseRow, rowLine, rowsFromState, type HistoryRow } from '../core/history.ts'
import { ensureLogDirs, isLink, logPaths, readEvents, sortEvents, swarmLogPath } from '../core/log.ts'
import type { SwarmEvent } from '../core/events.ts'
import type { Session } from './session.ts'

export const HINTS_MODES = ['on', 'project', 'off'] as const
export type HintsMode = (typeof HINTS_MODES)[number]
export type HintsOptions = { mode: HintsMode; machineDir: string | null }
export const HINTS_OFF: HintsOptions = Object.freeze({ mode: 'off', machineDir: null })
export const MAX_ROWS = 500
const MAX_BYTES = 262_144
const FILE = 'history.jsonl'

const usable = (x: string | undefined): x is string => x !== undefined && x.trim() !== '' && !x.includes('${')

export function hintsOptions(env: Record<string, string | undefined>): HintsOptions {
  const raw = env.OMNIS_MODEL_HINTS?.trim()
  const mode: HintsMode = isOneOf(HINTS_MODES, raw) ? raw : 'on'
  const dir = env.OMNIS_DATA_DIR
  const machineDir = mode === 'on' && usable(dir) && isAbsolute(dir.trim()) ? resolve(dir.trim()) : null
  return { mode, machineDir }
}

export function projectKey(root: string): string {
  const path = resolve(root)
  return createHash('sha256').update(process.platform === 'win32' ? path.toLowerCase() : path).digest('hex').slice(0, 16)
}

const projectStore = (root: string): string => join(logPaths(root).dir, FILE)
const machineStore = (dir: string): string => join(dir, FILE)

/** Newest first, at most MAX_ROWS, from the file's last MAX_BYTES. Missing, linked or unreadable reads as empty. */
export function readRows(file: string): HistoryRow[] {
  try {
    if (lstatSync(file, { throwIfNoEntry: false }) === undefined || isLink(file)) return []
    const fd = openSync(file, 'r')
    let text: string
    let start: number
    try {
      const size = fstatSync(fd).size
      start = Math.max(0, size - MAX_BYTES)
      const buf = Buffer.alloc(size - start)
      readSync(fd, buf, 0, buf.length, start)
      text = buf.toString('utf8')
    } finally {
      closeSync(fd)
    }
    const all = text.split('\n')
    if (start > 0) all.shift() // the first line may be cut
    return all.map(l => l.trim()).filter(Boolean).map(parseRow).filter((r): r is HistoryRow => r !== null).slice(-MAX_ROWS).reverse()
  } catch {
    return []
  }
}

function appendRows(file: string, rows: readonly HistoryRow[]): void {
  if (rows.length === 0) return
  if (isLink(file)) throw new Error(`refusing to write through a link: ${file}`)
  appendFileSync(file, rows.map(rowLine).join(''))
}

/** Every event of a log, read in pages. */
function allEvents(file: string): SwarmEvent[] {
  const events: SwarmEvent[] = []
  let offset = 0
  for (;;) {
    const page = readEvents(file, offset)
    events.push(...page.events)
    if (page.offset <= offset) break
    offset = page.offset
  }
  return events
}

/** The first time the project store is missing, folds every old log once (bar `skip`, the swarm being reported, whose rows recordRun writes to both stores) and writes their rows. */
export function ensureBackfill(root: string, skip?: string): void {
  try {
    const file = projectStore(root)
    if (lstatSync(file, { throwIfNoEntry: false }) !== undefined) return
    const dir = logPaths(root).swarms
    if (lstatSync(dir, { throwIfNoEntry: false }) === undefined || isLink(dir)) return
    const key = projectKey(root)
    const ids = readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => f.slice(0, -6)).filter(id => isValidSwarmId(id) && id !== skip)
    const rows = ids.flatMap(id => {
      const path = swarmLogPath(root, id)
      return isLink(path) ? [] : rowsFromState(foldAll(id, sortEvents(allEvents(path))), key)
    })
    ensureLogDirs(root)
    writeFileSync(file, rows.map(rowLine).join(''), { flag: 'wx' }) // wx: another writer got there first, theirs stands
  } catch {
    // A failed backfill leaves hints quieter, nothing else.
  }
}

/** After a report: appends rows for the swarm's finished agents not yet in the project store, then the machine store. */
export function recordRun(root: string, session: Session, swarm: string, opts: HintsOptions): void {
  if (opts.mode === 'off') return
  try {
    ensureBackfill(root, swarm)
    const have = new Set(readRows(projectStore(root)).map(r => r.id))
    const rows = rowsFromState(session.state(swarm).state, projectKey(root)).filter(r => !have.has(r.id))
    if (rows.length === 0) return
    ensureLogDirs(root)
    appendRows(projectStore(root), rows)
    if (opts.mode === 'on' && opts.machineDir !== null) {
      try {
        if (isLink(opts.machineDir)) return
        mkdirSync(opts.machineDir, { recursive: true })
        appendRows(machineStore(opts.machineDir), rows)
      } catch {
        // The machine store is best effort.
      }
    }
  } catch (err) {
    process.stderr.write(`omnis: model history not written: ${err instanceof Error ? err.message : String(err)}\n`)
  }
}

export function loadRows(root: string, opts: HintsOptions): { project: HistoryRow[]; machine: HistoryRow[] } {
  if (opts.mode === 'off') return { project: [], machine: [] }
  ensureBackfill(root)
  const project = readRows(projectStore(root))
  const machine = opts.mode === 'on' && opts.machineDir !== null ? readRows(machineStore(opts.machineDir)) : []
  return { project, machine }
}

/** Control and format characters out, so a stored role can't steer the terminal. */
const plain = (s: string): string => s.replace(/[\p{Cc}\p{Cf}]/gu, '')

/** The init reply's block: '' when there is nothing to say. */
export function hintBlock(root: string, opts: HintsOptions): string {
  try {
    const { project, machine } = loadRows(root, opts)
    const lines = hintLines(project, machine)
    return lines.length === 0 ? '' : `\n\nModel hints from past runs:\n${lines.map(l => `- ${plain(l)}`).join('\n')}`
  } catch {
    return ''
  }
}
```

Check `readEvents`'s `ReadResult` (`src/core/log.ts`): if `offset` does not advance at end of file the loop stops; if a page can return zero events while advancing, the loop still ends once `offset` stops moving. Adjust to match the real semantics.

- [ ] **Step 4: Run the store tests to see them pass**

Run: `node --test tests/mcp/history-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing wiring tests.**

`tests/mcp/hints-tool.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendEvent } from '../../src/core/log.ts'
import { Session } from '../../src/mcp/session.ts'
import { createHintsTools } from '../../src/mcp/tools/hints.ts'
import { createReportTools } from '../../src/mcp/tools/report.ts'
import { createTools } from '../../src/mcp/tools.ts'
import { ev, tmpRoot } from '../helpers.ts'
import { syncResult } from './sync.ts'

const NOW = new Date('2026-10-25T10:05:00.000Z')
const ON = { mode: 'on' as const, machineDir: null }
function setup(hints?: typeof ON | { mode: 'off'; machineDir: null }) {
  const root = tmpRoot()
  const session = new Session(root)
  const ctx = { root, session, now: () => NOW, ...(hints !== undefined && { hints }) }
  const tools = [...createTools(ctx), ...createReportTools(ctx), ...createHintsTools(ctx)]
  const tool = (name: string, args: Record<string, unknown> = {}) => syncResult(tools.find(t => t.name === name)!.handler(args))
  return { root, tool }
}
function pastRuns(root: string) {
  for (let i = 0; i < 10; i++) {
    const id = `old${i}`, agent = `a${i}`, model = i < 5 ? 'claude-sonnet-5-5' : 'claude-opus-5-5'
    appendEvent(root, ev('swarm.started', { name: id, topology: 'hierarchical', implicit: false }, { swarm: id, src: 'mcp' }))
    appendEvent(root, ev('agent.started', { name: agent, role: 'omnis-developer', description: '', parent: 'lead' }, { swarm: id, agent, atSec: 1 }))
    appendEvent(root, ev('agent.usage', { model, input: 10, output: 10, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, { swarm: id, agent, atSec: 2 }))
    appendEvent(root, ev('agent.finished', { outcome: 'answer' }, { swarm: id, agent, atSec: 60 }))
  }
}

test('omnis_swarm_init carries the hint block when hints are on and there is evidence', () => {
  const { root, tool } = setup(ON)
  pastRuns(root)
  const text = tool('omnis_swarm_init', { name: 'next', topology: 'hierarchical' }).text
  assert.match(text, /^Swarm "next" started as next \(hierarchical\)\.\n\nModel hints from past runs:\n- omnis-developer: Sonnet/)
})

test('omnis_swarm_init is unchanged without evidence, with hints off, or with no hints option', () => {
  for (const hints of [ON, { mode: 'off' as const, machineDir: null }, undefined]) {
    const { root, tool } = setup(hints)
    if (hints !== ON) pastRuns(root)
    assert.equal(tool('omnis_swarm_init', { name: 'next', topology: 'hierarchical' }).text, 'Swarm "next" started as next (hierarchical).')
  }
})

test('a written report records the run and carries a Hints section', () => {
  const { root, tool } = setup(ON)
  pastRuns(root)
  tool('omnis_swarm_init', { name: 'cur', topology: 'hierarchical' })
  appendEvent(root, ev('agent.started', { name: 'w', role: 'omnis-writer', description: '', parent: 'lead' }, { swarm: 'cur', agent: 'w', atSec: 1 }))
  appendEvent(root, ev('agent.usage', { model: 'claude-haiku-5-5', input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, { swarm: 'cur', agent: 'w', atSec: 2 }))
  appendEvent(root, ev('agent.finished', { outcome: 'answer' }, { swarm: 'cur', agent: 'w', atSec: 3 }))
  const pointer = tool('omnis_swarm_end', {}).text
  const path = pointer.match(/(\.omnis-swarm\/reports\/[^ ]+\.md)/)![1]!
  assert.match(readFileSync(join(root, path), 'utf8'), /\n## Hints\n\n- omnis-developer: Sonnet/)
  assert.match(readFileSync(join(root, '.omnis-swarm', 'history.jsonl'), 'utf8'), /"id":"cur\/w"/)
})

test('omnis_hints answers the table, or says hints are off', () => {
  const on = setup(ON)
  pastRuns(on.root)
  assert.match(on.tool('omnis_hints').text, /^Model history \(/)
  assert.equal(setup({ mode: 'off', machineDir: null }).tool('omnis_hints').text, 'Model hints are off (the modelHints setting).')
})
```

In `tests/core/report.test.ts` add:

```ts
test('reportMarkdown adds a Hints section only when it is given lines, escaped like the rest', () => {
  const s = foldAll('s1', [ev('swarm.started', { name: 's1', topology: 'hierarchical', implicit: false }, { src: 'mcp' })])
  assert.equal(reportMarkdown(s, at(60), 0).includes('## Hints'), false)
  assert.match(reportMarkdown(s, at(60), 0, ["dev_x: Sonnet finished clean 5 of 5 (≈$0.10 avg) vs Opus 5 of 5 (≈$1.00). Try model: 'sonnet'."]),
    /\n## Hints\n\n- dev\\_x: Sonnet finished clean 5 of 5 /)
})
```

(use that file's existing imports for `foldAll`, `ev`, `at`; add any that are missing.)

- [ ] **Step 6: Run to see them fail**

Run: `node --test tests/mcp/hints-tool.test.ts tests/core/report.test.ts`
Expected: FAIL (no `tools/hints.ts`; init reply has no block; report has no Hints section).

- [ ] **Step 7: Wire it.**

`src/core/report.ts`: give `reportMarkdown` a fourth parameter `hints: readonly string[] = []`, and add `['Hints', hints.map(l => \`- ${md(l)}\`)]` as the last entry of the sections list (after Gates).

`src/mcp/tools/report.ts` `writeReport`: add a fifth parameter `hints: HintsOptions = HINTS_OFF`. Before building the markdown:

```ts
  recordRun(root, session, swarm, hints)
  const { project, machine } = loadRows(root, hints)
  const md = reportMarkdown(state, now.getTime(), -now.getTimezoneOffset(), hintLines(project, machine))
```

and in `createReportTools` pass `ctx.hints ?? HINTS_OFF` to `writeReport`.

`src/mcp/tools.ts`:
- `ToolContext` gains `hints?: HintsOptions` (import the type from `./history-store.ts`).
- In `createTools`, read `const hints = ctx.hints ?? HINTS_OFF` beside `clock`.
- `omnis_swarm_end`: pass `hints` as the fifth argument to `writeReport`.
- `omnis_swarm_init`: append `hintBlock(root, hints)` to the text of the two success returns (`now names the running session swarm` and `started as`). Not to errors.

`src/mcp/tools/hints.ts`:

```ts
/** omnis_hints (spec 2026-10-25 section 6): the model history table for /omnis hints. Internal: the mod's guard refuses the model. */
import { hintsText } from '../../core/hints.ts'
import { HINTS_TOOL } from '../../core/recording.ts'
import { HINTS_OFF, loadRows } from '../history-store.ts'
import type { ToolDef } from '../protocol.ts'
import type { ToolContext } from '../tools.ts'

export function createHintsTools(ctx: ToolContext): ToolDef[] {
  const opts = ctx.hints ?? HINTS_OFF
  return [{
    name: HINTS_TOOL,
    description: 'Internal to the OmnisSwarm plugin: the model history table for /omnis hints. When the OmnisSwarm mod is loaded it refuses calls from the model.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => {
      if (opts.mode === 'off') return { text: 'Model hints are off (the modelHints setting).' }
      const { project, machine } = loadRows(ctx.root, opts)
      return { text: hintsText(project, machine) }
    },
  }]
}
```

`src/mcp/registry.ts`: import `createHintsTools` and append it to `toolFactories`.

If a test elsewhere lists every tool name the server exposes (`grep -rn "omnis_handoff" tests`), add `omnis_hints` there.

- [ ] **Step 8: Run everything**

Run: `npm run check`
Expected: PASS, with the previous counts plus the new tests.

- [ ] **Step 9: Commit**

```bash
git add src/mcp/history-store.ts src/mcp/tools/hints.ts src/mcp/tools.ts src/mcp/tools/report.ts src/core/report.ts src/mcp/registry.ts tests/mcp/history-store.test.ts tests/mcp/hints-tool.test.ts tests/core/report.test.ts <any updated tool-list test>
git commit -m "Keep model history and show hints at swarm start and in reports"
```

---

### Lead: manifest, server, version, docs

- `.claude-plugin/plugin.json` `userConfig`: add

```json
"modelHints": {
  "type": "string",
  "title": "Model hints",
  "description": "on (the default): swarm starts show which models past runs did well on, from this project and across projects. project: this project's runs only, nothing kept outside it. off: no history kept, no hints.",
  "default": "on",
  "options": ["on", "project", "off"]
}
```

  and to `mcpServers.omnis-swarm.env`: `"OMNIS_MODEL_HINTS": "${user_config.modelHints}"`, `"OMNIS_DATA_DIR": "${CLAUDE_PLUGIN_DATA}"`.
- `src/mcp/server.ts`: `import { hintsOptions } from './history-store.ts'`; pass `hints: hintsOptions(process.env)` in the factory context; version string `0.6.0`.
- Version `0.6.0` in `package.json` and `plugin.json`; README: a short "Model hints" section and the setting; release notes in the existing style.
- `npm run check`, then `claude plugin validate .` if the repo's release steps use it; merge to master and push.
