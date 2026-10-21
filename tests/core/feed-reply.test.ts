import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseFeedReply } from '../../src/core/feed-reply.ts'
import { emptyState } from '../../src/core/fold.ts'
import { ev } from '../helpers.ts'

const started = () => ev('agent.started', { name: 'a', role: 'r', description: '', parent: 'lead' }, { agent: 'a1' })

test('none, state and events replies parse', () => {
  assert.deepEqual(parseFeedReply('{"v":1,"kind":"none"}'), { v: 1, kind: 'none' })
  const s = parseFeedReply(JSON.stringify({ v: 1, kind: 'state', swarm: 's1', offset: 10, state: emptyState('s1') }))
  assert.equal(s?.kind, 'state')
  const r = parseFeedReply(JSON.stringify({ v: 1, kind: 'events', swarm: 's1', offset: 99, events: [started()], bad: 0 }))
  assert.ok(r !== null && r.kind === 'events')
  assert.equal(r.events.length, 1)
  assert.equal(r.offset, 99)
})

test('malformed replies are refused', () => {
  const state = emptyState('s1')
  const e = started()
  for (const bad of [
    'not json',
    '[]',
    '{"v":2,"kind":"none"}',
    '{"v":1,"kind":"other","swarm":"s1","offset":0}',
    JSON.stringify({ v: 1, kind: 'state', swarm: 's1', offset: -1, state }),
    JSON.stringify({ v: 1, kind: 'state', swarm: 's2', offset: 0, state }),
    JSON.stringify({ v: 1, kind: 'state', swarm: 'nul', offset: 0, state: emptyState('nul') }),
    JSON.stringify({ v: 1, kind: 'state', swarm: 's1', offset: 0, state: { ...state, agents: [] } }),
    JSON.stringify({ v: 1, kind: 'events', swarm: 's1', offset: 1, events: [{ ...e, swarm: 's2' }], bad: 0 }),
    JSON.stringify({ v: 1, kind: 'events', swarm: 's1', offset: 1, events: [{ ...e, v: 9 }], bad: 0 }),
    JSON.stringify({ v: 1, kind: 'events', swarm: 's1', offset: 1, events: [], bad: 1.5 }),
    JSON.stringify({ v: 1, kind: 'events', swarm: 's1', offset: 1, events: new Array(501).fill(e), bad: 0 }),
  ]) assert.equal(parseFeedReply(bad), null, bad.slice(0, 60))
})
