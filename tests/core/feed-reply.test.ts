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
import { FEED_REPLY_MAX, fitEvents, freshReply, utf8Bytes } from '../../src/core/feed-reply.ts'
import { foldAll, type SwarmState } from '../../src/core/fold.ts'
import { isSwarmState } from '../../src/core/state-check.ts'

/**
 * A state of `agents` agents, each with `files` files read, built by folding real events. `routed`: every agent's
 * calls were answered by another model than the one requested (OmnisRouter), so each carries a route.
 */
function bigState(agents: number, files: number, finished = 0, desc = 'd', quote = false, routed = false): SwarmState {
  const events = []
  const pre = quote ? 'q"\\' : 'n'
  for (let a = 0; a < agents; a++) {
    events.push(ev('agent.started', { name: `${pre}${a}`, role: 'coder', description: desc, parent: 'lead' }, { swarm: 'big', agent: `a${a}`, atSec: 1 }))
  }
  for (let a = 0; a < agents; a++) {
    const id = `a${a}`
    for (let f = 0; f < files; f++) {
      events.push(ev('agent.tool', { phase: 'start', tool: 'Read', kind: 'read', subject: `src/area${a}/module-${f}.ts`, isError: false }, { swarm: 'big', agent: id, atSec: 2 + f / 1000 }))
    }
    // Edits and messages that point at agents, so dropping an agent has links and edits to clean up.
    events.push(ev('agent.tool', { phase: 'start', tool: 'Edit', kind: 'edit', subject: `shared/file-${a % 5}.ts`, isError: false }, { swarm: 'big', agent: id, atSec: 5 }))
    events.push(ev('message.sent', { to: `${pre}${(a + 1) % agents}`, summary: 'hi' }, { swarm: 'big', agent: id, atSec: 6 }))
    if (routed) {
      for (let c = 0; c < 3; c++) {
        events.push(ev('agent.usage', { model: 'claude-haiku-5-5', requested: 'claude-sonnet-5-5', input: 12_345 + a, output: 678 + c, cacheRead: 9_876, cacheWrite5m: 543, cacheWrite1h: 0 }, { swarm: 'big', agent: id, atSec: 7 + c }))
      }
    }
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

// Usage itself is what costs room (a spend entry, the model, cost and token counts per call): with three calls each,
// 47 agents fit unrouted. The route adds under 50 bytes an agent, so 45 routed ones fit.
test('routed agents: the route stays small, survives trimming, and 45 with usage still fit', () => {
  const state = bigState(45, 200, 0, 'd', false, true)
  assert.ok(Object.values(state.agents).every(a => a.route !== undefined))
  const r = freshReply('big', 1, state)
  assert.ok(r.kind === 'state' && isSwarmState(r.state, 'big'))
  assert.ok(Object.values(r.state.agents).every(a => a.route !== undefined), 'trimming keeps the route')
  assert.ok(Buffer.byteLength(JSON.stringify(r)) <= FEED_REPLY_MAX)
  const route = JSON.stringify({ route: state.agents['a0']!.route })
  assert.ok(route.length <= 50, route)
  assert.equal(freshReply('big', 1, bigState(50, 200, 0, 'd', false, true)).kind, 'too-large')
})

test('utf8Bytes agrees with the real encoding for ASCII, accents, CJK, emoji and escapes', () => {
  for (const t of ['', 'plain', 'café', '漢字です', 'party \u{1F389}!', 'q"\\\\n\n', '\ud800 lone']) {
    assert.equal(utf8Bytes(t), Buffer.byteLength(t), JSON.stringify(t))
  }
})

test('the cap is in bytes: CJK text that fits by characters is still trimmed to fit by bytes', () => {
  const desc = '漢'.repeat(120)
  let tested = false
  for (let n = 30; n <= 70 && !tested; n++) {
    const state = bigState(n, 0, 0, desc)
    const text = JSON.stringify({ v: 1, kind: 'state', swarm: 'big', offset: 1, state })
    if (text.length > FEED_REPLY_MAX || Buffer.byteLength(text) <= FEED_REPLY_MAX) continue
    tested = true
    const r = freshReply('big', 1, state)
    const sent = JSON.stringify(r)
    assert.ok(Buffer.byteLength(sent) <= FEED_REPLY_MAX, `${Buffer.byteLength(sent)}`)
    assert.ok(r.kind === 'too-large' || r.trimmed === true)
  }
  assert.ok(tested, 'found a size that fits by characters but not by bytes')
})

test('quote and backslash heavy names are measured as serialised, and the reply stays under the cap and valid', () => {
  const state = bigState(300, 30, 270, 'd', true)
  const r = freshReply('big', 1, state)
  assert.ok(r.kind === 'state' && isSwarmState(r.state, 'big'))
  assert.ok(Buffer.byteLength(JSON.stringify(r)) <= FEED_REPLY_MAX)
  assert.equal(parseFeedReply(JSON.stringify(r))?.kind, 'state')
})

test('the size includes hiddenFinished', () => {
  for (const fin of [268, 270, 272]) {
    const r = freshReply('big', 1, bigState(300, 30, fin))
    if (r.kind === 'state') assert.ok(Buffer.byteLength(JSON.stringify(r)) <= FEED_REPLY_MAX)
  }
})

test('the lead is never left out, even when finished and oldest', () => {
  const state = bigState(300, 30, 270)
  const a0 = state.agents['a0']!
  state.agents['lead'] = { ...a0, id: 'lead', name: 'lead', finishedAt: 1 }
  state.byName['lead'] = 'lead'
  const r = freshReply('big', 1, state)
  assert.ok(r.kind === 'state' && Object.hasOwn(r.state.agents, 'lead'))
})

test('a swarm of running agents too many to fit is refused without trimming', () => {
  assert.deepEqual(freshReply('big', 1, bigState(90, 0)), { v: 1, kind: 'too-large', agents: 90 })
})
