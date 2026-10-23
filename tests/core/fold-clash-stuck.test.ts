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

test('a repeating agent.stuck holds while the subject repeats and re-arms on another subject or an edit that goes ahead', () => {
  const s = foldAll('s1', [started('a1', 'coder-1'), ev('agent.stuck', { pattern: 'repeating', count: 4, subject: 'src/a.ts', delivered: false, reason: 'gone' }, { agent: 'a1', atSec: 10 })])
  assert.equal(s.feed.at(-1)!.text, 'coder-1 looks stuck (repeating), asked to step back (not delivered)')
  fold(s, tool('a1', 'start', 'Read', 'read', 'src/a.ts', false, 11))
  assert.equal(s.agents.a1!.stuckBy!.on, true)
  fold(s, tool('a1', 'start', 'Read', 'read', 'src/b.ts', false, 12))
  assert.equal(s.agents.a1!.stuckBy!.on, false)
  fold(s, ev('agent.stuck', { pattern: 'failing', count: 5, subject: 'npm test', delivered: true }, { agent: 'a1', atSec: 13 }))
  assert.deepEqual(s.agents.a1!.stuckBy, { on: true, p: 'failing', s: 'npm test', n: 2 })
  fold(s, edit('a1', 'src/b.ts', 14))
  assert.equal(s.agents.a1!.stuckBy!.on, true)
  fold(s, tool('a1', 'end', 'Edit', 'edit', 'src/b.ts', false, 14))
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

const done = (id: string, path: string, atSec: number) => tool(id, 'end', 'Edit', 'edit', path, false, atSec)
const refused = (id: string, path: string, atSec: number, noted: boolean) => [
  tool(id, 'start', 'Edit', 'edit', path, false, atSec),
  ...(noted ? [ev('clash.blocked', { path, holder: 'a1', mode: 'block' }, { agent: id, atSec })] : []),
  tool(id, 'end', 'Edit', 'edit', path, true, atSec),
]

test('refused retries leave no entries of their own: the holder and one blocked entry remain', () => {
  const s = foldAll('s1', [
    started('a1', 'coder-1'), started('a2', 'coder-2'), edit('a1', 'src/x.ts', 1), done('a1', 'src/x.ts', 1),
    ...refused('a2', 'src/x.ts', 2, true), ...refused('a2', 'src/x.ts', 3, false), ...refused('a2', 'src/x.ts', 4, false), ...refused('a2', 'src/x.ts', 5, false),
  ])
  assert.deepEqual(s.edits['src/x.ts'], [{ agent: 'a1', at: at(1) }, { agent: 'a2', at: at(2), blocked: true }])
})

test('a dozen quick refused retries do not trim the holder out, so the clash stays', () => {
  const events = [started('a1', 'coder-1'), started('a2', 'coder-2'), edit('a1', 'src/x.ts', 1), done('a1', 'src/x.ts', 1), ...refused('a2', 'src/x.ts', 2, true)]
  for (let i = 0; i < 12; i++) events.push(...refused('a2', 'src/x.ts', 3 + i, false))
  const s = foldAll('s1', events)
  assert.deepEqual(s.edits['src/x.ts']![0], { agent: 'a1', at: at(1) })
  assert.deepEqual(fileClashes(s), [{ path: 'src/x.ts', agents: ['a1', 'a2'], blocked: true }])
})

test('a clash.blocked that lands after the failed end still leaves one blocked entry', () => {
  const s = foldAll('s1', [
    started('a1', 'coder-1'), started('a2', 'coder-2'), edit('a1', 'src/x.ts', 1),
    tool('a2', 'start', 'Edit', 'edit', 'src/x.ts', false, 2), tool('a2', 'end', 'Edit', 'edit', 'src/x.ts', true, 2),
    ev('clash.blocked', { path: 'src/x.ts', holder: 'a1', mode: 'block' }, { agent: 'a2', atSec: 2 }),
  ])
  assert.deepEqual(s.edits['src/x.ts'], [{ agent: 'a1', at: at(1) }, { agent: 'a2', at: at(2), blocked: true }])
})

test('a plain failed edit with no clash leaves no entry', () => {
  const s = foldAll('s1', [started('a1', 'coder-1'), tool('a1', 'start', 'Edit', 'edit', 'src/x.ts', false, 1), tool('a1', 'end', 'Edit', 'edit', 'src/x.ts', true, 1)])
  assert.equal(s.edits['src/x.ts'], undefined)
  assert.ok(isSwarmState(roundTrip(s), 's1'))
})

test('the holder editing again after a refusal keeps the clash blocked', () => {
  const s = foldAll('s1', [
    started('a1', 'coder-1'), started('a2', 'coder-2'), edit('a1', 'src/x.ts', 1), ...refused('a2', 'src/x.ts', 2, true), edit('a1', 'src/x.ts', 3), done('a1', 'src/x.ts', 3),
  ])
  assert.deepEqual(fileClashes(s), [{ path: 'src/x.ts', agents: ['a1', 'a2'], blocked: true }])
})

test('only an edit that goes ahead re-arms the stuck look: a refused edit does not', () => {
  const s = foldAll('s1', [started('a1', 'coder-1'), ev('agent.stuck', { pattern: 'failing', count: 5, subject: 'src/x.ts', delivered: true }, { agent: 'a1', atSec: 10 })])
  fold(s, tool('a1', 'start', 'Edit', 'edit', 'src/x.ts', false, 11))
  assert.equal(s.agents.a1!.stuckBy!.on, true)
  fold(s, tool('a1', 'end', 'Edit', 'edit', 'src/x.ts', true, 11))
  assert.equal(s.agents.a1!.stuckBy!.on, true)
  fold(s, ev('agent.stuck', { pattern: 'repeating', count: 4, subject: 'npm test', delivered: true }, { agent: 'a1', atSec: 12 }))
  fold(s, tool('a1', 'start', 'Edit', 'edit', 'src/x.ts', false, 13))
  assert.equal(s.agents.a1!.stuckBy!.on, true)
  fold(s, tool('a1', 'end', 'Edit', 'edit', 'src/x.ts', false, 13))
  assert.equal(s.agents.a1!.stuckBy!.on, false)
})
