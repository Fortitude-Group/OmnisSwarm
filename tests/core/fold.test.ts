import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emptyState, fold, foldAll, LEAD, MEMORY_KEY } from '../../src/core/fold.ts'
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
  assert.equal(Object.getPrototypeOf(s.memory), Object.prototype)
  assert.equal(({} as Record<string, unknown>).writer, undefined)
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

const U = { cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }

test('file names that match Object.prototype members fold without throwing', () => {
  const names = ['toString', 'valueOf', 'hasOwnProperty']
  const s = run([coder, ...names.map((n, i) => ev('agent.tool', { phase: 'start', tool: 'Edit', kind: 'edit', subject: n, isError: false }, { agent: 'a1', atSec: 2 + i }))])
  names.forEach((n, i) => assert.deepEqual(s.edits[n], [{ agent: 'a1', at: at(2 + i) }]))
})

test('a link to an agent named like a prototype member folds', () => {
  const s = run([coder, ev('message.sent', { to: 'toString', summary: 'x' }, { agent: 'a1', atSec: 2 }), ev('message.sent', { to: 'toString', summary: 'y' }, { agent: 'a1', atSec: 3 })])
  assert.equal(s.links['a1->?toString']!.count, 2)
})

test('an agent can never be its own parent', () => {
  const s = run([ev('agent.started', { name: 'lead', role: 'lead', description: '', parent: LEAD }, { atSec: 1 })])
  assert.equal(s.agents.lead!.parent, '')
  const t = run([ev('agent.started', { name: 'x', role: 'x', description: '', parent: 'a1' }, { agent: 'a1', atSec: 1 })])
  assert.equal(t.agents.a1!.parent, LEAD)
})

test('a far-future event does not empty the spend window', () => {
  const u = { model: 'claude-opus-5-5', input: 10, output: 10, ...U }
  const s = run([coder, ev('agent.usage', u, { agent: 'a1', atSec: 86_400 * 365 }), ev('agent.usage', u, { agent: 'a1', atSec: 5 })])
  assert.equal(s.spend.length, 2)
})

test('huge counts are capped so totals stay finite', () => {
  const s = run([coder, ev('agent.usage', { model: 'claude-opus-5-5', input: 1e308, output: 1e308, ...U }, { agent: 'a1', atSec: 2 })])
  assert.ok(Number.isFinite(s.agents.a1!.tokens.input))
  assert.ok(Number.isFinite(s.agents.a1!.costUsd))
})

test('an event with an unparseable timestamp is ignored', () => {
  const bad = { ...coder, ts: 'not a date' } as SwarmEvent
  const s = run([bad])
  assert.equal(s.events, 0)
  assert.deepEqual(s.agents, {})
})

test('memory keys outside the allowed set are skipped, not truncated', () => {
  assert.ok(MEMORY_KEY.test('design/auth'))
  const s = run([
    ev('memory.put', { key: 'k'.repeat(200), bytes: 1, preview: '' }, { atSec: 1, src: 'mcp' }),
    ev('memory.put', { key: 'bad key!', bytes: 1, preview: '' }, { atSec: 2, src: 'mcp' }),
  ])
  assert.deepEqual(s.memory, {})
})

test('text drops control characters and never splits a surrogate pair', () => {
  const s = run([
    ev('message.sent', { to: 'lead', summary: '\u001b[31mred' }, { agent: 'a1', atSec: 1 }),
    ev('message.sent', { to: 'lead', summary: '😀'.repeat(300) }, { agent: 'a1', atSec: 2 }),
  ])
  assert.equal(s.feed[0]!.text, '[31mred')
  assert.equal(s.feed[1]!.text, '😀'.repeat(200))
})
