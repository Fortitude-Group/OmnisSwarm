# OmnisSwarm Phase 1 (Core + MCP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build OmnisSwarm's core library (event log, fold, stats, prices) and its MCP server (`omnis_*` tools), packaged as a Claude Code plugin. Alongside it, run a spike that settles the mod API questions phases 2 and 3 depend on.

**Architecture:** Everything shares one append-only JSONL event log per swarm in `.omnis-swarm/`. `src/core` is pure TypeScript with no dependencies: event types, append/follow, a deterministic `fold` into `SwarmState`, per-agent stats and a price table. `src/mcp` is a hand-rolled MCP stdio server (newline-delimited JSON-RPC) whose tools append events and read folded state. There are no runtime npm dependencies, and Node 24 runs the `.ts` files directly.

**Tech Stack:** Node 24 (built-in type stripping, `node:test`), TypeScript 7 for type-checking only, Claude Code plugin manifest.

**Spec:** `docs/superpowers/specs/2026-10-21-omnisswarm-design.md`

## Global Constraints

- Node `>=24`. TypeScript runs through Node's type stripping, with no build step.
- No runtime npm dependencies. Dev dependencies only: `typescript ^7.0.2`, `@types/node ^24`.
- Erasable TypeScript only: no `enum`, `namespace` or constructor parameter properties. Relative imports end in `.ts`. Type-only imports use `import type` or inline `type`.
- No file over 500 lines.
- Every MCP tool name starts `omnis_`.
- Log folder `.omnis-swarm/`. Envelope `v` = 1. Max line 2048 bytes. Clip limits: summary 200, subject 80, description 120, preview 80, reason 80 (characters).
- Never store full prompts, tool output or file contents in the log.
- Memory values ≤ 4096 bytes. Memory keys match `^[A-Za-z0-9._/-]{1,128}$` and are never `__proto__`, `constructor` or `prototype`.
- Gate before every commit: `npm run check` (typecheck + all tests) is green.
- Commit as `Fortitude Omnis <dev@fortitude-omnis.group>`, in plain developer English. No `Co-Authored-By` or any AI attribution.
- Windows is the dev platform. Every command below works in Git Bash and PowerShell.

## File Structure

```
package.json                      scripts + dev deps (Task 1)
tsconfig.json                     type-check config (Task 1)
.gitignore                        + node_modules/, .omnis-swarm/ (Task 1)
.claude-plugin/plugin.json        plugin manifest with the MCP server (Task 11)
.claude-plugin/marketplace.json   single-plugin marketplace (Task 11)
src/core/events.ts                event types, limits, makeEvent/serialise/parseLine (Task 1)
src/core/log.ts                   paths, append, readEvents, current swarm, sortEvents (Task 2)
src/core/prices.ts                price table, priceFor, costOf (Task 3)
src/core/fold.ts                  SwarmState, emptyState, fold, foldAll (Task 3)
src/core/stats.ts                 agentStats, swarmTotals, fileClashes (Task 7)
src/core/snapshot.ts              Loaded, advance, loadState, snapshots (Task 8)
src/core/swarm.ts                 slugify, uniqueSwarmId, ensureSwarm (Task 8)
src/mcp/protocol.ts               JSON-RPC handling + stdio loop (Task 4)
src/mcp/validate.ts               input validation helpers (Task 10)
src/mcp/memory-store.ts           memory values file (Task 9)
src/mcp/tools.ts                  the eight omnis_* tools (Task 10)
src/mcp/server.ts                 entry point (Task 11)
tests/helpers.ts                  tmpRoot, ev, at (Task 1)
tests/core/*.test.ts, tests/mcp/*.test.ts, tests/e2e/*.test.ts
docs/event-log.md                 event log reference for hub/WebGL builders (Task 6)
docs/spikes/2026-10-21-mod-api.md mod API findings (Task 5)
```

## Execution Waves (fan-out)

Parallel tasks run as separate agents, each in its own git worktree, and only touch the files their task lists. The integration owner merges each wave into `master` before starting the next.

| Wave | Tasks | Runs | Depends on |
|---|---|---|---|
| 0 | 1 | serial | none |
| 1 | 2, 3, 4, 5, 6 | **parallel** (5 agents) | 1 |
| 2 | 7, 8, 9 | **parallel** (3 agents) | 7: 3 · 8: 2+3 · 9: 2 |
| 3 | 10 | serial | 4, 7, 8, 9 |
| 4 | 11 | serial | 10 |

Task 5 (spike) changes no source files, so it can run as long as it needs without blocking anything.

---

### Task 1: Scaffold the repo and define the event contract

**Files:**
- Create: `package.json`, `tsconfig.json`, `src/core/events.ts`, `tests/helpers.ts`, `tests/core/events.test.ts`
- Modify: `.gitignore` (append two lines)

**Interfaces:**
- Consumes: nothing
- Produces (every later task relies on these exact names):
  - `SCHEMA_VERSION: 1`, `SOURCES`, `type Source = 'recorder' | 'transcripts' | 'mcp'`
  - `TOPOLOGIES`, `type Topology = 'hierarchical' | 'mesh' | 'star'`
  - `TASK_STATES`, `type TaskState = 'pending' | 'active' | 'done' | 'failed'`
  - `TOOL_KINDS`, `type ToolKind = 'read' | 'edit' | 'bash' | 'search' | 'web' | 'agent' | 'other'`
  - `AGENT_OUTCOMES`, `type AgentOutcome = 'answer' | 'aborted' | 'failed'`
  - `type EventData`, `type EventType`, `EVENT_TYPES`, `type SwarmEvent<K extends EventType = EventType>`
  - `LIMITS = { line: 2048, summary: 200, subject: 80, description: 120, preview: 80, reason: 80 }`
  - `clip(text: string, max: number): string`
  - `isSafeKey(key: string): boolean`, `isOneOf<T extends string>(values: readonly T[], x: unknown): x is T`
  - `makeEvent<K>(input: { type: K; swarm: string; src: Source; data: EventData[K]; agent?: string; now?: Date }): SwarmEvent<K>`
  - `serialise(event: SwarmEvent): string` (throws `RangeError` over `LIMITS.line` bytes)
  - `parseLine(line: string): ParseResult`, where `ParseResult = { ok: true; event: SwarmEvent } | { ok: false; reason: 'json' | 'shape' | 'version' }`
  - Test helpers: `tmpRoot(): string`, `ev(type, data, opts?)`, `at(sec): number`

- [ ] **Step 1: Initialise the repo**

The repo already has git and the spec commit. Set the identity and install dev deps:

```bash
git config user.name "Fortitude Omnis"
git config user.email "dev@fortitude-omnis.group"
```

Create `package.json`:

```json
{
  "name": "omnis-swarm",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "test": "node --test \"tests/**/*.test.ts\"",
    "typecheck": "tsc -p tsconfig.json",
    "check": "npm run typecheck && npm test"
  },
  "devDependencies": {
    "@types/node": "^24",
    "typescript": "^7.0.2"
  }
}
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "es2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "noUncheckedIndexedAccess": true,
    "types": ["node"],
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

Append to `.gitignore`:

```
node_modules/
.omnis-swarm/
```

Run: `npm install`
Expected: installs 2 packages with no errors. If TypeScript 7 rejects a `compilerOptions` key, change only that key to the TS 7 equivalent its error message names, and say so in the commit message.

- [ ] **Step 2: Write the failing test**

Create `tests/helpers.ts`:

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeEvent, type EventData, type EventType, type Source, type SwarmEvent } from '../src/core/events.ts'

const BASE = Date.parse('2026-10-21T10:00:00.000Z')

/** A fresh empty project folder in the OS temp dir. */
export const tmpRoot = (): string => mkdtempSync(join(tmpdir(), 'omnis-'))

/** Milliseconds for `sec` seconds after the fixed test epoch. */
export const at = (sec: number): number => BASE + sec * 1000

/** A valid event at `atSec` seconds after the test epoch. */
export function ev<K extends EventType>(
  type: K,
  data: EventData[K],
  opts: { agent?: string; atSec?: number; swarm?: string; src?: Source } = {},
): SwarmEvent<K> {
  return makeEvent({
    type,
    data,
    swarm: opts.swarm ?? 's1',
    src: opts.src ?? 'recorder',
    ...(opts.agent !== undefined && { agent: opts.agent }),
    now: new Date(at(opts.atSec ?? 0)),
  })
}
```

Create `tests/core/events.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clip, isOneOf, isSafeKey, LIMITS, makeEvent, parseLine, SCHEMA_VERSION, serialise, TOPOLOGIES } from '../../src/core/events.ts'

const now = new Date('2026-10-21T10:00:00.000Z')
const message = () => makeEvent({ type: 'message.sent', swarm: 's1', src: 'recorder', agent: 'a1', data: { to: 'tester', summary: 'hi' }, now })

test('clip flattens whitespace and cuts long text with an ellipsis', () => {
  assert.equal(clip('  a\n  b  ', 10), 'a b')
  assert.equal(clip('abcdefghij', 5), 'abcd…')
  assert.equal(clip('abcde', 5), 'abcde')
})

test('makeEvent fills the envelope', () => {
  assert.deepEqual(message(), {
    v: SCHEMA_VERSION, ts: '2026-10-21T10:00:00.000Z', swarm: 's1', src: 'recorder',
    type: 'message.sent', agent: 'a1', data: { to: 'tester', summary: 'hi' },
  })
})

test('makeEvent leaves agent out when none is given', () => {
  const e = makeEvent({ type: 'swarm.ended', swarm: 's1', src: 'mcp', data: {}, now })
  assert.equal('agent' in e, false)
})

test('serialise ends in a newline and round-trips through parseLine', () => {
  const line = serialise(message())
  assert.ok(line.endsWith('\n'))
  const parsed = parseLine(line.trim())
  assert.ok(parsed.ok)
  if (parsed.ok) assert.deepEqual(parsed.event, message())
})

test('serialise refuses a line over the byte limit', () => {
  const big = makeEvent({ type: 'message.sent', swarm: 's1', src: 'recorder', data: { to: 'b', summary: 'x'.repeat(LIMITS.line) }, now })
  assert.throws(() => serialise(big), RangeError)
})

test('parseLine rejects bad JSON, bad shapes and newer versions', () => {
  const good = JSON.parse(serialise(message())) as Record<string, unknown>
  assert.deepEqual(parseLine('{nope'), { ok: false, reason: 'json' })
  assert.deepEqual(parseLine('[]'), { ok: false, reason: 'shape' })
  assert.deepEqual(parseLine(JSON.stringify({ ...good, v: SCHEMA_VERSION + 1 })), { ok: false, reason: 'version' })
  assert.deepEqual(parseLine(JSON.stringify({ ...good, type: 'nope' })), { ok: false, reason: 'shape' })
  assert.deepEqual(parseLine(JSON.stringify({ ...good, src: 'nope' })), { ok: false, reason: 'shape' })
  assert.deepEqual(parseLine(JSON.stringify({ ...good, ts: 'not a date' })), { ok: false, reason: 'shape' })
  assert.deepEqual(parseLine(JSON.stringify({ ...good, data: null })), { ok: false, reason: 'shape' })
  assert.deepEqual(parseLine(JSON.stringify({ ...good, agent: 7 })), { ok: false, reason: 'shape' })
})

test('isSafeKey blocks prototype keys and the empty string', () => {
  assert.equal(isSafeKey('design/auth'), true)
  for (const k of ['__proto__', 'constructor', 'prototype', '']) assert.equal(isSafeKey(k), false)
})

test('isOneOf narrows to a known value', () => {
  assert.equal(isOneOf(TOPOLOGIES, 'mesh'), true)
  assert.equal(isOneOf(TOPOLOGIES, 'ring'), false)
  assert.equal(isOneOf(TOPOLOGIES, 3), false)
})
```

- [ ] **Step 3: Run the test to see it fail**

Run: `npm test`
Expected: FAIL. `Cannot find module '.../src/core/events.ts'`.

- [ ] **Step 4: Write the implementation**

Create `src/core/events.ts`:

```ts
/** The event contract every OmnisSwarm writer and reader shares. Pure: no I/O. */

export const SCHEMA_VERSION = 1

export const SOURCES = ['mcp', 'recorder', 'transcripts'] as const
export type Source = (typeof SOURCES)[number]

export const TOPOLOGIES = ['hierarchical', 'mesh', 'star'] as const
export type Topology = (typeof TOPOLOGIES)[number]

export const TASK_STATES = ['pending', 'active', 'done', 'failed'] as const
export type TaskState = (typeof TASK_STATES)[number]

export const TOOL_KINDS = ['read', 'edit', 'bash', 'search', 'web', 'agent', 'other'] as const
export type ToolKind = (typeof TOOL_KINDS)[number]

export const AGENT_OUTCOMES = ['answer', 'aborted', 'failed'] as const
export type AgentOutcome = (typeof AGENT_OUTCOMES)[number]

export type EventData = {
  'swarm.started': { name: string; topology: Topology; goal?: string; implicit: boolean }
  'swarm.ended': { outcome?: string }
  'agent.started': { name: string; role: string; description: string; parent: string }
  'agent.finished': { outcome: AgentOutcome; reason?: string }
  'agent.usage': { model: string; input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number }
  'agent.tool': { phase: 'start' | 'end'; tool: string; kind: ToolKind; subject: string; isError: boolean }
  'message.sent': { to: string; summary: string }
  'memory.put': { key: string; bytes: number; preview: string }
  'task.created': { id: string; title: string; assignee?: string; dependsOn?: string[] }
  'task.updated': { id: string; state: TaskState; assignee?: string; note?: string }
}
export type EventType = keyof EventData

export const EVENT_TYPES = [
  'swarm.started', 'swarm.ended', 'agent.started', 'agent.finished', 'agent.usage',
  'agent.tool', 'message.sent', 'memory.put', 'task.created', 'task.updated',
] as const satisfies readonly EventType[]

export type SwarmEvent<K extends EventType = EventType> = {
  [T in K]: { v: number; ts: string; swarm: string; src: Source; type: T; agent?: string; data: EventData[T] }
}[K]

export const LIMITS = { line: 2048, summary: 200, subject: 80, description: 120, preview: 80, reason: 80 } as const

/** Collapses whitespace and cuts to `max` characters, ending in an ellipsis when cut. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** True for a string that is safe to use as a plain-object key. */
export const isSafeKey = (key: string): boolean => key !== '' && !UNSAFE_KEYS.has(key)

export const isOneOf = <T extends string>(values: readonly T[], x: unknown): x is T =>
  typeof x === 'string' && (values as readonly string[]).includes(x)

export function makeEvent<K extends EventType>(input: {
  type: K
  swarm: string
  src: Source
  data: EventData[K]
  agent?: string
  now?: Date
}): SwarmEvent<K> {
  const event = {
    v: SCHEMA_VERSION,
    ts: (input.now ?? new Date()).toISOString(),
    swarm: input.swarm,
    src: input.src,
    type: input.type,
    ...(input.agent !== undefined && { agent: input.agent }),
    data: input.data,
  }
  return event as SwarmEvent<K>
}

/** One log line, newline included. Throws RangeError past LIMITS.line bytes. */
export function serialise(event: SwarmEvent): string {
  const line = `${JSON.stringify(event)}\n`
  const bytes = Buffer.byteLength(line)
  if (bytes > LIMITS.line) throw new RangeError(`event line is ${bytes} bytes, the limit is ${LIMITS.line}`)
  return line
}

export type ParseResult = { ok: true; event: SwarmEvent } | { ok: false; reason: 'json' | 'shape' | 'version' }

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)

/** Checks the envelope only. `data` fields are checked defensively by `fold`. */
export function parseLine(line: string): ParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return { ok: false, reason: 'json' }
  }
  if (!isObj(raw) || typeof raw.v !== 'number') return { ok: false, reason: 'shape' }
  if (raw.v > SCHEMA_VERSION) return { ok: false, reason: 'version' }
  const shapeOk =
    typeof raw.ts === 'string' && !Number.isNaN(Date.parse(raw.ts)) &&
    typeof raw.swarm === 'string' &&
    isOneOf(SOURCES, raw.src) &&
    isOneOf(EVENT_TYPES, raw.type) &&
    isObj(raw.data) &&
    (raw.agent === undefined || typeof raw.agent === 'string')
  return shapeOk ? { ok: true, event: raw as SwarmEvent } : { ok: false, reason: 'shape' }
}
```

- [ ] **Step 5: Run the gate**

Run: `npm run check`
Expected: typecheck prints no errors. `ℹ pass 8`, `ℹ fail 0`.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore src/core/events.ts tests/helpers.ts tests/core/events.test.ts
git commit -m "Scaffold the project and define the swarm event contract"
```

---

### Task 2: Event log reading and writing  *(wave 1, parallel)*

**Files:**
- Create: `src/core/log.ts`, `tests/core/log.test.ts`

**Interfaces:**
- Consumes: `serialise`, `parseLine`, `type SwarmEvent`, `type Source` from `src/core/events.ts`
- Produces:
  - `LOG_DIR = '.omnis-swarm'`
  - `isValidSwarmId(id: string): boolean`
  - `logPaths(root: string): { dir: string; current: string; swarms: string; memory: string }`
  - `swarmLogPath(root: string, id: string): string` (throws on an invalid id)
  - `ensureLogDirs(root: string): void`, `ensureGitignore(root: string): void`
  - `appendEvent(root: string, event: SwarmEvent): boolean` (never throws)
  - `type ReadResult = { events: SwarmEvent[]; offset: number; bad: number; skipped: number; reset: boolean }`
  - `readEvents(file: string, offset?: number): ReadResult`
  - `readCurrent(root: string): string | null`, `writeCurrent(root: string, id: string): void`, `clearCurrent(root: string): void`
  - `sortEvents(events: readonly SwarmEvent[]): SwarmEvent[]`

- [ ] **Step 1: Write the failing test**

Create `tests/core/log.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { serialise, SCHEMA_VERSION } from '../../src/core/events.ts'
import {
  appendEvent, clearCurrent, ensureGitignore, isValidSwarmId, readCurrent, readEvents,
  sortEvents, swarmLogPath, writeCurrent,
} from '../../src/core/log.ts'
import { ev, tmpRoot } from '../helpers.ts'

const msg = (n: number, atSec = n) => ev('message.sent', { to: 'b', summary: `m${n}` }, { agent: 'a', atSec })

test('appendEvent writes one line per event and readEvents reads them back', () => {
  const root = tmpRoot()
  assert.equal(appendEvent(root, msg(1)), true)
  assert.equal(appendEvent(root, msg(2)), true)
  const file = swarmLogPath(root, 's1')
  const read = readEvents(file)
  assert.deepEqual(read.events, [msg(1), msg(2)])
  assert.equal(read.offset, readFileSync(file).length)
  assert.equal(read.bad, 0)
  assert.equal(read.reset, false)
})

test('readEvents resumes from an offset', () => {
  const root = tmpRoot()
  appendEvent(root, msg(1))
  const first = readEvents(swarmLogPath(root, 's1'))
  appendEvent(root, msg(2))
  const next = readEvents(swarmLogPath(root, 's1'), first.offset)
  assert.deepEqual(next.events, [msg(2)])
})

test('readEvents holds back a half-written last line until it is complete', () => {
  const root = tmpRoot()
  appendEvent(root, msg(1))
  const file = swarmLogPath(root, 's1')
  const line = serialise(msg(2))
  appendFileSync(file, line.slice(0, 10))
  const first = readEvents(file)
  assert.equal(first.events.length, 1)
  appendFileSync(file, line.slice(10))
  const second = readEvents(file, first.offset)
  assert.deepEqual(second.events, [msg(2)])
})

test('readEvents counts corrupt lines and skips newer versions', () => {
  const root = tmpRoot()
  appendEvent(root, msg(1))
  const file = swarmLogPath(root, 's1')
  appendFileSync(file, '{broken\n')
  appendFileSync(file, `${JSON.stringify({ ...msg(2), v: SCHEMA_VERSION + 1 })}\n`)
  appendEvent(root, msg(3))
  const read = readEvents(file)
  assert.deepEqual(read.events, [msg(1), msg(3)])
  assert.equal(read.bad, 1)
  assert.equal(read.skipped, 1)
})

test('readEvents starts over when the file shrinks', () => {
  const root = tmpRoot()
  appendEvent(root, msg(1))
  appendEvent(root, msg(2))
  const file = swarmLogPath(root, 's1')
  const before = readEvents(file)
  writeFileSync(file, serialise(msg(9)))
  const after = readEvents(file, before.offset)
  assert.equal(after.reset, true)
  assert.deepEqual(after.events, [msg(9)])
})

test('readEvents on a missing file returns nothing', () => {
  const read = readEvents(join(tmpRoot(), 'nope.jsonl'), 5)
  assert.deepEqual(read, { events: [], offset: 5, bad: 0, skipped: 0, reset: false })
})

test('swarm ids are checked so paths cannot escape the log folder', () => {
  for (const bad of ['', '..', '../x', 'a/b', 'a\\b', '.hidden', 'x'.repeat(65)]) assert.equal(isValidSwarmId(bad), false, bad)
  for (const good of ['auth-refactor', 'session-20261021-100000', 'v1.2_x']) assert.equal(isValidSwarmId(good), true, good)
  assert.throws(() => swarmLogPath(tmpRoot(), '../x'))
})

test('the current swarm round-trips and clears', () => {
  const root = tmpRoot()
  assert.equal(readCurrent(root), null)
  writeCurrent(root, 'auth')
  assert.equal(readCurrent(root), 'auth')
  clearCurrent(root)
  assert.equal(readCurrent(root), null)
  assert.throws(() => writeCurrent(root, '../x'))
})

test('the log folder is added to .gitignore once', () => {
  const root = tmpRoot()
  writeFileSync(join(root, '.gitignore'), 'node_modules/')
  ensureGitignore(root)
  ensureGitignore(root)
  assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), 'node_modules/\n.omnis-swarm/\n')
})

test('sortEvents orders by time, then source, then file order', () => {
  const late = msg(1, 5)
  const mcp = ev('memory.put', { key: 'k', bytes: 1, preview: 'v' }, { atSec: 2, src: 'mcp' })
  const recorder = msg(2, 2)
  const recorder2 = msg(3, 2)
  assert.deepEqual(sortEvents([late, recorder, mcp, recorder2]), [mcp, recorder, recorder2, late])
})
```

- [ ] **Step 2: Run the test to see it fail**

Run: `node --test tests/core/log.test.ts`
Expected: FAIL. `Cannot find module '.../src/core/log.ts'`.

- [ ] **Step 3: Write the implementation**

Create `src/core/log.ts`:

```ts
/** Reading and writing the per-swarm event log under `.omnis-swarm/`. */
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseLine, serialise, type Source, type SwarmEvent } from './events.ts'

export const LOG_DIR = '.omnis-swarm'

const SWARM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Swarm ids become file names, so only safe characters and never `..`. */
export const isValidSwarmId = (id: string): boolean => SWARM_ID.test(id) && !id.includes('..')

export function logPaths(root: string): { dir: string; current: string; swarms: string; memory: string } {
  const dir = join(root, LOG_DIR)
  return { dir, current: join(dir, 'current'), swarms: join(dir, 'swarms'), memory: join(dir, 'memory') }
}

export function swarmLogPath(root: string, id: string): string {
  if (!isValidSwarmId(id)) throw new Error(`invalid swarm id: ${JSON.stringify(id)}`)
  return join(logPaths(root).swarms, `${id}.jsonl`)
}

/** Adds `.omnis-swarm/` to the project's .gitignore unless it is already there. */
export function ensureGitignore(root: string): void {
  const file = join(root, '.gitignore')
  const entry = `${LOG_DIR}/`
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (text.split(/\r?\n/).some(line => line.trim() === entry || line.trim() === LOG_DIR)) return
  const sep = text === '' || text.endsWith('\n') ? '' : '\n'
  writeFileSync(file, `${text}${sep}${entry}\n`)
}

const ready = new Set<string>()

export function ensureLogDirs(root: string): void {
  if (ready.has(root) && existsSync(logPaths(root).swarms)) return
  const paths = logPaths(root)
  mkdirSync(paths.swarms, { recursive: true })
  mkdirSync(paths.memory, { recursive: true })
  ensureGitignore(root)
  ready.add(root)
}

/** One append of one line. Retries once, and returns false rather than throwing. */
export function appendEvent(root: string, event: SwarmEvent): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const line = serialise(event)
      ensureLogDirs(root)
      appendFileSync(swarmLogPath(root, event.swarm), line)
      return true
    } catch {
      // A locked file or full disk: try once more, then let the caller show a gap.
    }
  }
  return false
}

export type ReadResult = { events: SwarmEvent[]; offset: number; bad: number; skipped: number; reset: boolean }

/**
 * Reads complete lines from `offset` on. A trailing line with no newline yet is left for next time.
 * If the file is now shorter than `offset`, it was replaced, so reading starts again from 0 and `reset` is true.
 */
export function readEvents(file: string, offset = 0): ReadResult {
  let fd: number
  try {
    fd = openSync(file, 'r')
  } catch {
    return { events: [], offset, bad: 0, skipped: 0, reset: false }
  }
  try {
    const size = fstatSync(fd).size
    const reset = size < offset
    const start = reset ? 0 : offset
    const result: ReadResult = { events: [], offset: start, bad: 0, skipped: 0, reset }
    if (size === start) return result
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    const end = buf.lastIndexOf(0x0a)
    if (end === -1) return result
    for (const line of buf.subarray(0, end + 1).toString('utf8').split('\n')) {
      if (line.trim() === '') continue
      const parsed = parseLine(line)
      if (parsed.ok) result.events.push(parsed.event)
      else if (parsed.reason === 'version') result.skipped++
      else result.bad++
    }
    result.offset = start + end + 1
    return result
  } finally {
    closeSync(fd)
  }
}

export function readCurrent(root: string): string | null {
  try {
    const id = readFileSync(logPaths(root).current, 'utf8').trim()
    return isValidSwarmId(id) ? id : null
  } catch {
    return null
  }
}

export function writeCurrent(root: string, id: string): void {
  if (!isValidSwarmId(id)) throw new Error(`invalid swarm id: ${JSON.stringify(id)}`)
  ensureLogDirs(root)
  writeFileSync(logPaths(root).current, `${id}\n`)
}

export function clearCurrent(root: string): void {
  rmSync(logPaths(root).current, { force: true })
}

const SOURCE_ORDER: Record<Source, number> = { mcp: 0, recorder: 1, transcripts: 2 }

/** Orders by timestamp, then source, keeping file order for exact ties. Writers never coordinate. */
export function sortEvents(events: readonly SwarmEvent[]): SwarmEvent[] {
  return events
    .map((event, index) => ({ event, index, time: Date.parse(event.ts) }))
    .sort((a, b) => a.time - b.time || SOURCE_ORDER[a.event.src] - SOURCE_ORDER[b.event.src] || a.index - b.index)
    .map(item => item.event)
}
```

- [ ] **Step 4: Run the gate**

Run: `npm run check`
Expected: no type errors. All tests pass (8 from Task 1 + 10 here).

- [ ] **Step 5: Commit**

```bash
git add src/core/log.ts tests/core/log.test.ts
git commit -m "Add the event log: append, follow from an offset, current swarm"
```

---

### Task 3: Price table and fold  *(wave 1, parallel)*

**Files:**
- Create: `src/core/prices.ts`, `src/core/fold.ts`, `tests/core/prices.test.ts`, `tests/core/fold.test.ts`

**Interfaces:**
- Consumes: from `src/core/events.ts`: `AGENT_OUTCOMES, TASK_STATES, TOOL_KINDS, TOPOLOGIES, isOneOf, isSafeKey`, types `AgentOutcome, SwarmEvent, TaskState, ToolKind, Topology`
- Produces:
  - `type Usage = { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number }`
  - `type Price = { input; output; cacheRead; cacheWrite5m; cacheWrite1h; contextWindow; longContext?: { above: number; input: number; output: number } }` (USD per million tokens)
  - `PRICES: Readonly<Record<string, Price>>`, `priceFor(model: string): Price | null`, `costOf(model: string, usage: Usage): number | null`
  - `LEAD = 'lead'`
  - `type UsageSample = { at: number; output: number; gapMs: number }`
  - `type AgentState` (fields listed in the code below), `type LinkState`, `type MemoryEntry`, `type TaskEntry`, `type FeedItem`, `type SwarmInfo`, `type SwarmState`
  - `emptyState(id: string): SwarmState`
  - `fold(state: SwarmState, event: SwarmEvent): SwarmState` (mutates and returns `state`; deterministic, no I/O)
  - `foldAll(id: string, events: readonly SwarmEvent[]): SwarmState`

- [ ] **Step 1: Write the failing tests**

Create `tests/core/prices.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { costOf, priceFor } from '../../src/core/prices.ts'

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }
const near = (a: number | null, b: number) => assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`)

test('priceFor matches exact ids, dated ids and nothing else', () => {
  assert.equal(priceFor('claude-opus-5-5')?.input, 4)
  assert.equal(priceFor('claude-haiku-4-5-20251001')?.contextWindow, 200_000)
  assert.equal(priceFor('claude-opus-5-5-20270101')?.input, 4)
  assert.equal(priceFor('claude-opus-5')?.input, 5)
  assert.equal(priceFor('gpt-something'), null)
})

test('costOf prices each token class', () => {
  near(costOf('claude-opus-5-5', { ...zero, input: 1_000_000 }), 4)
  near(costOf('claude-opus-5-5', { ...zero, output: 1_000_000 }), 20)
  near(costOf('claude-opus-5-5', { ...zero, cacheRead: 1_000_000 }), 0.2)
  near(costOf('claude-opus-5-5', { ...zero, cacheWrite5m: 1_000_000 }), 5)
  near(costOf('claude-opus-5-5', { ...zero, cacheWrite1h: 1_000_000 }), 8)
  near(costOf('claude-fable-5-1', { ...zero, cacheRead: 1_000_000 }), 0.25)
})

test('costOf switches Haiku 5.5 to its long-context rate above 100K prompt tokens', () => {
  near(costOf('claude-haiku-5-5', { ...zero, input: 50_000 }), 0.005)
  near(costOf('claude-haiku-5-5', { ...zero, input: 200_000 }), 0.1)
})

test('costOf returns null for an unknown model', () => {
  assert.equal(costOf('mystery-model', { ...zero, input: 10 }), null)
})
```

Create `tests/core/fold.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emptyState, fold, foldAll, LEAD } from '../../src/core/fold.ts'
import type { SwarmEvent } from '../../src/core/events.ts'
import { at, ev } from '../helpers.ts'

const run = (events: SwarmEvent[]) => foldAll('s1', events)
const coder = ev('agent.started', { name: 'coder', role: 'coder', description: 'writes code', parent: LEAD }, { agent: 'a1', atSec: 1 })

test('an agent starts and finishes', () => {
  const s = run([coder, ev('agent.finished', { outcome: 'answer' }, { agent: 'a1', atSec: 9 })])
  const a = s.agents.a1!
  assert.equal(a.name, 'coder')
  assert.equal(a.role, 'coder')
  assert.equal(a.parent, LEAD)
  assert.equal(a.startedAt, at(1))
  assert.equal(a.finishedAt, at(9))
  assert.equal(a.outcome, 'answer')
  assert.equal(s.byName.coder, 'a1')
  assert.deepEqual(s.feed.map(f => f.text), ['coder started', 'coder finished'])
})

test('usage adds up tokens, sets the model and prices the call', () => {
  const s = run([
    coder,
    ev('agent.usage', { model: 'claude-sonnet-5-5', input: 1000, output: 500, cacheRead: 9000, cacheWrite5m: 0, cacheWrite1h: 0 }, { agent: 'a1', atSec: 11 }),
    ev('agent.usage', { model: 'claude-sonnet-5-5', input: 0, output: 1000, cacheRead: 10000, cacheWrite5m: 0, cacheWrite1h: 0 }, { agent: 'a1', atSec: 21 }),
  ])
  const a = s.agents.a1!
  assert.deepEqual(a.tokens, { input: 1000, output: 1500, cacheRead: 19000, cacheWrite5m: 0, cacheWrite1h: 0 })
  assert.equal(a.model, 'claude-sonnet-5-5')
  assert.ok(Math.abs(a.costUsd - 0.0208) < 1e-9)
  assert.equal(a.costKnown, true)
  assert.equal(a.calls, 2)
  assert.equal(a.lastPrompt, 10000)
  assert.deepEqual(a.samples, [{ at: at(11), output: 500, gapMs: 10_000 }, { at: at(21), output: 1000, gapMs: 10_000 }])
  assert.equal(s.spend.length, 2)
})

test('an unknown model marks the cost as unknown', () => {
  const s = run([coder, ev('agent.usage', { model: 'mystery', input: 5, output: 5, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, { agent: 'a1', atSec: 2 })])
  assert.equal(s.agents.a1!.costKnown, false)
  assert.equal(s.agents.a1!.costUsd, 0)
})

test('tool calls count by kind, track files and reset the error run on success', () => {
  const tool = (phase: 'start' | 'end', kind: 'read' | 'edit', subject: string, isError: boolean, atSec: number) =>
    ev('agent.tool', { phase, tool: kind === 'read' ? 'Read' : 'Edit', kind, subject, isError }, { agent: 'a1', atSec })
  const s = run([
    coder,
    tool('start', 'read', 'src/a.ts', false, 2), tool('end', 'read', 'src/a.ts', true, 3),
    tool('start', 'edit', 'src/a.ts', false, 4), tool('end', 'edit', 'src/a.ts', true, 5),
    tool('start', 'edit', 'src/b.ts', false, 6),
  ])
  const a = s.agents.a1!
  assert.equal(a.tools.read, 1)
  assert.equal(a.tools.edit, 2)
  assert.deepEqual(a.files, ['src/a.ts', 'src/b.ts'])
  assert.equal(a.openTools, 1)
  assert.equal(a.errors, 2)
  assert.equal(a.errorsInRow, 2)
  assert.deepEqual(s.edits['src/a.ts'], [{ agent: 'a1', at: at(4) }])
  const after = fold(s, tool('end', 'edit', 'src/b.ts', false, 7))
  assert.equal(after.agents.a1!.errorsInRow, 0)
})

test('messages resolve names to agent ids and build links', () => {
  const tester = ev('agent.started', { name: 'tester', role: 'tester', description: '', parent: LEAD }, { agent: 'a2', atSec: 2 })
  const s = run([
    coder, tester,
    ev('message.sent', { to: 'tester', summary: 'impl done' }, { agent: 'a1', atSec: 3 }),
    ev('message.sent', { to: 'tester', summary: 'one more' }, { agent: 'a1', atSec: 4 }),
    ev('message.sent', { to: 'lead', summary: 'all good' }, { agent: 'a2', atSec: 5 }),
    ev('message.sent', { to: 'ghost', summary: 'anyone?' }, { agent: 'a2', atSec: 6 }),
  ])
  assert.deepEqual(s.links['a1->a2'], { from: 'a1', to: 'a2', count: 2, lastAt: at(4), recent: ['impl done', 'one more'] })
  assert.equal(s.links['a2->lead']!.count, 1)
  assert.equal(s.agents['?ghost']!.placeholder, true)
  assert.equal(s.agents['?ghost']!.name, 'ghost')
  assert.equal(s.agents.a1!.messagesOut, 2)
  assert.equal(s.agents.a2!.messagesIn, 2)
  assert.equal(s.agents.lead!.messagesIn, 1)
})

test('memory writes and tasks are recorded', () => {
  const s = run([
    ev('memory.put', { key: 'design/auth', bytes: 42, preview: 'use the repo pattern' }, { agent: 'a1', atSec: 1, src: 'mcp' }),
    ev('task.created', { id: 't1', title: 'Write auth', assignee: 'coder' }, { atSec: 2, src: 'mcp' }),
    ev('task.updated', { id: 't1', state: 'active', note: 'started' }, { atSec: 3, src: 'mcp' }),
    ev('task.updated', { id: 't9', state: 'done' }, { atSec: 4, src: 'mcp' }),
  ])
  assert.deepEqual(s.memory['design/auth'], { writer: 'a1', at: at(1), bytes: 42, preview: 'use the repo pattern' })
  assert.deepEqual(s.tasks.t1, { id: 't1', title: 'Write auth', state: 'active', assignee: 'coder', dependsOn: [], createdAt: at(2), updatedAt: at(3), note: 'started' })
  assert.equal(s.tasks.t9, undefined)
})

test('a second swarm.started renames the swarm and keeps its start time', () => {
  const s = run([
    ev('swarm.started', { name: 'session-x', topology: 'hierarchical', implicit: true }, { atSec: 1, src: 'mcp' }),
    ev('swarm.started', { name: 'auth refactor', topology: 'mesh', goal: 'ship auth', implicit: false }, { atSec: 5, src: 'mcp' }),
    ev('swarm.ended', { outcome: 'done' }, { atSec: 9, src: 'mcp' }),
  ])
  assert.deepEqual(s.swarm, { id: 's1', name: 'auth refactor', topology: 'mesh', goal: 'ship auth', implicit: false, startedAt: at(1), endedAt: at(9), outcome: 'done' })
})

test('unsafe keys never reach the state objects', () => {
  const s = run([
    ev('message.sent', { to: 'constructor', summary: 'x' }, { agent: '__proto__', atSec: 1 }),
    ev('memory.put', { key: '__proto__', bytes: 1, preview: 'x' }, { atSec: 2, src: 'mcp' }),
  ])
  assert.equal(({} as Record<string, unknown>).x, undefined)
  assert.equal(Object.hasOwn(s.memory, '__proto__'), false)
  assert.ok(s.links['lead->?unknown'])
})

test('bad data types count as zero instead of NaN', () => {
  const bad = ev('agent.usage', { model: 'claude-opus-5-5', input: 'lots' as unknown as number, output: -5, cacheRead: Number.NaN, cacheWrite5m: 0, cacheWrite1h: 0 }, { agent: 'a1', atSec: 2 })
  const s = run([coder, bad])
  assert.deepEqual(s.agents.a1!.tokens, { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 })
})

test('the feed keeps the newest 200 items', () => {
  const events = Array.from({ length: 250 }, (_, i) => ev('message.sent', { to: 'lead', summary: `m${i}` }, { agent: 'a1', atSec: i }))
  const s = run(events)
  assert.equal(s.feed.length, 200)
  assert.equal(s.feed[0]!.text, 'm50')
  assert.equal(s.feed.at(-1)!.text, 'm249')
})

test('foldAll matches folding one event at a time', () => {
  const events = [coder, ev('message.sent', { to: 'lead', summary: 'hi' }, { agent: 'a1', atSec: 2 })]
  const stepwise = emptyState('s1')
  for (const e of events) fold(stepwise, e)
  assert.deepEqual(foldAll('s1', events), stepwise)
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test tests/core/prices.test.ts tests/core/fold.test.ts`
Expected: FAIL. `Cannot find module` for `prices.ts` and `fold.ts`.

- [ ] **Step 3: Write `src/core/prices.ts`**

```ts
/**
 * USD per million tokens. Source: the claude-api skill's model table (cached 2026-10-06) and its
 * prompt-caching reference: cache writes are 1.25x base input (5 minute) and 2x (1 hour), and cache
 * reads vary by model. Update this table when prices change. Nothing else needs to move.
 */

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number }

export type Price = {
  input: number
  output: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
  contextWindow: number
  /** A higher rate for prompts over `above` tokens (Haiku 5.5). */
  longContext?: { above: number; input: number; output: number }
}

const price = (input: number, output: number, cacheRead: number, contextWindow: number, longContext?: Price['longContext']): Price => ({
  input,
  output,
  cacheRead,
  cacheWrite5m: input * 1.25,
  cacheWrite1h: input * 2,
  contextWindow,
  ...(longContext !== undefined && { longContext }),
})

const M = 1_000_000

export const PRICES: Readonly<Record<string, Price>> = {
  'claude-fable-5-1': price(10, 50, 0.25, M),
  'claude-mythos-5-1': price(10, 50, 0.25, M),
  'claude-fable-5': price(10, 50, 1, M),
  'claude-opus-5-5': price(4, 20, 0.2, M),
  'claude-opus-5': price(5, 25, 0.5, M),
  'claude-opus-4-8': price(5, 25, 0.5, M),
  'claude-opus-4-7': price(5, 25, 0.5, M),
  'claude-opus-4-6': price(5, 25, 0.5, M),
  'claude-sonnet-5-5': price(2, 10, 0.2, M),
  'claude-sonnet-5': price(2, 10, 0.2, M),
  'claude-sonnet-4-6': price(3, 15, 0.3, M),
  'claude-haiku-5-5': price(0.1, 0.5, 0.01, M, { above: 100_000, input: 0.5, output: 2.5 }),
  'claude-haiku-4-5': price(1, 5, 0.1, 200_000),
}

/** Exact id first, else the longest table id that the model id extends with a dash (dated ids). */
export function priceFor(model: string): Price | null {
  if (Object.hasOwn(PRICES, model)) return PRICES[model] ?? null
  let best: string | null = null
  for (const key of Object.keys(PRICES)) {
    if (model.startsWith(`${key}-`) && (best === null || key.length > best.length)) best = key
  }
  return best === null ? null : (PRICES[best] ?? null)
}

/** Dollars for one call's usage, or null when the model isn't in the table. */
export function costOf(model: string, usage: Usage): number | null {
  const base = priceFor(model)
  if (base === null) return null
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite5m + usage.cacheWrite1h
  const lc = base.longContext
  const rate = lc !== undefined && prompt > lc.above
    ? { ...base, input: lc.input, output: lc.output, cacheRead: lc.input * 0.1, cacheWrite5m: lc.input * 1.25, cacheWrite1h: lc.input * 2 }
    : base
  return (
    usage.input * rate.input +
    usage.output * rate.output +
    usage.cacheRead * rate.cacheRead +
    usage.cacheWrite5m * rate.cacheWrite5m +
    usage.cacheWrite1h * rate.cacheWrite1h
  ) / M
}
```

- [ ] **Step 4: Write `src/core/fold.ts`**

```ts
/** Folds log events into SwarmState. Deterministic and free of I/O. `fold` mutates for speed. */
import {
  AGENT_OUTCOMES, TASK_STATES, TOOL_KINDS, TOPOLOGIES, isOneOf, isSafeKey,
  type AgentOutcome, type SwarmEvent, type TaskState, type ToolKind, type Topology,
} from './events.ts'
import { costOf, type Usage } from './prices.ts'

export const LEAD = 'lead'

const MAX_FEED = 200
const MAX_FILES = 200
const MAX_SAMPLES = 30
const MAX_RECENT = 5
const MAX_EDITS = 10
const SPEND_KEEP_MS = 600_000

export type UsageSample = { at: number; output: number; gapMs: number }

export type AgentState = {
  id: string
  name: string
  role: string
  description: string
  parent: string
  placeholder: boolean
  startedAt: number
  finishedAt: number | null
  outcome: AgentOutcome | null
  reason: string | null
  model: string | null
  tokens: Usage
  costUsd: number
  costKnown: boolean
  calls: number
  lastPrompt: number
  samples: UsageSample[]
  tools: Record<ToolKind, number>
  openTools: number
  errors: number
  errorsInRow: number
  files: string[]
  messagesIn: number
  messagesOut: number
  lastActivity: number
}

export type LinkState = { from: string; to: string; count: number; lastAt: number; recent: string[] }
export type MemoryEntry = { writer: string; at: number; bytes: number; preview: string }
export type TaskEntry = {
  id: string; title: string; state: TaskState; assignee: string | null; dependsOn: string[]
  createdAt: number; updatedAt: number; note: string | null
}
export type FeedItem = { at: number; kind: 'agent' | 'message' | 'memory' | 'task'; agent: string; text: string; to?: string }
export type SwarmInfo = {
  id: string; name: string; topology: Topology; goal: string | null; implicit: boolean
  startedAt: number | null; endedAt: number | null; outcome: string | null
}

export type SwarmState = {
  swarm: SwarmInfo
  agents: Record<string, AgentState>
  byName: Record<string, string>
  links: Record<string, LinkState>
  memory: Record<string, MemoryEntry>
  tasks: Record<string, TaskEntry>
  feed: FeedItem[]
  edits: Record<string, { agent: string; at: number }[]>
  spend: { at: number; usd: number }[]
  events: number
  lastAt: number
  gaps: number
}

export function emptyState(id: string): SwarmState {
  return {
    swarm: { id, name: id, topology: 'hierarchical', goal: null, implicit: true, startedAt: null, endedAt: null, outcome: null },
    agents: {}, byName: {}, links: {}, memory: {}, tasks: {}, feed: [], edits: {}, spend: [],
    events: 0, lastAt: 0, gaps: 0,
  }
}

const zeroUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 })
const zeroTools = (): Record<ToolKind, number> => Object.fromEntries(TOOL_KINDS.map(k => [k, 0])) as Record<ToolKind, number>
const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0)
const text = (x: unknown, max: number): string => (typeof x === 'string' ? x.slice(0, max) : '')
const trim = <T>(list: T[], max: number): void => {
  while (list.length > max) list.shift()
}

function agentOf(state: SwarmState, id: string, at: number, name?: string): AgentState {
  const found = Object.hasOwn(state.agents, id) ? state.agents[id] : undefined
  if (found !== undefined) return found
  const created: AgentState = {
    id, name: name ?? id, role: id === LEAD ? 'lead' : 'unknown', description: '', parent: id === LEAD ? '' : LEAD,
    placeholder: false, startedAt: at, finishedAt: null, outcome: null, reason: null, model: null,
    tokens: zeroUsage(), costUsd: 0, costKnown: true, calls: 0, lastPrompt: 0, samples: [],
    tools: zeroTools(), openTools: 0, errors: 0, errorsInRow: 0, files: [], messagesIn: 0, messagesOut: 0,
    lastActivity: at,
  }
  state.agents[id] = created
  if (id === LEAD) state.byName[LEAD] = LEAD
  return created
}

/** SendMessage addresses agents by name; the graph is keyed by id. Unknown names get a placeholder node. */
function resolve(state: SwarmState, rawName: string, at: number): string {
  const name = isSafeKey(rawName) ? rawName : 'unknown'
  if (name === LEAD) return agentOf(state, LEAD, at).id
  if (Object.hasOwn(state.byName, name)) return state.byName[name] as string
  if (Object.hasOwn(state.agents, name)) return name
  const id = `?${name}`
  if (!Object.hasOwn(state.agents, id)) agentOf(state, id, at, name).placeholder = true
  return id
}

function feed(state: SwarmState, item: FeedItem): void {
  state.feed.push(item)
  trim(state.feed, MAX_FEED)
}

export function fold(state: SwarmState, e: SwarmEvent): SwarmState {
  const at = Date.parse(e.ts)
  state.events++
  if (at > state.lastAt) state.lastAt = at
  if (state.swarm.startedAt === null) state.swarm.startedAt = at
  const who = e.agent !== undefined && isSafeKey(e.agent) ? e.agent : LEAD

  switch (e.type) {
    case 'swarm.started': {
      const d = e.data
      const name = text(d.name, 64)
      if (name !== '') state.swarm.name = name
      if (isOneOf(TOPOLOGIES, d.topology)) state.swarm.topology = d.topology
      if (typeof d.goal === 'string') state.swarm.goal = d.goal.slice(0, 200)
      state.swarm.implicit = d.implicit === true
      break
    }
    case 'swarm.ended': {
      state.swarm.endedAt = at
      state.swarm.outcome = text(e.data.outcome, 200) || null
      break
    }
    case 'agent.started': {
      const d = e.data
      const a = agentOf(state, who, at)
      a.name = text(d.name, 64) || a.name
      a.role = text(d.role, 64) || a.role
      a.description = text(d.description, 120)
      a.parent = text(d.parent, 64) || LEAD
      a.placeholder = false
      a.startedAt = at
      a.lastActivity = at
      if (isSafeKey(a.name)) state.byName[a.name] = a.id
      feed(state, { at, kind: 'agent', agent: a.id, text: `${a.name} started` })
      break
    }
    case 'agent.finished': {
      const a = agentOf(state, who, at)
      a.outcome = isOneOf(AGENT_OUTCOMES, e.data.outcome) ? e.data.outcome : 'failed'
      a.reason = text(e.data.reason, 80) || null
      a.finishedAt = at
      a.lastActivity = at
      feed(state, { at, kind: 'agent', agent: a.id, text: `${a.name} ${a.outcome === 'answer' ? 'finished' : a.outcome}` })
      break
    }
    case 'agent.usage': {
      const d = e.data
      const a = agentOf(state, who, at)
      const usage: Usage = {
        input: num(d.input), output: num(d.output), cacheRead: num(d.cacheRead),
        cacheWrite5m: num(d.cacheWrite5m), cacheWrite1h: num(d.cacheWrite1h),
      }
      const model = text(d.model, 80) || a.model
      if (model !== null && model !== '') a.model = model
      a.tokens.input += usage.input
      a.tokens.output += usage.output
      a.tokens.cacheRead += usage.cacheRead
      a.tokens.cacheWrite5m += usage.cacheWrite5m
      a.tokens.cacheWrite1h += usage.cacheWrite1h
      const usd = a.model === null ? null : costOf(a.model, usage)
      if (usd === null) {
        a.costKnown = false
      } else {
        a.costUsd += usd
        state.spend.push({ at, usd })
        state.spend = state.spend.filter(s => s.at >= state.lastAt - SPEND_KEEP_MS)
      }
      a.calls++
      a.lastPrompt = usage.input + usage.cacheRead + usage.cacheWrite5m + usage.cacheWrite1h
      a.samples.push({ at, output: usage.output, gapMs: Math.max(0, at - a.lastActivity) })
      trim(a.samples, MAX_SAMPLES)
      a.lastActivity = at
      break
    }
    case 'agent.tool': {
      const d = e.data
      const a = agentOf(state, who, at)
      const kind: ToolKind = isOneOf(TOOL_KINDS, d.kind) ? d.kind : 'other'
      const subject = text(d.subject, 80)
      if (d.phase === 'start') {
        a.tools[kind]++
        a.openTools++
        if ((kind === 'read' || kind === 'edit') && subject !== '' && !a.files.includes(subject) && a.files.length < MAX_FILES) {
          a.files.push(subject)
        }
        if (kind === 'edit' && subject !== '' && isSafeKey(subject)) {
          const list = (state.edits[subject] ??= [])
          list.push({ agent: a.id, at })
          trim(list, MAX_EDITS)
        }
      } else {
        a.openTools = Math.max(0, a.openTools - 1)
        if (d.isError === true) {
          a.errors++
          a.errorsInRow++
        } else {
          a.errorsInRow = 0
        }
      }
      a.lastActivity = at
      break
    }
    case 'message.sent': {
      const from = agentOf(state, who, at)
      const to = resolve(state, text(e.data.to, 64) || 'unknown', at)
      const summary = text(e.data.summary, 200)
      const key = `${from.id}->${to}`
      const link = (state.links[key] ??= { from: from.id, to, count: 0, lastAt: at, recent: [] })
      link.count++
      link.lastAt = at
      link.recent.push(summary)
      trim(link.recent, MAX_RECENT)
      from.messagesOut++
      from.lastActivity = at
      const target = state.agents[to]
      if (target !== undefined) target.messagesIn++
      feed(state, { at, kind: 'message', agent: from.id, to, text: summary })
      break
    }
    case 'memory.put': {
      const key = text(e.data.key, 128)
      if (!isSafeKey(key)) break
      state.memory[key] = { writer: who, at, bytes: num(e.data.bytes), preview: text(e.data.preview, 80) }
      feed(state, { at, kind: 'memory', agent: who, text: `memory.put ${key}` })
      break
    }
    case 'task.created': {
      const d = e.data
      const id = text(d.id, 32)
      if (!isSafeKey(id)) break
      state.tasks[id] = {
        id, title: text(d.title, 120), state: 'pending', assignee: text(d.assignee, 64) || null,
        dependsOn: Array.isArray(d.dependsOn) ? d.dependsOn.filter((x): x is string => typeof x === 'string').slice(0, 20) : [],
        createdAt: at, updatedAt: at, note: null,
      }
      feed(state, { at, kind: 'task', agent: who, text: `task ${id} created: ${state.tasks[id]!.title}` })
      break
    }
    case 'task.updated': {
      const d = e.data
      const id = text(d.id, 32)
      const task = isSafeKey(id) && Object.hasOwn(state.tasks, id) ? state.tasks[id] : undefined
      if (task === undefined) break
      if (isOneOf(TASK_STATES, d.state)) task.state = d.state
      if (typeof d.assignee === 'string') task.assignee = d.assignee.slice(0, 64)
      if (typeof d.note === 'string') task.note = d.note.slice(0, 200)
      task.updatedAt = at
      feed(state, { at, kind: 'task', agent: who, text: `task ${id} → ${task.state}` })
      break
    }
  }
  return state
}

export function foldAll(id: string, events: readonly SwarmEvent[]): SwarmState {
  const state = emptyState(id)
  for (const e of events) fold(state, e)
  return state
}
```

- [ ] **Step 5: Run the gate**

Run: `npm run check`
Expected: no type errors. All prices and fold tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/core/prices.ts src/core/fold.ts tests/core/prices.test.ts tests/core/fold.test.ts
git commit -m "Add the price table and fold events into swarm state"
```

---

### Task 4: MCP JSON-RPC protocol over stdio  *(wave 1, parallel)*

**Files:**
- Create: `src/mcp/protocol.ts`, `tests/mcp/protocol.test.ts`

**Interfaces:**
- Consumes: nothing from core
- Produces:
  - `DEFAULT_PROTOCOL = '2025-06-18'`
  - `type Args = Record<string, unknown>`, `type ToolResult = { text: string; isError?: boolean }`
  - `type ToolDef = { name: string; description: string; inputSchema: Record<string, unknown>; handler: (args: Args) => ToolResult }`
  - `type ServerInfo = { name: string; version: string }`, `type RpcReply`
  - `rpcResult(id, result)`, `rpcError(id, code, message)`
  - `handleMessage(msg: unknown, tools: readonly ToolDef[], info: ServerInfo): RpcReply | null`
  - `runStdio(tools, info, input?: Readable, output?: Writable): Promise<void>`
  - A handler that throws becomes a tool result with `isError: true` and the error's message as text.

- [ ] **Step 1: Write the failing test**

Create `tests/mcp/protocol.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { handleMessage, runStdio, type ToolDef } from '../../src/mcp/protocol.ts'

const info = { name: 'omnis-swarm', version: '0.1.0' }
const echo: ToolDef = {
  name: 'omnis_echo',
  description: 'echo',
  inputSchema: { type: 'object', properties: { say: { type: 'string' } } },
  handler: args => ({ text: String(args.say) }),
}
const boom: ToolDef = { name: 'omnis_boom', description: 'fails', inputSchema: { type: 'object' }, handler: () => { throw new Error('nope') } }
const tools = [echo, boom]
const req = (id: number, method: string, params?: unknown) => ({ jsonrpc: '2.0', id, method, ...(params !== undefined && { params }) })

test('initialize echoes the protocol version and declares tools', () => {
  assert.deepEqual(handleMessage(req(1, 'initialize', { protocolVersion: '2025-03-26' }), tools, info), {
    jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: info },
  })
})

test('notifications get no reply', () => {
  assert.equal(handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, tools, info), null)
})

test('tools/list describes every tool', () => {
  const reply = handleMessage(req(2, 'tools/list'), tools, info)
  assert.deepEqual(reply?.result, { tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) })
})

test('tools/call runs the handler', () => {
  const reply = handleMessage(req(3, 'tools/call', { name: 'omnis_echo', arguments: { say: 'hi' } }), tools, info)
  assert.deepEqual(reply?.result, { content: [{ type: 'text', text: 'hi' }], isError: false })
})

test('a throwing handler becomes an error result, not a protocol error', () => {
  const reply = handleMessage(req(4, 'tools/call', { name: 'omnis_boom', arguments: {} }), tools, info)
  assert.deepEqual(reply?.result, { content: [{ type: 'text', text: 'nope' }], isError: true })
})

test('unknown tools, unknown methods and junk get JSON-RPC errors', () => {
  assert.equal(handleMessage(req(5, 'tools/call', { name: 'nope' }), tools, info)?.error?.code, -32602)
  assert.equal(handleMessage(req(6, 'resources/list'), tools, info)?.error?.code, -32601)
  assert.equal(handleMessage([1, 2], tools, info)?.error?.code, -32600)
  assert.equal(handleMessage({ jsonrpc: '1.0', id: 7, method: 'ping' }, tools, info)?.error?.code, -32600)
  assert.deepEqual(handleMessage(req(8, 'ping'), tools, info), { jsonrpc: '2.0', id: 8, result: {} })
})

test('runStdio answers each line and reports parse errors', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  const lines: string[] = []
  output.on('data', chunk => lines.push(...String(chunk).split('\n').filter(Boolean)))
  const done = runStdio(tools, info, input, output)
  input.write(`${JSON.stringify(req(1, 'ping'))}\n`)
  input.write('{not json\n')
  input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  input.end()
  await done
  assert.deepEqual(lines.map(l => JSON.parse(l)), [
    { jsonrpc: '2.0', id: 1, result: {} },
    { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
  ])
})
```

- [ ] **Step 2: Run the test to see it fail**

Run: `node --test tests/mcp/protocol.test.ts`
Expected: FAIL. `Cannot find module '.../src/mcp/protocol.ts'`.

- [ ] **Step 3: Write the implementation**

Create `src/mcp/protocol.ts`:

```ts
/**
 * The small part of MCP that a tools-only server needs: newline-delimited JSON-RPC 2.0 on stdio,
 * with initialize, ping, tools/list and tools/call. Hand-rolled so the plugin has no npm dependencies.
 * Only replies go to stdout. Anything else would corrupt the stream.
 */
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'

export const DEFAULT_PROTOCOL = '2025-06-18'

export type Args = Record<string, unknown>
export type ToolResult = { text: string; isError?: boolean }
export type ToolDef = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  handler: (args: Args) => ToolResult
}
export type ServerInfo = { name: string; version: string }

type Id = string | number | null
export type RpcReply = { jsonrpc: '2.0'; id: Id; result?: unknown; error?: { code: number; message: string } }

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)

export const rpcResult = (id: Id, result: unknown): RpcReply => ({ jsonrpc: '2.0', id, result })
export const rpcError = (id: Id, code: number, message: string): RpcReply => ({ jsonrpc: '2.0', id, error: { code, message } })

export function handleMessage(msg: unknown, tools: readonly ToolDef[], info: ServerInfo): RpcReply | null {
  if (!isObj(msg)) return rpcError(null, -32600, 'Invalid Request')
  const hasId = typeof msg.id === 'string' || typeof msg.id === 'number'
  const id: Id = hasId ? (msg.id as string | number) : null
  if (typeof msg.method !== 'string') return null // a response to us, or junk with nothing to answer
  if (msg.jsonrpc !== '2.0') return hasId ? rpcError(id, -32600, 'Invalid Request') : null
  if (!hasId) return null // notifications need no reply
  const params = isObj(msg.params) ? msg.params : {}

  switch (msg.method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: info,
      })
    case 'ping':
      return rpcResult(id, {})
    case 'tools/list':
      return rpcResult(id, { tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) })
    case 'tools/call': {
      const tool = typeof params.name === 'string' ? tools.find(t => t.name === params.name) : undefined
      if (tool === undefined) return rpcError(id, -32602, `Unknown tool: ${String(params.name)}`)
      const args = isObj(params.arguments) ? params.arguments : {}
      try {
        const result = tool.handler(args)
        return rpcResult(id, { content: [{ type: 'text', text: result.text }], isError: result.isError === true })
      } catch (err) {
        return rpcResult(id, { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true })
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${msg.method}`)
  }
}

/** Serves until `input` ends. */
export function runStdio(
  tools: readonly ToolDef[],
  info: ServerInfo,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity })
  lines.on('line', line => {
    if (line.trim() === '') return
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      output.write(`${JSON.stringify(rpcError(null, -32700, 'Parse error'))}\n`)
      return
    }
    const reply = handleMessage(msg, tools, info)
    if (reply !== null) output.write(`${JSON.stringify(reply)}\n`)
  })
  return new Promise(resolve => lines.on('close', () => resolve()))
}
```

- [ ] **Step 4: Run the gate**

Run: `npm run check`
Expected: no type errors. All 7 protocol tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/protocol.ts tests/mcp/protocol.test.ts
git commit -m "Add a dependency-free MCP stdio protocol handler"
```

---

### Task 5: Mod API spike  *(wave 1, parallel, no source changes)*

The phase 2 (recorder) and phase 3 (pane) plans depend on how Claude Code's function-hook mods actually behave. Spec section 15 lists those points as unchecked. This task settles them with evidence, so the next plans are written from facts.

**Files:**
- Create: `docs/spikes/2026-10-21-mod-api.md`
- Modify: `docs/superpowers/specs/2026-10-21-omnisswarm-design.md` (section 15 only: mark each item verified or changed, and fix any section the findings contradict)
- Scratch, not committed: a probe plugin in the session scratchpad directory

**Interfaces:**
- Consumes: nothing
- Produces: `docs/spikes/2026-10-21-mod-api.md` answering Q1–Q9 below. Each answer gives the finding, the evidence (doc section, log excerpt or file:line) and the impact on the spec.

Questions to answer:

| # | Question |
|---|---|
| Q1 | Does `agent.spawn`'s `result.agentId` equal the `<id>` in `~/.claude/projects/<project>/<session>/subagents/agent-<id>.jsonl`? |
| Q2 | For a `SendMessage` call, what does `tool.call` expose: tool name, and the recipient and message argument names? |
| Q3 | Does `turn.complete` fire once per subagent with `agentId`, and what are the possible `reason` values? |
| Q4 | Do the lead's tool calls arrive with `agentId` undefined? |
| Q5 | Can a mod module import `node:fs`, `node:path` and relative `.ts` files (so `src/core` can be reused as-is)? If not, which `$` file API is there and what does it look like? |
| Q6 | `Raster`: maximum size, how often frames can be pushed, the `ui.render`/`$.ui.invalidate` pattern, and how a `Button` press reaches the mod. |
| Q7 | For a plugin MCP server: what is its working directory, is `CLAUDE_PROJECT_DIR` set, and is `${CLAUDE_PLUGIN_ROOT}` expanded in `args`? |
| Q8 | What does `session.measure` (or `$.session.usage()`) carry: cost, context %, and field names? |
| Q9 | How does a mod find the session id and the transcript folder (for example the `session.start` payload)? |

- [ ] **Step 1: Read the authoritative docs first**

Load the `plugin-authoring` skill (Skill tool, `plugin-authoring`) and read its mod API reference: event names and payloads, `$` capabilities (fs, ui, session, agent), module loading rules, and the pane/`Raster`/`Button` elements. Record every Q it answers outright, with the section it came from. Also read RuFlo's working mod for cross-checks: `~/.claude/plugins/cache/ruflo/ruflo-swarm/0.3.7/hooks/register.ts` (registration is `export function register(on: On, raw: PluginOptions)`, loaded from `hooks/hooks.json` `{"modules": ["./register.ts"]}`).

- [ ] **Step 2: Build the probe plugin in the scratchpad**

Create `<scratchpad>/omnis-probe/.claude-plugin/plugin.json`:

```json
{ "name": "omnis-probe", "version": "0.0.1", "description": "Logs mod event payloads for the OmnisSwarm spike." }
```

Create `<scratchpad>/omnis-probe/hooks/hooks.json`:

```json
{ "description": "OmnisSwarm spike probe", "modules": ["./probe.ts"] }
```

Create `<scratchpad>/omnis-probe/hooks/probe.ts`. If the docs from Step 1 say mods can't import `node:fs`, swap `appendFileSync` for the documented `$` file API. Otherwise keep `node:fs`, because whether it loads is itself the Q5 test:

```ts
import type { On, PluginOptions } from 'claude-code'
import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const OUT = join(homedir(), 'omnis-probe.jsonl')

/** Keys and short values only, three levels deep, so no prompt or file content is copied. */
function shape(x: unknown, depth = 0): unknown {
  if (depth > 2) return typeof x
  if (Array.isArray(x)) return x.slice(0, 3).map(v => shape(v, depth + 1))
  if (x !== null && typeof x === 'object') {
    return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 120) : shape(v, depth + 1)]))
  }
  return x
}

function log(event: string, payload: unknown): void {
  try {
    appendFileSync(OUT, `${JSON.stringify({ at: new Date().toISOString(), event, payload: shape(payload) })}\n`)
  } catch {
    // the probe must never break the session
  }
}

export function register(on: On, _raw: PluginOptions) {
  for (const name of ['session.start', 'turn.start', 'turn.complete', 'session.measure', 'session.end'] as const) {
    on(name as never, ((_$: unknown, e: unknown, next: (x: unknown) => unknown) => {
      log(name, e)
      return next(e)
    }) as never)
  }
  on('agent.spawn', async ($, e, next) => {
    log('agent.spawn:in', e)
    const result = await next(e)
    log('agent.spawn:out', result)
    return result
  })
  on('tool.call', async ($, e, next) => {
    log('tool.call:in', e)
    const result = await next(e)
    log('tool.call:out', { ...result, text: undefined })
    return result
  })
}
```

- [ ] **Step 3: Run a session that exercises every event**

In a scratch folder (not the OmnisSwarm repo), with function hooks on, start Claude Code with the probe loaded:

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir "<scratchpad>/omnis-probe" -p "Spawn one general-purpose agent named probe-worker. Its only job: use SendMessage to send the text 'hello from probe' to the lead, then read the file README.md if it exists, then finish."
```

Then: `wc -l ~/omnis-probe.jsonl`. If the file is missing or empty, headless mode didn't load the mod. In that case stop and ask Rob to run the same prompt once in an interactive `claude --plugin-dir ...` session, then continue. Don't guess payloads.

- [ ] **Step 4: Check Q1 against the transcript**

Find the session folder under `~/.claude/projects/<scratch-project>/` and list `subagents/`. Compare the `agent-<id>.jsonl` name with `agent.spawn:out`'s `agentId` in the probe log, and record whether they match exactly.

- [ ] **Step 5: Check Q7 with a throwaway MCP server**

Add to the probe's `plugin.json` an `mcpServers` entry running `node -e "require('fs').writeFileSync(require('os').homedir()+'/omnis-probe-mcp.json', JSON.stringify({cwd: process.cwd(), project: process.env.CLAUDE_PROJECT_DIR ?? null, argv: process.argv}))"` with a `${CLAUDE_PLUGIN_ROOT}` argument appended. Start a session and read `~/omnis-probe-mcp.json`.

- [ ] **Step 6: Write the findings**

Create `docs/spikes/2026-10-21-mod-api.md` with: a one-paragraph summary, a table `| Q | Finding | Evidence | Spec impact |` with one row per question, and a short "Changes for phase 2/3" list. Update spec section 15: mark each item ✅ verified or ✏️ changed, linking to the spike doc, and fix any other spec section the findings contradict. Delete `~/omnis-probe.jsonl` and `~/omnis-probe-mcp.json` afterwards.

- [ ] **Step 7: Commit**

```bash
git add docs/spikes/2026-10-21-mod-api.md docs/superpowers/specs/2026-10-21-omnisswarm-design.md
git commit -m "Record what the mod API spike found for the recorder and pane"
```

---

### Task 6: Event log reference doc  *(wave 1, parallel)*

**Files:**
- Create: `docs/event-log.md`

**Interfaces:**
- Consumes: the contract in `src/core/events.ts` (Task 1) and `src/core/log.ts` behaviour (Task 2, as specified in this plan)
- Produces: the reference the future hub and WebGL window build against.

- [ ] **Step 1: Write the doc**

Create `docs/event-log.md` with exactly this content:

````markdown
# OmnisSwarm event log (v1)

Everything OmnisSwarm knows about a swarm is in one append-only file. Readers, including the
pane, the future hub and any WebGL window, rebuild state by folding these lines in order.
`src/core/events.ts` is the source of truth. This page explains it.

## Files

```
.omnis-swarm/current                      id of the active swarm (one line)
.omnis-swarm/swarms/<swarmId>.jsonl       the log
.omnis-swarm/swarms/<swarmId>.snap.json   fold snapshot: {"v":1,"offset":<bytes>,"state":<SwarmState>}
.omnis-swarm/memory/<swarmId>.json        memory values: {"<key>":{"value","writer","at"}}
```

Swarm ids match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` and never contain `..`.

## Envelope

Each line is one JSON object, then `\n`, at most 2048 bytes.

| Field | Type | Notes |
|---|---|---|
| `v` | int | Schema version. Readers ignore lines with a higher `v` than they know |
| `ts` | string | ISO-8601 UTC, millisecond precision, writer's clock |
| `swarm` | string | Swarm id |
| `src` | `"mcp"` \| `"recorder"` \| `"transcripts"` | Which writer |
| `type` | string | Event type, below |
| `agent` | string, optional | Agent id the event is about. Absent means the lead (`"lead"`) |
| `data` | object | Per type, below |

## Event types

| Type | Writer | `data` |
|---|---|---|
| `swarm.started` | mcp, recorder | `name`, `topology` (`hierarchical`\|`mesh`\|`star`), `goal?`, `implicit` (bool). A second one for the same swarm renames it |
| `swarm.ended` | mcp | `outcome?` |
| `agent.started` | recorder | `name`, `role`, `description` (≤120), `parent` (agent id or `lead`) |
| `agent.finished` | recorder | `outcome` (`answer`\|`aborted`\|`failed`), `reason?` (≤80) |
| `agent.usage` | transcripts | `model`, `input`, `output`, `cacheRead`, `cacheWrite5m`, `cacheWrite1h` (token counts for one API call) |
| `agent.tool` | recorder | `phase` (`start`\|`end`), `tool`, `kind` (`read`\|`edit`\|`bash`\|`search`\|`web`\|`agent`\|`other`), `subject` (path or command, ≤80), `isError` |
| `message.sent` | recorder | `to` (agent **name** as given to SendMessage), `summary` (≤200) |
| `memory.put` | mcp | `key`, `bytes`, `preview` (≤80) |
| `task.created` | mcp | `id` (`t1`, `t2`…), `title` (≤120), `assignee?`, `dependsOn?` |
| `task.updated` | mcp | `id`, `state` (`pending`\|`active`\|`done`\|`failed`), `assignee?`, `note?` (≤200) |

## Reading rules

1. Read from your last byte offset to the last `\n`. Keep any trailing partial line for next time.
2. If the file is now shorter than your offset, it was replaced: start again from 0 with empty state.
3. A line that doesn't parse or has the wrong shape is skipped and counted as a gap.
4. Order events by `ts`, then `src` (`mcp` < `recorder` < `transcripts`), then file position.
5. `message.sent.to` is a name. Resolve it to the most recently started agent with that name, or
   `lead`. If nothing matches, show a placeholder node `?<name>`.
6. Snapshots are an optimisation. Loading a snapshot then replaying from its `offset` must give
   the same state as replaying the whole file.

## What is never in the log

Full prompts, tool output, file contents and memory values. Only names, models, numbers, paths,
command lines up to 80 characters, message summaries up to 200 and memory previews up to 80.

## Later: the hub stream

The hub (spec section 13) sends `{"kind":"snapshot","state":<SwarmState>}` on connect, then
`{"kind":"event","event":<envelope>}` for each new line, and `{"kind":"swarm","id":"…"}` when the
current swarm changes. Every envelope is byte-for-byte what is in the file.
````

- [ ] **Step 2: Commit**

```bash
git add docs/event-log.md
git commit -m "Document the event log format for readers"
```

---

### Task 7: Per-agent stats and swarm totals  *(wave 2, parallel)*

**Files:**
- Create: `src/core/stats.ts`, `tests/core/stats.test.ts`

**Interfaces:**
- Consumes: `priceFor`, `type Usage` (prices.ts). `type AgentState`, `type SwarmState` (fold.ts). `TASK_STATES`, types `TaskState`, `ToolKind` (events.ts)
- Produces:
  - Constants `RUNNING_WINDOW_MS = 5_000`, `SPEED_WINDOW_MS = 30_000`, `BURN_WINDOW_MS = 300_000`, `CLASH_WINDOW_MS = 600_000`, `STUCK_AFTER = 3`
  - `type AgentStatus = 'running' | 'waiting' | 'done' | 'failed'`, `agentStatus(a: AgentState, nowMs: number): AgentStatus`
  - `totalTokens(u: Usage): number`, `contextFill(a): number | null`, `cacheHitRate(a): number | null`, `speedSeries(a): number[]`, `speed(a, nowMs): number | null`
  - `type Clash = { path: string; agents: string[] }`, `fileClashes(state): Clash[]`
  - `type AgentStats` (see code), `agentStats(state, id, nowMs): AgentStats | null`
  - `type SwarmTotals` (see code), `swarmTotals(state, nowMs): SwarmTotals`

- [ ] **Step 1: Write the failing test**

Create `tests/core/stats.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldAll, LEAD } from '../../src/core/fold.ts'
import { agentStats, fileClashes, swarmTotals } from '../../src/core/stats.ts'
import { at, ev } from '../helpers.ts'

const near = (a: number | null, b: number) => assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`)
const start = (id: string, name: string, atSec = 0) => ev('agent.started', { name, role: name, description: '', parent: LEAD }, { agent: id, atSec })
const usage = (id: string, atSec: number, u: { input?: number; output?: number; cacheRead?: number }) =>
  ev('agent.usage', { model: 'claude-sonnet-5-5', input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite5m: 0, cacheWrite1h: 0 }, { agent: id, atSec })
const edit = (id: string, path: string, atSec: number) => ev('agent.tool', { phase: 'start', tool: 'Edit', kind: 'edit', subject: path, isError: false }, { agent: id, atSec })

const state = () => foldAll('s1', [
  start('a1', 'coder'),
  usage('a1', 10, { input: 1000, output: 500, cacheRead: 9000 }),
  usage('a1', 20, { output: 1000, cacheRead: 10000 }),
])

test('agentStats works out tokens, cost, cache hit, context fill and speed', () => {
  const s = agentStats(state(), 'a1', at(21))!
  assert.equal(s.tokens.total, 21500)
  near(s.costUsd, 0.0208)
  near(s.cacheHitRate, 0.95)
  near(s.contextFill, 0.01)
  near(s.speedTps, 75)
  assert.deepEqual(s.speedSeries, [50, 100])
  assert.equal(s.status, 'running')
  assert.equal(s.lifetimeMs, 21_000)
})

test('status goes from running to waiting to done or failed', () => {
  const s = state()
  assert.equal(agentStats(s, 'a1', at(40))!.status, 'waiting')
  const done = foldAll('s1', [start('a1', 'coder'), ev('agent.finished', { outcome: 'aborted' }, { agent: 'a1', atSec: 3 })])
  assert.equal(agentStats(done, 'a1', at(4))!.status, 'done')
  const failed = foldAll('s1', [start('a1', 'coder'), ev('agent.finished', { outcome: 'failed' }, { agent: 'a1', atSec: 3 })])
  assert.equal(agentStats(failed, 'a1', at(4))!.status, 'failed')
})

test('speed only counts the last 30 seconds', () => {
  assert.equal(agentStats(state(), 'a1', at(60))!.speedTps, null)
})

test('stats with no calls are null rather than zero', () => {
  const s = agentStats(foldAll('s1', [start('a1', 'coder')]), 'a1', at(1))!
  assert.equal(s.cacheHitRate, null)
  assert.equal(s.contextFill, null)
  assert.equal(s.speedTps, null)
  assert.equal(s.costUsd, 0)
})

test('an unpriced model gives a null cost', () => {
  const s = foldAll('s1', [start('a1', 'coder'), ev('agent.usage', { model: 'mystery', input: 5, output: 5, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, { agent: 'a1', atSec: 1 })])
  assert.equal(agentStats(s, 'a1', at(2))!.costUsd, null)
})

test('three failed tool calls in a row mark an agent as stuck', () => {
  const fail = (atSec: number) => ev('agent.tool', { phase: 'end', tool: 'Bash', kind: 'bash', subject: 'npm test', isError: true }, { agent: 'a1', atSec })
  const s = foldAll('s1', [start('a1', 'coder'), fail(1), fail(2), fail(3)])
  assert.equal(agentStats(s, 'a1', at(4))!.stuck, true)
})

test('two agents editing one file within ten minutes is a clash', () => {
  const s = foldAll('s1', [
    start('a1', 'coder'), start('a2', 'tester'),
    edit('a1', 'src/auth.ts', 10), edit('a2', 'src/auth.ts', 100),
    edit('a1', 'src/old.ts', 10), edit('a2', 'src/old.ts', 10 + 601),
  ])
  assert.deepEqual(fileClashes(s), [{ path: 'src/auth.ts', agents: ['a1', 'a2'] }])
  assert.deepEqual(agentStats(s, 'a2', at(200))!.clashes, ['src/auth.ts'])
})

test('swarmTotals adds up the swarm', () => {
  const s = foldAll('s1', [
    start('a1', 'coder'),
    usage('a1', 10, { input: 1000, output: 500, cacheRead: 9000 }),
    usage('a1', 20, { output: 1000, cacheRead: 10000 }),
    start('a2', 'tester', 5),
    ev('message.sent', { to: 'tester', summary: 'go' }, { agent: 'a1', atSec: 21 }),
    ev('message.sent', { to: 'tester', summary: 'again' }, { agent: 'a1', atSec: 22 }),
    ev('message.sent', { to: 'ghost', summary: '?' }, { agent: 'a2', atSec: 23 }),
    ev('task.created', { id: 't1', title: 'x' }, { atSec: 24, src: 'mcp' }),
    ev('task.created', { id: 't2', title: 'y' }, { atSec: 24, src: 'mcp' }),
    ev('task.updated', { id: 't2', state: 'done' }, { atSec: 25, src: 'mcp' }),
  ])
  const t = swarmTotals(s, at(25))
  assert.equal(t.agents, 2) // coder and tester; the lead never acted and the ghost placeholder is not counted
  assert.equal(t.tokens, 21500)
  near(t.costUsd, 0.0208)
  assert.equal(t.costPartial, false)
  near(t.burnPerMin, 0.0208 / 5)
  assert.deepEqual(t.busiestLink, { from: 'a1', to: 'a2', count: 2 })
  assert.equal(t.mostExpensive, 'a1')
  assert.deepEqual(t.tasks, { pending: 1, active: 0, done: 1, failed: 0 })
  assert.equal(t.clashes, 0)
})
```

- [ ] **Step 2: Run the test to see it fail**

Run: `node --test tests/core/stats.test.ts`
Expected: FAIL. `Cannot find module '.../src/core/stats.ts'`.

- [ ] **Step 3: Write the implementation**

Create `src/core/stats.ts`:

```ts
/** Per-agent stats and swarm totals worked out from SwarmState. Pure. */
import { TASK_STATES, type TaskState, type ToolKind } from './events.ts'
import type { AgentState, SwarmState } from './fold.ts'
import { priceFor, type Usage } from './prices.ts'

export const RUNNING_WINDOW_MS = 5_000
export const SPEED_WINDOW_MS = 30_000
export const BURN_WINDOW_MS = 300_000
export const CLASH_WINDOW_MS = 600_000
export const STUCK_AFTER = 3

export type AgentStatus = 'running' | 'waiting' | 'done' | 'failed'

export function agentStatus(a: AgentState, nowMs: number): AgentStatus {
  if (a.outcome !== null) return a.outcome === 'failed' ? 'failed' : 'done'
  return a.openTools > 0 || nowMs - a.lastActivity <= RUNNING_WINDOW_MS ? 'running' : 'waiting'
}

export const totalTokens = (u: Usage): number => u.input + u.output + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h

/** The latest call's prompt size against the model's context window. */
export function contextFill(a: AgentState): number | null {
  if (a.model === null || a.calls === 0) return null
  const price = priceFor(a.model)
  return price === null ? null : Math.min(1, a.lastPrompt / price.contextWindow)
}

export function cacheHitRate(a: AgentState): number | null {
  const t = a.tokens
  const prompt = t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h
  return prompt === 0 ? null : t.cacheRead / prompt
}

/** Output tokens per second for each call (≈: the gap includes tool time). */
export const speedSeries = (a: AgentState): number[] =>
  a.samples.filter(s => s.gapMs > 0).map(s => s.output / (s.gapMs / 1000))

/** Output tokens per second over calls in the last SPEED_WINDOW_MS. */
export function speed(a: AgentState, nowMs: number): number | null {
  const recent = a.samples.filter(s => s.gapMs > 0 && nowMs - s.at <= SPEED_WINDOW_MS)
  const seconds = recent.reduce((t, s) => t + s.gapMs, 0) / 1000
  return seconds === 0 ? null : recent.reduce((t, s) => t + s.output, 0) / seconds
}

export type Clash = { path: string; agents: string[] }

/** Paths edited by two or more agents within CLASH_WINDOW_MS of each other. */
export function fileClashes(state: SwarmState): Clash[] {
  const clashes: Clash[] = []
  for (const [path, edits] of Object.entries(state.edits)) {
    const agents = new Set<string>()
    for (let i = 0; i < edits.length; i++) {
      for (let j = i + 1; j < edits.length; j++) {
        const a = edits[i]!
        const b = edits[j]!
        if (a.agent !== b.agent && Math.abs(a.at - b.at) <= CLASH_WINDOW_MS) {
          agents.add(a.agent)
          agents.add(b.agent)
        }
      }
    }
    if (agents.size > 0) clashes.push({ path, agents: [...agents].sort() })
  }
  return clashes.sort((x, y) => x.path.localeCompare(y.path))
}

export type AgentStats = {
  id: string
  name: string
  role: string
  model: string | null
  status: AgentStatus
  placeholder: boolean
  lifetimeMs: number
  tokens: Usage & { total: number }
  costUsd: number | null
  contextFill: number | null
  cacheHitRate: number | null
  speedTps: number | null
  speedSeries: number[]
  tools: Record<ToolKind, number>
  files: string[]
  messagesIn: number
  messagesOut: number
  errors: number
  stuck: boolean
  clashes: string[]
}

export function agentStats(state: SwarmState, id: string, nowMs: number): AgentStats | null {
  const a = Object.hasOwn(state.agents, id) ? state.agents[id] : undefined
  if (a === undefined) return null
  return {
    id: a.id,
    name: a.name,
    role: a.role,
    model: a.model,
    status: agentStatus(a, nowMs),
    placeholder: a.placeholder,
    lifetimeMs: (a.finishedAt ?? nowMs) - a.startedAt,
    tokens: { ...a.tokens, total: totalTokens(a.tokens) },
    costUsd: a.costKnown ? a.costUsd : null,
    contextFill: contextFill(a),
    cacheHitRate: cacheHitRate(a),
    speedTps: speed(a, nowMs),
    speedSeries: speedSeries(a),
    tools: { ...a.tools },
    files: [...a.files],
    messagesIn: a.messagesIn,
    messagesOut: a.messagesOut,
    errors: a.errors,
    stuck: a.errorsInRow >= STUCK_AFTER,
    clashes: fileClashes(state).filter(c => c.agents.includes(a.id)).map(c => c.path),
  }
}

export type SwarmTotals = {
  agents: number
  running: number
  tokens: number
  costUsd: number
  /** True when some usage came from a model missing from the price table. */
  costPartial: boolean
  burnPerMin: number
  busiestLink: { from: string; to: string; count: number } | null
  mostExpensive: string | null
  tasks: Record<TaskState, number>
  clashes: number
}

export function swarmTotals(state: SwarmState, nowMs: number): SwarmTotals {
  const agents = Object.values(state.agents).filter(a => !a.placeholder)
  let tokens = 0
  let cost = 0
  let partial = false
  let running = 0
  let top: AgentState | null = null
  for (const a of agents) {
    tokens += totalTokens(a.tokens)
    cost += a.costUsd
    if (!a.costKnown) partial = true
    if (agentStatus(a, nowMs) === 'running') running++
    if (top === null || a.costUsd > top.costUsd) top = a
  }
  const recentSpend = state.spend.filter(s => s.at <= nowMs && nowMs - s.at <= BURN_WINDOW_MS).reduce((t, s) => t + s.usd, 0)
  let busiest: SwarmTotals['busiestLink'] = null
  for (const link of Object.values(state.links)) {
    if (busiest === null || link.count > busiest.count) busiest = { from: link.from, to: link.to, count: link.count }
  }
  const tasks = Object.fromEntries(TASK_STATES.map(s => [s, 0])) as Record<TaskState, number>
  for (const task of Object.values(state.tasks)) tasks[task.state]++
  return {
    agents: agents.length,
    running,
    tokens,
    costUsd: cost,
    costPartial: partial,
    burnPerMin: recentSpend / (BURN_WINDOW_MS / 60_000),
    busiestLink: busiest,
    mostExpensive: top !== null && top.costUsd > 0 ? top.id : null,
    tasks,
    clashes: fileClashes(state).length,
  }
}
```

- [ ] **Step 4: Run the gate**

Run: `npm run check`
Expected: no type errors. All 8 stats tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/stats.ts tests/core/stats.test.ts
git commit -m "Work out per-agent stats and swarm totals from folded state"
```

---

### Task 8: Snapshots, incremental loading and swarm setup  *(wave 2, parallel)*

**Files:**
- Create: `src/core/snapshot.ts`, `src/core/swarm.ts`, `tests/core/snapshot.test.ts`, `tests/core/swarm.test.ts`

**Interfaces:**
- Consumes: `emptyState`, `fold`, `type SwarmState` (fold.ts). `appendEvent`, `ensureLogDirs`, `readCurrent`, `readEvents`, `sortEvents`, `swarmLogPath`, `writeCurrent` (log.ts). `makeEvent`, `type Source` (events.ts)
- Produces:
  - `SNAPSHOT_EVERY = 500`
  - `type Loaded = { state: SwarmState; offset: number; sinceSnapshot: number }`
  - `snapshotPath(root, id): string`, `saveSnapshot(root, loaded): void`, `loadSnapshot(root, id): Loaded | null`
  - `advance(root: string, loaded: Loaded): number` (folds new lines into `loaded` in place and returns how many events it added)
  - `loadState(root: string, id: string): Loaded`
  - `slugify(name: string): string`, `uniqueSwarmId(root: string, base: string): string`
  - `ensureSwarm(root: string, input: { idHint: string; src: Source; now?: Date }): string` (returns the current swarm id, creating an implicit one if there is none)

- [ ] **Step 1: Write the failing tests**

Create `tests/core/snapshot.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { foldAll } from '../../src/core/fold.ts'
import { serialise } from '../../src/core/events.ts'
import { appendEvent, readEvents, swarmLogPath } from '../../src/core/log.ts'
import { advance, loadState, SNAPSHOT_EVERY, snapshotPath } from '../../src/core/snapshot.ts'
import { ev, tmpRoot } from '../helpers.ts'

const msg = (n: number) => ev('message.sent', { to: 'lead', summary: `m${n}` }, { agent: 'a1', atSec: n })
const write = (root: string, from: number, to: number) => { for (let n = from; n < to; n++) appendEvent(root, msg(n)) }

test('loadState folds the whole log on first load', () => {
  const root = tmpRoot()
  write(root, 0, 3)
  const loaded = loadState(root, 's1')
  assert.equal(loaded.state.events, 3)
  assert.equal(loaded.state.links['a1->lead']!.count, 3)
})

test('advance folds only lines added since the last read', () => {
  const root = tmpRoot()
  write(root, 0, 2)
  const loaded = loadState(root, 's1')
  write(root, 2, 5)
  assert.equal(advance(root, loaded), 3)
  assert.equal(loaded.state.events, 5)
  assert.equal(advance(root, loaded), 0)
})

test('a snapshot is written after enough events and gives the same state as a full replay', () => {
  const root = tmpRoot()
  write(root, 0, SNAPSHOT_EVERY + 10)
  loadState(root, 's1')
  assert.ok(existsSync(snapshotPath(root, 's1')))
  write(root, SNAPSHOT_EVERY + 10, SNAPSHOT_EVERY + 20)
  const fromSnapshot = loadState(root, 's1')
  const full = foldAll('s1', readEvents(swarmLogPath(root, 's1')).events)
  assert.deepEqual(fromSnapshot.state, full)
})

test('a corrupt snapshot is ignored', () => {
  const root = tmpRoot()
  write(root, 0, 3)
  loadState(root, 's1')
  writeFileSync(snapshotPath(root, 's1'), '{not json')
  assert.equal(loadState(root, 's1').state.events, 3)
})

test('corrupt lines are counted as gaps', () => {
  const root = tmpRoot()
  write(root, 0, 1)
  writeFileSync(swarmLogPath(root, 's1'), `${serialise(msg(0))}{broken\n`)
  assert.equal(loadState(root, 's1').state.gaps, 1)
})

test('a replaced log rebuilds state from scratch', () => {
  const root = tmpRoot()
  write(root, 0, 5)
  const loaded = loadState(root, 's1')
  writeFileSync(swarmLogPath(root, 's1'), serialise(msg(9)))
  advance(root, loaded)
  assert.equal(loaded.state.events, 1)
})
```

Create `tests/core/swarm.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendEvent, readCurrent, readEvents, swarmLogPath, writeCurrent } from '../../src/core/log.ts'
import { ensureSwarm, slugify, uniqueSwarmId } from '../../src/core/swarm.ts'
import { ev, tmpRoot } from '../helpers.ts'

test('slugify makes a safe id from a human name', () => {
  assert.equal(slugify('Auth Refactor!'), 'auth-refactor')
  assert.equal(slugify('  --weird__name--  '), 'weird-name')
  assert.equal(slugify('!!!'), '')
  assert.equal(slugify('x'.repeat(100)).length, 64)
})

test('uniqueSwarmId adds a number when the id is taken', () => {
  const root = tmpRoot()
  assert.equal(uniqueSwarmId(root, 'Auth'), 'auth')
  appendEvent(root, ev('swarm.ended', {}, { swarm: 'auth', src: 'mcp' }))
  assert.equal(uniqueSwarmId(root, 'Auth'), 'auth-2')
  assert.equal(uniqueSwarmId(root, '???'), 'swarm')
})

test('ensureSwarm returns the current swarm when there is one', () => {
  const root = tmpRoot()
  writeCurrent(root, 'auth')
  assert.equal(ensureSwarm(root, { idHint: 'session-x', src: 'mcp' }), 'auth')
})

test('ensureSwarm starts an implicit swarm when there is none', () => {
  const root = tmpRoot()
  const now = new Date('2026-10-21T10:00:00.000Z')
  const id = ensureSwarm(root, { idHint: 'session-20261021-100000', src: 'mcp', now })
  assert.equal(id, 'session-20261021-100000')
  assert.equal(readCurrent(root), id)
  const [started] = readEvents(swarmLogPath(root, id)).events
  assert.deepEqual(started, {
    v: 1, ts: now.toISOString(), swarm: id, src: 'mcp', type: 'swarm.started',
    data: { name: id, topology: 'hierarchical', implicit: true },
  })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test tests/core/snapshot.test.ts tests/core/swarm.test.ts`
Expected: FAIL. `Cannot find module` for `snapshot.ts` and `swarm.ts`.

- [ ] **Step 3: Write `src/core/snapshot.ts`**

```ts
/** Loads swarm state from a snapshot plus the log tail, and keeps it current with `advance`. */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { emptyState, fold, type SwarmState } from './fold.ts'
import { ensureLogDirs, readEvents, sortEvents, swarmLogPath } from './log.ts'

export const SNAPSHOT_EVERY = 500

export type Loaded = { state: SwarmState; offset: number; sinceSnapshot: number }

export const snapshotPath = (root: string, id: string): string => swarmLogPath(root, id).replace(/\.jsonl$/, '.snap.json')

export function saveSnapshot(root: string, loaded: Loaded): void {
  ensureLogDirs(root)
  const file = snapshotPath(root, loaded.state.swarm.id)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify({ v: 1, offset: loaded.offset, state: loaded.state }))
  renameSync(tmp, file)
}

export function loadSnapshot(root: string, id: string): Loaded | null {
  try {
    const raw = JSON.parse(readFileSync(snapshotPath(root, id), 'utf8')) as { v?: unknown; offset?: unknown; state?: SwarmState }
    if (raw.v !== 1 || typeof raw.offset !== 'number' || raw.state?.swarm?.id !== id) return null
    return { state: raw.state as SwarmState, offset: raw.offset, sinceSnapshot: 0 }
  } catch {
    return null
  }
}

/** Folds any new complete lines into `loaded`. Returns how many events were added. */
export function advance(root: string, loaded: Loaded): number {
  const id = loaded.state.swarm.id
  const read = readEvents(swarmLogPath(root, id), loaded.offset)
  if (read.reset) {
    loaded.state = emptyState(id)
    loaded.sinceSnapshot = 0
  }
  for (const event of sortEvents(read.events)) fold(loaded.state, event)
  loaded.state.gaps += read.bad
  loaded.offset = read.offset
  loaded.sinceSnapshot += read.events.length
  if (loaded.sinceSnapshot >= SNAPSHOT_EVERY) {
    try {
      saveSnapshot(root, loaded)
      loaded.sinceSnapshot = 0
    } catch {
      // A missed snapshot only costs replay time next load.
    }
  }
  return read.events.length
}

export function loadState(root: string, id: string): Loaded {
  const loaded = loadSnapshot(root, id) ?? { state: emptyState(id), offset: 0, sinceSnapshot: 0 }
  advance(root, loaded)
  return loaded
}
```

- [ ] **Step 4: Write `src/core/swarm.ts`**

```ts
/** Naming swarms and making sure one is running. */
import { existsSync } from 'node:fs'
import { makeEvent, type Source } from './events.ts'
import { appendEvent, readCurrent, swarmLogPath, writeCurrent } from './log.ts'

/** Lower-case letters, digits, dots and dashes; no leading or trailing punctuation; at most 64 characters. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64)
    .replace(/[-.]+$/g, '')
}

export function uniqueSwarmId(root: string, base: string): string {
  const id = slugify(base) || 'swarm'
  if (!existsSync(swarmLogPath(root, id))) return id
  for (let n = 2; ; n++) {
    const candidate = `${id.slice(0, 60)}-${n}`
    if (!existsSync(swarmLogPath(root, candidate))) return candidate
  }
}

/** The current swarm id, starting an implicit hierarchical swarm named after `idHint` if none is running. */
export function ensureSwarm(root: string, input: { idHint: string; src: Source; now?: Date }): string {
  const current = readCurrent(root)
  if (current !== null) return current
  const id = uniqueSwarmId(root, input.idHint)
  writeCurrent(root, id)
  appendEvent(root, makeEvent({
    type: 'swarm.started',
    swarm: id,
    src: input.src,
    data: { name: id, topology: 'hierarchical', implicit: true },
    ...(input.now !== undefined && { now: input.now }),
  }))
  return id
}
```

- [ ] **Step 5: Run the gate**

Run: `npm run check`
Expected: no type errors. All snapshot and swarm tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/core/snapshot.ts src/core/swarm.ts tests/core/snapshot.test.ts tests/core/swarm.test.ts
git commit -m "Load swarm state from snapshots plus the log tail, and start implicit swarms"
```

---

### Task 9: Memory value store  *(wave 2, parallel)*

**Files:**
- Create: `src/mcp/memory-store.ts`, `tests/mcp/memory-store.test.ts`

**Interfaces:**
- Consumes: `ensureLogDirs`, `isValidSwarmId`, `logPaths` (log.ts)
- Produces:
  - `MAX_VALUE_BYTES = 4096`
  - `type StoredValue = { value: string; writer: string; at: string }`
  - `readMemory(root: string, swarm: string): Record<string, StoredValue>` (null-prototype object; `{}` when missing or corrupt)
  - `putMemory(root: string, swarm: string, key: string, value: string, writer: string, now?: Date): void`

- [ ] **Step 1: Write the failing test**

Create `tests/mcp/memory-store.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { logPaths } from '../../src/core/log.ts'
import { putMemory, readMemory } from '../../src/mcp/memory-store.ts'
import { tmpRoot } from '../helpers.ts'

const now = new Date('2026-10-21T10:00:00.000Z')

test('values round-trip and later writes replace earlier ones', () => {
  const root = tmpRoot()
  putMemory(root, 's1', 'design/auth', 'v1', 'a1', now)
  putMemory(root, 's1', 'design/auth', 'v2', 'a2', now)
  putMemory(root, 's1', 'other', 'x', 'lead', now)
  const all = readMemory(root, 's1')
  assert.deepEqual({ ...all['design/auth'] }, { value: 'v2', writer: 'a2', at: now.toISOString() })
  assert.deepEqual(Object.keys(all).sort(), ['design/auth', 'other'])
})

test('a missing or corrupt file reads as empty', () => {
  const root = tmpRoot()
  assert.deepEqual(Object.keys(readMemory(root, 's1')), [])
  putMemory(root, 's1', 'k', 'v', 'lead', now)
  writeFileSync(join(logPaths(root).memory, 's1.json'), '{nope')
  assert.deepEqual(Object.keys(readMemory(root, 's1')), [])
})

test('an invalid swarm id is refused', () => {
  assert.throws(() => readMemory(tmpRoot(), '../x'))
  assert.throws(() => putMemory(tmpRoot(), '../x', 'k', 'v', 'lead'))
})
```

- [ ] **Step 2: Run the test to see it fail**

Run: `node --test tests/mcp/memory-store.test.ts`
Expected: FAIL. `Cannot find module '.../src/mcp/memory-store.ts'`.

- [ ] **Step 3: Write the implementation**

Create `src/mcp/memory-store.ts`:

```ts
/** Shared memory values, one JSON file per swarm. The log only records that a write happened. */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureLogDirs, isValidSwarmId, logPaths } from '../core/log.ts'

export const MAX_VALUE_BYTES = 4096

export type StoredValue = { value: string; writer: string; at: string }

function fileFor(root: string, swarm: string): string {
  if (!isValidSwarmId(swarm)) throw new Error(`invalid swarm id: ${JSON.stringify(swarm)}`)
  return join(logPaths(root).memory, `${swarm}.json`)
}

export function readMemory(root: string, swarm: string): Record<string, StoredValue> {
  const file = fileFor(root, swarm)
  const out = Object.create(null) as Record<string, StoredValue>
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) Object.assign(out, raw)
  } catch {
    // missing or corrupt: empty
  }
  return out
}

export function putMemory(root: string, swarm: string, key: string, value: string, writer: string, now = new Date()): void {
  const file = fileFor(root, swarm)
  const all = readMemory(root, swarm)
  all[key] = { value, writer, at: now.toISOString() }
  ensureLogDirs(root)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(all))
  renameSync(tmp, file)
}
```

- [ ] **Step 4: Run the gate**

Run: `npm run check`
Expected: no type errors. All 3 memory-store tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/memory-store.ts tests/mcp/memory-store.test.ts
git commit -m "Add the shared memory value store"
```

---

### Task 10: The omnis_* MCP tools

**Files:**
- Create: `src/mcp/validate.ts`, `src/mcp/tools.ts`, `tests/mcp/tools.test.ts`

**Interfaces:**
- Consumes: `type Args`, `type ToolDef`, `type ToolResult` (protocol.ts). `makeEvent`, `clip`, `isSafeKey`, `TASK_STATES`, `TOPOLOGIES`, `type SwarmEvent` (events.ts). `appendEvent`, `readCurrent`, `writeCurrent`, `clearCurrent` (log.ts). `loadState` (snapshot.ts). `ensureSwarm`, `uniqueSwarmId` (swarm.ts). `agentStats`, `swarmTotals` (stats.ts). `MAX_VALUE_BYTES`, `putMemory`, `readMemory` (memory-store.ts)
- Produces:
  - `class InputError extends Error`, plus `reqString`, `optString`, `reqEnum`, `optStringList` (validate.ts)
  - `type ToolContext = { root: string; now?: () => Date }`
  - `createTools(ctx: ToolContext): ToolDef[]`, which returns exactly these tools: `omnis_swarm_init`, `omnis_swarm_end`, `omnis_swarm_status`, `omnis_memory_put`, `omnis_memory_get`, `omnis_memory_list`, `omnis_task_create`, `omnis_task_update`

- [ ] **Step 1: Write the failing test**

Create `tests/mcp/tools.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readCurrent, readEvents, swarmLogPath } from '../../src/core/log.ts'
import { createTools } from '../../src/mcp/tools.ts'
import { InputError } from '../../src/mcp/validate.ts'
import { tmpRoot } from '../helpers.ts'

const NOW = new Date('2026-10-21T10:00:00.000Z')
const setup = () => {
  const root = tmpRoot()
  const tools = createTools({ root, now: () => NOW })
  const call = (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.find(t => t.name === name)
    if (tool === undefined) throw new Error(`no tool ${name}`)
    return tool.handler(args)
  }
  const events = (id: string) => readEvents(swarmLogPath(root, id)).events
  return { root, tools, call, events }
}

test('exactly the eight omnis tools are offered, each with an object schema', () => {
  const { tools } = setup()
  assert.deepEqual(tools.map(t => t.name).sort(), [
    'omnis_memory_get', 'omnis_memory_list', 'omnis_memory_put', 'omnis_swarm_end',
    'omnis_swarm_init', 'omnis_swarm_status', 'omnis_task_create', 'omnis_task_update',
  ])
  for (const t of tools) assert.equal(t.inputSchema.type, 'object')
})

test('swarm_init starts a named swarm and makes it current', () => {
  const { root, call, events } = setup()
  const r = call('omnis_swarm_init', { name: 'Auth Refactor', topology: 'mesh', goal: 'ship it' })
  assert.match(r.text, /auth-refactor/)
  assert.equal(readCurrent(root), 'auth-refactor')
  assert.deepEqual(events('auth-refactor')[0]?.data, { name: 'Auth Refactor', topology: 'mesh', goal: 'ship it', implicit: false })
})

test('swarm_init names the implicit session swarm instead of starting another', () => {
  const { root, call, events } = setup()
  call('omnis_memory_put', { key: 'k', value: 'v' })
  const implicit = readCurrent(root)!
  assert.equal(implicit, 'session-20261021-100000')
  call('omnis_swarm_init', { name: 'Auth', topology: 'star' })
  assert.equal(readCurrent(root), implicit)
  const started = events(implicit).filter(e => e.type === 'swarm.started')
  assert.equal(started.length, 2)
  assert.deepEqual(started[1]?.data, { name: 'Auth', topology: 'star', implicit: false })
})

test('swarm_init while an explicit swarm runs ends it and starts the new one', () => {
  const { root, call, events } = setup()
  call('omnis_swarm_init', { name: 'First', topology: 'mesh' })
  call('omnis_swarm_init', { name: 'Second', topology: 'mesh' })
  assert.equal(readCurrent(root), 'second')
  assert.deepEqual(events('first').at(-1)?.data, { outcome: 'replaced' })
})

test('bad input is refused with an InputError', () => {
  const { call } = setup()
  assert.throws(() => call('omnis_swarm_init', { name: 'x', topology: 'ring' }), InputError)
  assert.throws(() => call('omnis_swarm_init', { topology: 'mesh' }), InputError)
  assert.throws(() => call('omnis_memory_put', { key: 'bad key!', value: 'v' }), InputError)
  assert.throws(() => call('omnis_memory_put', { key: '__proto__', value: 'v' }), InputError)
  assert.throws(() => call('omnis_memory_put', { key: 'k', value: 'é'.repeat(2049) }), InputError)
})

test('memory put, get and list round-trip and log a preview', () => {
  const { root, call, events } = setup()
  call('omnis_swarm_init', { name: 'Mem', topology: 'mesh' })
  call('omnis_memory_put', { key: 'design/auth', value: 'use the repo pattern', agent: 'coder' })
  assert.equal(call('omnis_memory_get', { key: 'design/auth' }).text, 'use the repo pattern')
  assert.match(call('omnis_memory_get', { key: 'nope' }).text, /No value/)
  assert.match(call('omnis_memory_list', {}).text, /design\/auth · coder/)
  assert.match(call('omnis_memory_list', { prefix: 'zzz' }).text, /No keys/)
  const put = events(readCurrent(root)!).find(e => e.type === 'memory.put')
  assert.equal(put?.agent, 'coder')
  assert.deepEqual(put?.data, { key: 'design/auth', bytes: 20, preview: 'use the repo pattern' })
})

test('tasks are created with sequential ids and updated', () => {
  const { root, call, events } = setup()
  call('omnis_swarm_init', { name: 'Tasks', topology: 'hierarchical' })
  assert.match(call('omnis_task_create', { title: 'Write auth', assignee: 'coder' }).text, /t1/)
  assert.match(call('omnis_task_create', { title: 'Test auth', dependsOn: ['t1'] }).text, /t2/)
  call('omnis_task_update', { id: 't1', state: 'done', note: 'merged' })
  assert.throws(() => call('omnis_task_update', { id: 't9', state: 'done' }), InputError)
  const types = events(readCurrent(root)!).map(e => e.type)
  assert.deepEqual(types.filter(t => t.startsWith('task.')), ['task.created', 'task.created', 'task.updated'])
})

test('status describes the swarm, and end clears it', () => {
  const { call } = setup()
  assert.match(call('omnis_swarm_status').text, /No swarm is running/)
  call('omnis_swarm_init', { name: 'Status', topology: 'mesh' })
  call('omnis_task_create', { title: 'x' })
  const text = call('omnis_swarm_status').text
  assert.match(text, /Status \[status\] \(mesh\)/)
  assert.match(text, /Tasks: 1 pending/)
  call('omnis_swarm_end', { outcome: 'done' })
  assert.match(call('omnis_swarm_status').text, /No swarm is running/)
  assert.throws(() => call('omnis_swarm_end'), InputError)
})
```

- [ ] **Step 2: Run the test to see it fail**

Run: `node --test tests/mcp/tools.test.ts`
Expected: FAIL. `Cannot find module` for `tools.ts` / `validate.ts`.

- [ ] **Step 3: Write `src/mcp/validate.ts`**

```ts
/** Input checks at the MCP boundary. A failure throws InputError, which the protocol turns into an error result. */
import type { Args } from './protocol.ts'

export class InputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InputError'
  }
}

export function reqString(args: Args, key: string, max: number, pattern?: RegExp): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw new InputError(`${key} must be a non-empty string of at most ${max} characters`)
  }
  if (pattern !== undefined && !pattern.test(value)) throw new InputError(`${key} contains characters that aren't allowed`)
  return value
}

export function optString(args: Args, key: string, max: number, pattern?: RegExp): string | undefined {
  return args[key] === undefined || args[key] === null ? undefined : reqString(args, key, max, pattern)
}

export function reqEnum<T extends string>(args: Args, key: string, values: readonly T[]): T {
  const value = args[key]
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
    throw new InputError(`${key} must be one of: ${values.join(', ')}`)
  }
  return value as T
}

export function optStringList(args: Args, key: string, maxItems: number, maxLen: number, pattern?: RegExp): string[] | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length > maxItems) throw new InputError(`${key} must be a list of at most ${maxItems} items`)
  for (const item of value) {
    if (typeof item !== 'string' || item === '' || item.length > maxLen || (pattern !== undefined && !pattern.test(item))) {
      throw new InputError(`${key} has an item that isn't allowed`)
    }
  }
  return value as string[]
}
```

- [ ] **Step 4: Write `src/mcp/tools.ts`**

```ts
/** The omnis_* MCP tools. Each validates its input, appends events and reads folded state. */
import { TASK_STATES, TOPOLOGIES, clip, isSafeKey, makeEvent, type SwarmEvent } from '../core/events.ts'
import { appendEvent, clearCurrent, readCurrent, writeCurrent } from '../core/log.ts'
import { loadState } from '../core/snapshot.ts'
import { agentStats, swarmTotals } from '../core/stats.ts'
import { ensureSwarm, uniqueSwarmId } from '../core/swarm.ts'
import type { SwarmState } from '../core/fold.ts'
import { MAX_VALUE_BYTES, putMemory, readMemory } from './memory-store.ts'
import type { ToolDef } from './protocol.ts'
import { InputError, optString, optStringList, reqEnum, reqString } from './validate.ts'

export type ToolContext = { root: string; now?: () => Date }

const KEY = /^[A-Za-z0-9._/-]{1,128}$/
const NAME = /^[A-Za-z0-9._-]{1,64}$/
const TASK_ID = /^t[0-9]{1,6}$/

const usd = (x: number | null): string => (x === null ? '–' : `≈$${x.toFixed(x < 1 ? 3 : 2)}`)
const int = (n: number): string => Math.round(n).toLocaleString('en-GB')
const stamp = (d: Date): string => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)

function statusText(state: SwarmState, nowMs: number): string {
  const t = swarmTotals(state, nowMs)
  const s = state.swarm
  const lines = [
    `Swarm ${s.name} [${s.id}] (${s.topology})${s.endedAt !== null ? ' · ended' : ''} · ${t.agents} agents · ` +
      `${t.running} running · ${int(t.tokens)} tokens · ${usd(t.costUsd)}${t.costPartial ? ' (some models unpriced)' : ''}`,
  ]
  for (const id of Object.keys(state.agents)) {
    const a = agentStats(state, id, nowMs)
    if (a === null || a.placeholder) continue
    lines.push(`- ${a.name} [${a.role}] ${a.status} · ${int(a.tokens.total)} tokens · ${usd(a.costUsd)}${a.stuck ? ' · stuck' : ''}`)
  }
  lines.push(`Tasks: ${TASK_STATES.map(k => `${t.tasks[k]} ${k}`).join(', ')}`)
  lines.push(`Memory: ${Object.keys(state.memory).length} keys`)
  if (t.clashes > 0) lines.push(`File clashes: ${t.clashes}`)
  return lines.join('\n')
}

export function createTools(ctx: ToolContext): ToolDef[] {
  const root = ctx.root
  const clock = ctx.now ?? (() => new Date())

  const emit = (event: SwarmEvent): void => {
    if (!appendEvent(root, event)) throw new Error('Could not write to the swarm log in .omnis-swarm/')
  }
  const swarmOrCreate = (now: Date): string => ensureSwarm(root, { idHint: `session-${stamp(now)}`, src: 'mcp', now })
  const runningSwarm = (): string => {
    const id = readCurrent(root)
    if (id === null) throw new InputError('No swarm is running. Call omnis_swarm_init first.')
    return id
  }
  const memoryKey = (args: Record<string, unknown>): string => {
    const key = reqString(args, 'key', 128, KEY)
    if (!isSafeKey(key)) throw new InputError('key is reserved')
    return key
  }

  return [
    {
      name: 'omnis_swarm_init',
      description: 'Start a named swarm with a topology, so the OmnisSwarm pane groups and lays out the agents you spawn. If agents are already running in an unnamed session swarm, this names that swarm instead of starting another.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', maxLength: 64, description: 'Human name, e.g. "auth refactor".' },
          topology: { type: 'string', enum: [...TOPOLOGIES], description: 'hierarchical: a lead with workers. mesh: peers talk to each other. star: everything goes through one hub.' },
          goal: { type: 'string', maxLength: 200, description: 'One line on what the swarm is for.' },
        },
        required: ['name', 'topology'],
        additionalProperties: false,
      },
      handler: args => {
        const name = reqString(args, 'name', 64)
        const topology = reqEnum(args, 'topology', TOPOLOGIES)
        const goal = optString(args, 'goal', 200)
        const now = clock()
        const data = { name, topology, ...(goal !== undefined && { goal }), implicit: false }
        const existing = readCurrent(root)
        if (existing !== null) {
          const { state } = loadState(root, existing)
          if (state.swarm.implicit && state.swarm.endedAt === null) {
            emit(makeEvent({ type: 'swarm.started', swarm: existing, src: 'mcp', data, now }))
            return { text: `Swarm "${name}" (${topology}) now names the running session swarm ${existing}.` }
          }
          if (state.swarm.endedAt === null) emit(makeEvent({ type: 'swarm.ended', swarm: existing, src: 'mcp', data: { outcome: 'replaced' }, now }))
        }
        const id = uniqueSwarmId(root, name)
        writeCurrent(root, id)
        emit(makeEvent({ type: 'swarm.started', swarm: id, src: 'mcp', data, now }))
        return { text: `Swarm "${name}" started as ${id} (${topology}).` }
      },
    },
    {
      name: 'omnis_swarm_end',
      description: 'End the running swarm. Its log stays on disk; the next agent or omnis_swarm_init starts a new one.',
      inputSchema: {
        type: 'object',
        properties: { outcome: { type: 'string', maxLength: 200, description: 'How it went, in a few words.' } },
        additionalProperties: false,
      },
      handler: args => {
        const id = runningSwarm()
        const outcome = optString(args, 'outcome', 200)
        emit(makeEvent({ type: 'swarm.ended', swarm: id, src: 'mcp', data: outcome === undefined ? {} : { outcome }, now: clock() }))
        clearCurrent(root)
        return { text: `Swarm ${id} ended.` }
      },
    },
    {
      name: 'omnis_swarm_status',
      description: 'Summarise the running swarm: agents with status, tokens and approximate cost, task counts and memory keys.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: () => {
        const id = readCurrent(root)
        if (id === null) return { text: 'No swarm is running.' }
        return { text: statusText(loadState(root, id).state, clock().getTime()) }
      },
    },
    {
      name: 'omnis_memory_put',
      description: `Store a value (up to ${MAX_VALUE_BYTES} bytes) under a key in the swarm's shared memory, so other agents can read it with omnis_memory_get.`,
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', pattern: KEY.source, description: 'e.g. "design/auth".' },
          value: { type: 'string', description: `At most ${MAX_VALUE_BYTES} bytes.` },
          agent: { type: 'string', pattern: NAME.source, description: 'Your agent name, so the pane shows who wrote it.' },
        },
        required: ['key', 'value'],
        additionalProperties: false,
      },
      handler: args => {
        const key = memoryKey(args)
        const value = reqString(args, 'value', MAX_VALUE_BYTES)
        const bytes = Buffer.byteLength(value)
        if (bytes > MAX_VALUE_BYTES) throw new InputError(`value is ${bytes} bytes; the limit is ${MAX_VALUE_BYTES}`)
        const writer = optString(args, 'agent', 64, NAME) ?? 'lead'
        const now = clock()
        const swarm = swarmOrCreate(now)
        putMemory(root, swarm, key, value, writer, now)
        emit(makeEvent({ type: 'memory.put', swarm, src: 'mcp', agent: writer, data: { key, bytes, preview: clip(value, 80) }, now }))
        return { text: `Stored ${key} (${bytes} bytes).` }
      },
    },
    {
      name: 'omnis_memory_get',
      description: "Read a value from the swarm's shared memory.",
      inputSchema: {
        type: 'object',
        properties: { key: { type: 'string', pattern: KEY.source } },
        required: ['key'],
        additionalProperties: false,
      },
      handler: args => {
        const key = memoryKey(args)
        const entry = readMemory(root, runningSwarm())[key]
        return { text: entry === undefined ? `No value for ${key}.` : entry.value }
      },
    },
    {
      name: 'omnis_memory_list',
      description: "List keys in the swarm's shared memory with who wrote them and when.",
      inputSchema: {
        type: 'object',
        properties: { prefix: { type: 'string', maxLength: 128, description: 'Only keys starting with this.' } },
        additionalProperties: false,
      },
      handler: args => {
        const prefix = optString(args, 'prefix', 128) ?? ''
        const all = readMemory(root, runningSwarm())
        const keys = Object.keys(all).filter(k => k.startsWith(prefix)).sort()
        if (keys.length === 0) return { text: 'No keys stored.' }
        return { text: keys.map(k => `${k} · ${all[k]!.writer} · ${all[k]!.at.slice(11, 19)}`).join('\n') }
      },
    },
    {
      name: 'omnis_task_create',
      description: 'Add a task to the swarm task board, optionally assigned to an agent. Returns its id (t1, t2, ...).',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', maxLength: 120 },
          assignee: { type: 'string', pattern: NAME.source, description: 'Agent name.' },
          dependsOn: { type: 'array', items: { type: 'string', pattern: TASK_ID.source }, maxItems: 20 },
        },
        required: ['title'],
        additionalProperties: false,
      },
      handler: args => {
        const title = reqString(args, 'title', 120)
        const assignee = optString(args, 'assignee', 64, NAME)
        const dependsOn = optStringList(args, 'dependsOn', 20, 8, TASK_ID)
        const now = clock()
        const swarm = swarmOrCreate(now)
        const { state } = loadState(root, swarm)
        let n = Object.keys(state.tasks).length + 1
        while (Object.hasOwn(state.tasks, `t${n}`)) n++
        const id = `t${n}`
        emit(makeEvent({
          type: 'task.created', swarm, src: 'mcp', now,
          data: { id, title, ...(assignee !== undefined && { assignee }), ...(dependsOn !== undefined && { dependsOn }) },
        }))
        return { text: `Created task ${id}.` }
      },
    },
    {
      name: 'omnis_task_update',
      description: 'Change a task\'s state (pending, active, done, failed), assignee or note.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', pattern: TASK_ID.source },
          state: { type: 'string', enum: [...TASK_STATES] },
          assignee: { type: 'string', pattern: NAME.source },
          note: { type: 'string', maxLength: 200 },
        },
        required: ['id', 'state'],
        additionalProperties: false,
      },
      handler: args => {
        const id = reqString(args, 'id', 8, TASK_ID)
        const taskState = reqEnum(args, 'state', TASK_STATES)
        const assignee = optString(args, 'assignee', 64, NAME)
        const note = optString(args, 'note', 200)
        const swarm = runningSwarm()
        if (!Object.hasOwn(loadState(root, swarm).state.tasks, id)) throw new InputError(`No task ${id} in swarm ${swarm}.`)
        emit(makeEvent({
          type: 'task.updated', swarm, src: 'mcp', now: clock(),
          data: { id, state: taskState, ...(assignee !== undefined && { assignee }), ...(note !== undefined && { note }) },
        }))
        return { text: `Task ${id} is now ${taskState}.` }
      },
    },
  ]
}
```

- [ ] **Step 5: Run the gate**

Run: `npm run check`
Expected: no type errors. All 8 tools tests pass, along with everything before them.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/validate.ts src/mcp/tools.ts tests/mcp/tools.test.ts
git commit -m "Add the omnis swarm, memory and task tools"
```

---

### Task 11: Server entry point, plugin packaging and end-to-end test

**Files:**
- Create: `src/mcp/server.ts`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `tests/e2e/mcp-server.test.ts`

**Interfaces:**
- Consumes: `createTools` (tools.ts), `runStdio` (protocol.ts)
- Produces: an installable plugin whose MCP server is `omnis-swarm`. Project root comes from `OMNIS_SWARM_ROOT`, then `CLAUDE_PROJECT_DIR`, then the working directory. If the Task 5 spike found different environment variables, use those instead and note it in the commit.

- [ ] **Step 1: Write the failing test**

Create `tests/e2e/mcp-server.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { tmpRoot } from '../helpers.ts'

const SERVER = fileURLToPath(new URL('../../src/mcp/server.ts', import.meta.url))

test('the server speaks MCP over stdio and writes the swarm log', async () => {
  const root = tmpRoot()
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, OMNIS_SWARM_ROOT: root }, stdio: ['pipe', 'pipe', 'inherit'] })
  const waiting = new Map<number, (reply: any) => void>()
  createInterface({ input: child.stdout }).on('line', line => {
    const reply = JSON.parse(line)
    waiting.get(reply.id)?.(reply)
    waiting.delete(reply.id)
  })
  const call = (id: number, method: string, params: unknown = {}) =>
    new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no reply to ${method}`)), 10_000)
      waiting.set(id, reply => {
        clearTimeout(timer)
        resolve(reply)
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })

  try {
    const init = await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
    assert.equal(init.result.serverInfo.name, 'omnis-swarm')
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

    const list = await call(2, 'tools/list')
    assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name).sort(), [
      'omnis_memory_get', 'omnis_memory_list', 'omnis_memory_put', 'omnis_swarm_end',
      'omnis_swarm_init', 'omnis_swarm_status', 'omnis_task_create', 'omnis_task_update',
    ])

    const started = await call(3, 'tools/call', { name: 'omnis_swarm_init', arguments: { name: 'E2E run', topology: 'mesh' } })
    assert.equal(started.result.isError, false)
    assert.ok(existsSync(join(root, '.omnis-swarm', 'swarms', 'e2e-run.jsonl')))

    const bad = await call(4, 'tools/call', { name: 'omnis_swarm_init', arguments: { name: 'x', topology: 'ring' } })
    assert.equal(bad.result.isError, true)
    assert.match(bad.result.content[0].text, /topology must be one of/)
  } finally {
    child.kill()
  }
})
```

- [ ] **Step 2: Run the test to see it fail**

Run: `node --test tests/e2e/mcp-server.test.ts`
Expected: FAIL. `no reply to initialize` (the child exits because `src/mcp/server.ts` doesn't exist).

- [ ] **Step 3: Write `src/mcp/server.ts`**

```ts
/** OmnisSwarm MCP server: `node src/mcp/server.ts`. Logs only to stderr; stdout carries the protocol. */
import { runStdio } from './protocol.ts'
import { createTools } from './tools.ts'

const root = process.env.OMNIS_SWARM_ROOT ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd()

void runStdio(createTools({ root }), { name: 'omnis-swarm', version: '0.1.0' })
```

- [ ] **Step 4: Run the e2e test**

Run: `node --test tests/e2e/mcp-server.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the plugin manifest and marketplace**

Create `.claude-plugin/plugin.json`:

```json
{
  "name": "omnis-swarm",
  "version": "0.1.0",
  "description": "Swarm coordination for Claude Code agents: topology, shared memory and a task board, recorded to an event log for a live read-only swarm pane.",
  "author": { "name": "Fortitude Omnis" },
  "license": "UNLICENSED",
  "mcpServers": {
    "omnis-swarm": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/src/mcp/server.ts"]
    }
  }
}
```

Create `.claude-plugin/marketplace.json`:

```json
{
  "name": "omnis-swarm",
  "owner": { "name": "Fortitude Omnis" },
  "plugins": [
    {
      "name": "omnis-swarm",
      "source": "./",
      "description": "Swarm coordination and a live read-only swarm pane for Claude Code."
    }
  ]
}
```

Run: `claude plugin validate .`
Expected: the manifest and marketplace validate with no errors. If the CLI reports a schema problem, fix exactly what it names. If `claude plugin validate` doesn't exist in this Claude Code version, run `claude --plugin-dir . mcp list` instead and confirm `omnis-swarm` is listed as connected.

- [ ] **Step 6: Run the full gate**

Run: `npm run check`
Expected: no type errors. Every test passes (about 75 across `tests/core`, `tests/mcp` and `tests/e2e`).

- [ ] **Step 7: Commit**

```bash
git add src/mcp/server.ts .claude-plugin/plugin.json .claude-plugin/marketplace.json tests/e2e/mcp-server.test.ts
git commit -m "Package OmnisSwarm as a Claude Code plugin with its MCP server"
```

---

## After this plan

- Create the remote: `gh auth switch --user fortitude-omnis`, then `gh repo create Fortitude-Group/OmnisSwarm --private --source . --remote origin --push`.
- Write the phase 2 plan (recorder + transcript reader) and the phase 3 plan (pane), both from `docs/spikes/2026-10-21-mod-api.md`. They can be written and built in parallel.
