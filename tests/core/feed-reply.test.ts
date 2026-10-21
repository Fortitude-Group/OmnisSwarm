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

// --- reply size cap ---
import { FEED_REPLY_MAX, fitEvents, freshReply } from '../../src/core/feed-reply.ts'
import { foldAll, type SwarmState } from '../../src/core/fold.ts'
import { isSwarmState } from '../../src/core/state-check.ts'

/** A state of `agents` agents, each with `files` files read, built by folding real events. */
function bigState(agents: number, files: number, finished = 0): SwarmState {
  const events = []
  for (let a = 0; a < agents; a++) {
    events.push(ev('agent.started', { name: `n${a}`, role: 'coder', description: 'd', parent: 'lead' }, { swarm: 'big', agent: `a${a}`, atSec: 1 }))
  }
  for (let a = 0; a < agents; a++) {
    const id = `a${a}`
    for (let f = 0; f < files; f++) {
      events.push(ev('agent.tool', { phase: 'start', tool: 'Read', kind: 'read', subject: `src/area${a}/module-${f}.ts`, isError: false }, { swarm: 'big', agent: id, atSec: 2 + f / 1000 }))
    }
    // Edits and messages that point at agents, so dropping an agent has links and edits to clean up.
    events.push(ev('agent.tool', { phase: 'start', tool: 'Edit', kind: 'edit', subject: `shared/file-${a % 5}.ts`, isError: false }, { swarm: 'big', agent: id, atSec: 5 }))
    events.push(ev('message.sent', { to: `n${(a + 1) % agents}`, summary: 'hi' }, { swarm: 'big', agent: id, atSec: 6 }))
  }
  for (let a = 0; a < finished; a++) events.push(ev('agent.finished', { outcome: 'answer' }, { swarm: 'big', agent: `a${a}`, atSec: 300 + a }))
  return foldAll('big', events)
}

test('a state that fits is sent untouched', () => {
  const state = emptyState('s1')
  const r = freshReply('s1', 5, state)
  assert.deepEqual(r, { v: 1, kind: 'state', swarm: 's1', offset: 5, state })
})

test('a large state is trimmed to fit, stays valid, and is marked trimmed', () => {
  const state = bigState(30, 200)
  assert.ok(JSON.stringify(state).length > FEED_REPLY_MAX)
  const before = JSON.stringify(state)
  const r = freshReply('big', 77, state)
  assert.ok(r.kind === 'state' && r.trimmed === true)
  const text = JSON.stringify(r)
  assert.ok(text.length <= FEED_REPLY_MAX, `${text.length}`)
  assert.ok(isSwarmState(r.state, 'big'))
  assert.equal(JSON.stringify(state), before, 'the held state is not changed')
  assert.equal(parseFeedReply(text)?.kind, 'state')
})

test('a state with too many agents is too-large', () => {
  const state = bigState(200, 200)
  const r = freshReply('big', 1, state)
  assert.deepEqual(r, { v: 1, kind: 'too-large', agents: 200 })
  assert.deepEqual(parseFeedReply(JSON.stringify(r)), r)
})

test('trimmed agents keep at most 20 files and 10 samples', () => {
  const r = freshReply('big', 1, bigState(30, 200))
  assert.ok(r.kind === 'state' && isSwarmState(r.state, 'big'))
  assert.ok(Object.values(r.state.agents).every(a => a.files.length <= 20 && a.samples.length <= 10))
})

test('fitEvents keeps whole events under the budget, at least one', () => {
  const big = Array.from({ length: 400 }, (_, i) =>
    ev('message.sent', { to: 'x', summary: 'y'.repeat(200) }, { swarm: 's1', agent: `a${i}`, atSec: i }))
  const n = fitEvents(big, 's1')
  assert.ok(n > 0 && n < big.length)
  const text = JSON.stringify({ v: 1, kind: 'events', swarm: 's1', offset: 999_999_999, events: big.slice(0, n), bad: 0 })
  assert.ok(text.length <= FEED_REPLY_MAX)
  assert.equal(fitEvents(big.slice(0, 2), 's1'), 2)
  assert.equal(fitEvents([], 's1'), 0)
})

test('an unknown trimmed value or bad too-large count is refused', () => {
  assert.equal(parseFeedReply(JSON.stringify({ v: 1, kind: 'state', swarm: 's1', offset: 0, state: emptyState('s1'), trimmed: false })), null)
  assert.equal(parseFeedReply('{"v":1,"kind":"too-large","agents":-1}'), null)
})

test('older finished agents are left out, with a count; running ones and their references stay consistent', () => {
  const state = bigState(300, 30, 270)
  const r = freshReply('big', 1, state)
  assert.ok(r.kind === 'state' && r.trimmed === true && isSwarmState(r.state, 'big'))
  assert.equal(JSON.stringify(r).length <= FEED_REPLY_MAX, true)
  assert.equal(r.hiddenFinished, 250)
  const kept = Object.values(r.state.agents)
  assert.equal(kept.length, 50)
  assert.equal(kept.filter(a => a.finishedAt === null).length, 30, 'every running agent is kept')
  assert.equal(kept.filter(a => a.finishedAt !== null).length, 20)
  const newest = Math.max(...Object.values(state.agents).map(a => a.finishedAt ?? 0))
  assert.ok(kept.some(a => a.finishedAt === newest), 'the most recently finished is kept')
  for (const id of Object.values(r.state.byName)) assert.ok(Object.hasOwn(r.state.agents, id))
  for (const l of Object.values(r.state.links)) assert.ok(Object.hasOwn(r.state.agents, l.from))
  for (const list of Object.values(r.state.edits)) for (const e of list) assert.ok(Object.hasOwn(r.state.agents, e.agent))
  assert.equal(parseFeedReply(JSON.stringify(r))?.kind, 'state')
})

test('when finished agents are not enough, files and samples are emptied', () => {
  const r = freshReply('big', 1, bigState(60, 200))
  assert.ok(r.kind === 'state' && isSwarmState(r.state, 'big'))
  assert.equal(r.hiddenFinished, undefined)
  assert.equal(Object.keys(r.state.agents).length, 60)
  assert.ok(Object.values(r.state.agents).every(a => a.files.length === 0 && a.samples.length === 0))
  assert.ok(JSON.stringify(r).length <= FEED_REPLY_MAX)
})

test('the ceiling: about 60 running agents fit, 70 do not', () => {
  assert.equal(freshReply('big', 1, bigState(60, 200)).kind, 'state')
  assert.equal(freshReply('big', 1, bigState(70, 200)).kind, 'too-large')
})
