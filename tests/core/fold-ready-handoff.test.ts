import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldAll, LEAD } from '../../src/core/fold.ts'
import { isSwarmState } from '../../src/core/state-check.ts'
import { EVENT_TYPES, HANDOFF_WHY, parseLine, serialise } from '../../src/core/events.ts'
import { ev } from '../helpers.ts'

const roundTrip = (s: unknown) => JSON.parse(JSON.stringify(s))
const started = (id: string, name: string) => ev('agent.started', { name, role: 'coder', description: '', parent: LEAD }, { agent: id, atSec: 0 })
const created = (extra = {}, id = 't1', atSec = 1) => ev('task.created', { id, title: 'Do it', ...extra }, { src: 'mcp', atSec })
const PIN = 'a'.repeat(64)

const end = (agent: string, sec: number, tool: string, subject: string, extra: { isError?: boolean; error?: string } = {}) =>
  ev('agent.tool', { phase: 'end', tool, kind: 'bash', subject, isError: extra.isError === true, ...(extra.error !== undefined && { error: extra.error }) }, { agent, atSec: sec })

test('events: task.handoff is a known type with three reasons', () => {
  assert.ok(EVENT_TYPES.includes('task.handoff'))
  assert.deepEqual(HANDOFF_WHY, ['stuck', 'finished', 'lead'])
  const line = serialise(ev('task.handoff', { task: 't1', agent: 'a1', why: 'stuck' }, { src: 'mcp' }))
  assert.equal(parseLine(line).ok, true)
})

test('trail keeps the last 8 ended calls, oldest first', () => {
  const log = [started('a1', 'dev'), ...Array.from({ length: 11 }, (_, i) => end('a1', i + 1, 'Bash', `cmd ${i}`, { isError: i === 10 }))]
  const a = foldAll('s1', log).agents.a1!
  assert.equal(a.trail!.length, 8)
  assert.deepEqual(a.trail![0], { tool: 'Bash', subject: 'cmd 3', ok: true })
  assert.deepEqual(a.trail![7], { tool: 'Bash', subject: 'cmd 10', ok: false })
})

test('errs keeps the last 3 failures; a failure with no error text has text ""', () => {
  const log = [
    started('a1', 'dev'),
    end('a1', 1, 'Bash', 'one', { isError: true, error: 'first' }),
    end('a1', 2, 'Bash', 'two', { isError: true }),
    end('a1', 3, 'Read', 'three', { isError: true, error: 'third\u001b[31m  text' }),
    end('a1', 4, 'Bash', 'four', { isError: true, error: 'x'.repeat(300) }),
  ]
  const s = foldAll('s1', log)
  const errs = s.agents.a1!.errs!
  assert.equal(errs.length, 3)
  assert.deepEqual(errs[0], { tool: 'Bash', subject: 'two', text: '', at: Date.parse('2026-10-21T10:00:02.000Z') })
  assert.equal(errs[1]!.text, 'third [31m text')
  assert.equal(errs[2]!.text.length, 160)
  assert.ok(isSwarmState(roundTrip(s), 's1'))
})

test('an agent with no ended call has neither list; a call that only started adds nothing', () => {
  const s = foldAll('s1', [started('a1', 'dev'), ev('agent.tool', { phase: 'start', tool: 'Bash', kind: 'bash', subject: 'x', isError: false }, { agent: 'a1', atSec: 1 })])
  assert.equal(Object.hasOwn(s.agents.a1!, 'trail'), false)
  assert.equal(Object.hasOwn(s.agents.a1!, 'errs'), false)
  assert.ok(isSwarmState(roundTrip(s), 's1'))
})

test('a successful end adds to the trail only', () => {
  const s = foldAll('s1', [started('a1', 'dev'), end('a1', 1, 'Bash', 'ok')])
  assert.deepEqual(s.agents.a1!.trail, [{ tool: 'Bash', subject: 'ok', ok: true }])
  assert.equal(Object.hasOwn(s.agents.a1!, 'errs'), false)
})

test('task.created is first-wins for an id: a second line changes nothing and adds no feed line', () => {
  const s = foldAll('s1', [
    created({ gatePin: PIN, assignee: 'bob' }),
    ev('task.updated', { id: 't1', state: 'active' }, { src: 'mcp', atSec: 2 }),
    created({ title: 'x', assignee: 'eve' }, 't1', 3),
  ])
  const t = s.tasks.t1!
  assert.equal(t.title, 'Do it')
  assert.equal(t.assignee, 'bob')
  assert.equal(t.state, 'active')
  assert.equal(t.gatePin, PIN)
  assert.equal(s.feed.filter(f => f.text.startsWith('task t1 created')).length, 1)
})

test('gatePin: 64 lowercase hex is kept, anything else is null', () => {
  for (const bad of ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), '', 7 as never, null as never]) {
    assert.equal(foldAll('s1', [created({ gatePin: bad })]).tasks.t1!.gatePin, null, JSON.stringify(bad))
  }
  assert.equal(foldAll('s1', [created()]).tasks.t1!.gatePin, null)
  const s = foldAll('s1', [created({ gatePin: PIN })])
  assert.equal(s.tasks.t1!.gatePin, PIN)
  assert.ok(isSwarmState(roundTrip(s), 's1'))
})

test('task.updated replaces dependsOn when present, cleaned as on create, and leaves it when absent', () => {
  const log = [created({}, 't1'), created({}, 't2', 2), created({ dependsOn: ['t1'] }, 't3', 3)]
  const upd = (data: object, sec: number) => ev('task.updated', { id: 't3', state: 'pending', ...data } as never, { src: 'mcp', atSec: sec })
  assert.deepEqual(foldAll('s1', [...log, upd({ dependsOn: ['t2', 5, '', '__proto__'] }, 4)]).tasks.t3!.dependsOn, ['t2'])
  assert.deepEqual(foldAll('s1', [...log, upd({ dependsOn: [] }, 4)]).tasks.t3!.dependsOn, [])
  assert.deepEqual(foldAll('s1', [...log, upd({}, 4)]).tasks.t3!.dependsOn, ['t1'])
  assert.deepEqual(foldAll('s1', [...log, upd({ dependsOn: 'nope' }, 4)]).tasks.t3!.dependsOn, ['t1'])
  const many = Array.from({ length: 30 }, (_, i) => `t${i}`)
  assert.equal(foldAll('s1', [...log, upd({ dependsOn: many }, 4)]).tasks.t3!.dependsOn.length, 20)
})

test('closing a task feeds a ready line for each task it freed, and only then', () => {
  const log = [created({}, 't1'), created({ dependsOn: ['t1'] }, 't2', 2), created({ dependsOn: ['t1'] }, 't3', 3)]
  const done = ev('task.updated', { id: 't1', state: 'done' }, { src: 'mcp', atSec: 4 })
  const s = foldAll('s1', [...log, done])
  assert.deepEqual(s.feed.map(f => f.text).slice(-3), ['task t1 → done', 'task t2 ready', 'task t3 ready'])
  const again = foldAll('s1', [...log, done, ev('task.updated', { id: 't1', state: 'done' }, { src: 'mcp', atSec: 5 })])
  assert.equal(again.feed.filter(f => f.text.endsWith(' ready')).length, 2)
  const active = foldAll('s1', [...log, ev('task.updated', { id: 't1', state: 'active' }, { src: 'mcp', atSec: 4 })])
  assert.equal(active.feed.some(f => f.text.endsWith(' ready')), false)
})

test('task.handoff counts on the task and feeds a line with the agent name, or its id when unknown', () => {
  const log = [started('a1', 'dev-2'), created({ assignee: 'dev-2' })]
  const s = foldAll('s1', [...log, ev('task.handoff', { task: 't1', agent: 'a1', why: 'stuck' }, { src: 'mcp', atSec: 2 })])
  assert.equal(s.tasks.t1!.handoffs, 1)
  assert.equal(s.feed.at(-1)!.text, 'task t1 handoff note from dev-2')
  assert.equal(s.feed.at(-1)!.kind, 'task')
  const twice = foldAll('s1', [...log,
    ev('task.handoff', { task: 't1', agent: 'a1', why: 'lead' }, { src: 'mcp', atSec: 2 }),
    ev('task.handoff', { task: 't1', agent: 'zz9', why: 'finished' }, { src: 'mcp', atSec: 3 })])
  assert.equal(twice.tasks.t1!.handoffs, 2)
  assert.equal(twice.feed.at(-1)!.text, 'task t1 handoff note from zz9')
  assert.ok(isSwarmState(roundTrip(twice), 's1'))
  assert.equal(Object.hasOwn(foldAll('s1', log).tasks.t1!, 'handoffs'), false)
})

test('task.handoff for an unknown task, or with a bad reason, changes nothing', () => {
  const log = [created()]
  const before = foldAll('s1', log).feed.length
  assert.equal(foldAll('s1', [...log, ev('task.handoff', { task: 't9', agent: 'a1', why: 'stuck' }, { src: 'mcp', atSec: 2 })]).feed.length, before)
  const bad = foldAll('s1', [...log, ev('task.handoff', { task: 't1', agent: 'a1', why: 'because' as never }, { src: 'mcp', atSec: 2 })])
  assert.equal(bad.feed.length, before)
  assert.equal(Object.hasOwn(bad.tasks.t1!, 'handoffs'), false)
})

test('state-check rejects malformed new fields', () => {
  const s = roundTrip(foldAll('s1', [started('a1', 'dev'), end('a1', 1, 'Bash', 'x', { isError: true, error: 'e' }), created({ gatePin: PIN })]))
  assert.ok(isSwarmState(s, 's1'))
  const bad = (edit: (x: any) => void) => {
    const c = roundTrip(s)
    edit(c)
    return isSwarmState(c, 's1')
  }
  assert.equal(bad(x => { x.agents.a1.trail = new Array(9).fill({ tool: 't', subject: 's', ok: true }) }), false)
  assert.equal(bad(x => { x.agents.a1.errs[0].text = 5 }), false)
  assert.equal(bad(x => { x.agents.a1.errs[0].extra = 1 }), false)
  assert.equal(bad(x => { x.tasks.t1.gatePin = 'ABC' }), false)
  assert.equal(bad(x => { delete x.tasks.t1.gatePin }), false)
  assert.equal(bad(x => { x.tasks.t1.handoffs = 'many' }), false)
})
