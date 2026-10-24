import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldAll, LEAD } from '../../src/core/fold.ts'
import { isSwarmState } from '../../src/core/state-check.ts'
import type { GateResult } from '../../src/core/events.ts'
import { ev } from '../helpers.ts'

const roundTrip = (s: unknown) => JSON.parse(JSON.stringify(s))
const started = (id: string, name: string) => ev('agent.started', { name, role: 'coder', description: '', parent: LEAD }, { agent: id, atSec: 0 })
const created = (extra = {}) => ev('task.created', { id: 't1', title: 'Do it', assignee: 'bob', ...extra }, { src: 'mcp', atSec: 1 })
const gate = (result: GateResult, atSec: number, extra = {}) =>
  ev('gate.ran', { task: 't1', result, ms: 42_400, mode: 'block', ...extra }, { src: 'mcp', atSec })

test('a task starts with no owns, no worktree and no gate', () => {
  const s = foldAll('s1', [created()])
  const t = s.tasks.t1!
  assert.deepEqual(t.owns, [])
  assert.equal(t.worktree, null)
  assert.equal(t.gate, null)
  assert.ok(isSwarmState(roundTrip(s), 's1'))
})

test('task.created carries owns and worktree; task.updated replaces owns, and an empty list clears it', () => {
  const s = foldAll('s1', [
    created({ owns: ['src/**', 'docs/'], worktree: 'C:/repo/wt/a' }),
    ev('task.updated', { id: 't1', state: 'active', owns: ['tests/*.ts'] }, { src: 'mcp', atSec: 2 }),
  ])
  assert.deepEqual(s.tasks.t1!.owns, ['tests/*.ts'])
  assert.equal(s.tasks.t1!.worktree, 'C:/repo/wt/a')
  const cleared = foldAll('s1', [created({ owns: ['src/**'] }), ev('task.updated', { id: 't1', state: 'active', owns: [] }, { src: 'mcp', atSec: 2 })])
  assert.deepEqual(cleared.tasks.t1!.owns, [])
  const kept = foldAll('s1', [created({ owns: ['src/**'] }), ev('task.updated', { id: 't1', state: 'active' }, { src: 'mcp', atSec: 2 })])
  assert.deepEqual(kept.tasks.t1!.owns, ['src/**'])
  const moved = foldAll('s1', [created({ worktree: 'C:/a' }), ev('task.updated', { id: 't1', state: 'active', worktree: 'C:/b' }, { src: 'mcp', atSec: 2 })])
  assert.equal(moved.tasks.t1!.worktree, 'C:/b')
})

test('bad owns and worktree values are ignored, and good ones are capped', () => {
  const many = Array.from({ length: 30 }, (_, i) => `f${i}/`)
  const s = foldAll('s1', [created({ owns: [...many, 5, '', '\u001b[31m'] as never, worktree: 7 as never })])
  assert.equal(s.tasks.t1!.owns.length, 20)
  assert.equal(s.tasks.t1!.worktree, null)
  const bad = foldAll('s1', [created({ owns: ['a/'] }), ev('task.updated', { id: 't1', state: 'active', owns: 'src/**' as never }, { src: 'mcp', atSec: 2 })])
  assert.deepEqual(bad.tasks.t1!.owns, ['a/'])
  assert.ok(isSwarmState(roundTrip(s), 's1'))
})

test('gate.ran counts runs, keeps the last five results oldest first, and feeds the pane', () => {
  const results: GateResult[] = ['failed', 'failed', 'failed', 'passed', 'failed', 'timeout', 'passed']
  const s = foldAll('s1', [created(), ...results.map((r, i) => gate(r, 2 + i))])
  const g = s.tasks.t1!.gate!
  assert.equal(g.runs, 7)
  assert.equal(g.result, 'passed')
  assert.deepEqual(g.history, ['failed', 'passed', 'failed', 'timeout', 'passed'])
  assert.equal(g.at, Date.parse('2026-10-21T10:00:08.000Z'))
  assert.ok(isSwarmState(roundTrip(s), 's1'))
})

test('gate feed lines', () => {
  const lines = (...e: ReturnType<typeof gate>[]) => foldAll('s1', [created(), ...e]).feed.at(-1)!
  assert.equal(lines(gate('passed', 2)).text, 'task t1 gate ✓ 42s')
  assert.equal(lines(gate('failed', 2, { exit: 1 })).text, 'task t1 gate ✕ exit 1')
  assert.equal(lines(gate('timeout', 2)).text, 'task t1 gate ✕ timed out')
  assert.equal(lines(gate('error', 2)).text, 'task t1 gate ✕ could not start')
  assert.equal(lines(gate('skipped', 2)).text, 'task t1 gate skipped')
  assert.equal(lines(gate('none', 2)).text, 'task t1 no gate')
  assert.equal(lines(gate('passed', 2)).kind, 'task')
  assert.equal(lines(gate('passed', 2)).agent, LEAD)
})

test('gate.ran for an unknown task or with a bad result is skipped', () => {
  const s = foldAll('s1', [
    created(),
    ev('gate.ran', { task: 't9', result: 'passed', ms: 1, mode: 'block' }, { src: 'mcp', atSec: 2 }),
    ev('gate.ran', { task: 't1', result: 'maybe' as never, ms: 1, mode: 'block' }, { src: 'mcp', atSec: 3 }),
  ])
  assert.equal(s.tasks.t1!.gate, null)
  assert.equal(s.tasks.t9, undefined)
  assert.equal(s.feed.length, 1)
})

test('fence.blocked counts on the agent and feeds a block or a warn line', () => {
  const s = foldAll('s1', [
    started('a1', 'coder-1'),
    ev('fence.blocked', { path: 'src/x.ts', tasks: ['t1'], mode: 'block' }, { agent: 'a1', atSec: 2 }),
    ev('fence.blocked', { path: 'src/y.ts', tasks: ['t1'], mode: 'warn' }, { agent: 'a1', atSec: 3 }),
  ])
  assert.equal(s.agents.a1!.fenceBlocks, 2)
  assert.deepEqual(s.feed.slice(-2).map(f => [f.kind, f.text]), [['task', 'fence: coder-1 ✕ src/x.ts'], ['task', 'fence: coder-1 ! src/y.ts']])
  assert.ok(isSwarmState(roundTrip(s), 's1'))
})

test('an agent never fenced has no fenceBlocks key; a bad fence.blocked is skipped', () => {
  const s = foldAll('s1', [
    started('a1', 'coder-1'),
    ev('fence.blocked', { path: '', tasks: [], mode: 'block' }, { agent: 'a1', atSec: 2 }),
    ev('fence.blocked', { path: 'x', tasks: [], mode: 'off' as never }, { agent: 'a1', atSec: 3 }),
  ])
  assert.equal(Object.hasOwn(s.agents.a1!, 'fenceBlocks'), false)
  assert.ok(isSwarmState(roundTrip(s), 's1'))
})

test('an old log with none of the new fields still folds to a valid state', () => {
  const s = foldAll('s1', [
    created(),
    ev('task.updated', { id: 't1', state: 'done', note: 'merged' }, { src: 'mcp', atSec: 2 }),
  ])
  assert.deepEqual(s.tasks.t1, {
    id: 't1', title: 'Do it', state: 'done', assignee: 'bob', dependsOn: [], createdAt: Date.parse('2026-10-21T10:00:01.000Z'),
    updatedAt: Date.parse('2026-10-21T10:00:02.000Z'), note: 'merged', owns: [], worktree: null, gate: null,
  })
  assert.ok(isSwarmState(roundTrip(s), 's1'))
})

test('a snapshot from before these fields is not trusted, so the log is replayed instead', () => {
  const old = roundTrip(foldAll('s1', [created()]))
  delete old.tasks.t1.owns
  delete old.tasks.t1.worktree
  delete old.tasks.t1.gate
  assert.equal(isSwarmState(old, 's1'), false)
})

test('a malformed gate record in a snapshot is rejected', () => {
  const good = roundTrip(foldAll('s1', [created(), gate('passed', 2)]))
  assert.ok(isSwarmState(good, 's1'))
  const bads = [
    (x: any) => { x.tasks.t1.gate.result = 'nope' },
    (x: any) => { x.tasks.t1.gate.history = ['passed', 'x'] },
    (x: any) => { x.tasks.t1.gate.history = Array(6).fill('passed') },
    (x: any) => { x.tasks.t1.gate.extra = 1 },
    (x: any) => { x.tasks.t1.owns = Array(21).fill('a/') },
    (x: any) => { x.tasks.t1.owns = [5] },
    (x: any) => { x.tasks.t1.worktree = 5 },
  ]
  for (const mutate of bads) {
    const x = roundTrip(good)
    mutate(x)
    assert.equal(isSwarmState(x, 's1'), false)
  }
})
