import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FeedReply } from '../../src/core/feed-reply.ts'
import { emptyState, foldAll } from '../../src/core/fold.ts'
import { MAX_PULSES, applyReply, emptyModel, feedArgs, prunePulses, pulsesFrom } from '../../src/mod/pane-model.ts'
import { FIVE_SWARM, FIVE_T0, fiveAgentEvents } from '../fixtures/swarm-five.ts'

const events = fiveAgentEvents()

test('the first pull asks for everything, later pulls ask for what is new', () => {
  assert.deepEqual(feedArgs(emptyModel()), { since: 0 })
  const { model } = applyReply(emptyModel(), { v: 1, kind: 'state', swarm: FIVE_SWARM, offset: 120, state: emptyState(FIVE_SWARM) }, FIVE_T0)
  assert.deepEqual(feedArgs(model), { since: 120, swarm: FIVE_SWARM })
})

test('a state reply replaces the model and says whether the swarm changed', () => {
  const state = foldAll(FIVE_SWARM, events.slice(0, 10))
  const a = applyReply(emptyModel(), { v: 1, kind: 'state', swarm: FIVE_SWARM, offset: 10, state }, FIVE_T0)
  assert.deepEqual([a.changed, a.swarmChanged, a.model.state === state, a.model.offset], [true, true, true, 10])
  const b = applyReply(a.model, { v: 1, kind: 'state', swarm: FIVE_SWARM, offset: 20, state }, FIVE_T0)
  assert.equal(b.swarmChanged, false)
})

test('an events reply is folded in, with pulses, gaps, the new offset and an arrival lag', () => {
  const start = applyReply(emptyModel(), { v: 1, kind: 'state', swarm: FIVE_SWARM, offset: 100, state: foldAll(FIVE_SWARM, events.slice(0, 17)) }, FIVE_T0).model
  const reply: FeedReply = { v: 1, kind: 'events', swarm: FIVE_SWARM, offset: 200, events: events.slice(17, 27), bad: 1 }
  const r = applyReply(start, reply, FIVE_T0 + 14_500)
  assert.equal(r.changed, true)
  assert.equal(r.model.offset, 200)
  assert.ok(r.model.state !== null && Object.hasOwn(r.model.state.agents, 'a-test') && Object.hasOwn(r.model.state.agents, 'a-rev'))
  assert.equal(r.model.state.gaps, 1)
  assert.equal(r.model.pulses.length, 4)
  assert.equal(r.model.pulses.filter(p => p.isError).length, 2)
  assert.equal(r.model.lagMs, 40)
})

test('an empty events reply changes nothing but the offset', () => {
  const start = applyReply(emptyModel(), { v: 1, kind: 'state', swarm: FIVE_SWARM, offset: 100, state: emptyState(FIVE_SWARM) }, FIVE_T0).model
  const r = applyReply(start, { v: 1, kind: 'events', swarm: FIVE_SWARM, offset: 100, events: [], bad: 0 }, FIVE_T0)
  assert.equal(r.changed, false)
})

test('events for another swarm reset the model so the next pull asks for everything', () => {
  const start = applyReply(emptyModel(), { v: 1, kind: 'state', swarm: FIVE_SWARM, offset: 100, state: emptyState(FIVE_SWARM) }, FIVE_T0).model
  const r = applyReply(start, { v: 1, kind: 'events', swarm: 'other', offset: 5, events: [], bad: 0 }, FIVE_T0)
  assert.deepEqual(feedArgs(r.model), { since: 0 })
  assert.equal(r.swarmChanged, true)
})

test('an events reply that does not continue from the held offset is not folded and asks for everything again', () => {
  const start = applyReply(emptyModel(), { v: 1, kind: 'state', swarm: FIVE_SWARM, offset: 100, state: foldAll(FIVE_SWARM, events.slice(0, 17)) }, FIVE_T0).model
  const back = applyReply(start, { v: 1, kind: 'events', swarm: FIVE_SWARM, offset: 50, events: events.slice(17, 27), bad: 0 }, FIVE_T0)
  assert.deepEqual(feedArgs(back.model), { since: 0, swarm: FIVE_SWARM })
  assert.notEqual(back.model.state, null)
  assert.equal(back.changed, false)
  assert.equal(back.swarmChanged, false)
  const stuck = applyReply(start, { v: 1, kind: 'events', swarm: FIVE_SWARM, offset: 100, events: events.slice(17, 27), bad: 0 }, FIVE_T0)
  assert.deepEqual(feedArgs(stuck.model), { since: 0, swarm: FIVE_SWARM })
  assert.notEqual(stuck.model.state, null)
  const bad = applyReply(start, { v: 1, kind: 'events', swarm: FIVE_SWARM, offset: 100, events: [], bad: 2 }, FIVE_T0)
  assert.deepEqual(feedArgs(bad.model), { since: 0, swarm: FIVE_SWARM })
  assert.notEqual(bad.model.state, null)
  assert.equal(start.state !== null && Object.hasOwn(start.state.agents, 'a-test'), false)
})

test('none leaves the model as it was', () => {
  const m = emptyModel()
  const r = applyReply(m, { v: 1, kind: 'none' }, FIVE_T0)
  assert.equal(r.model, m)
  assert.equal(r.changed, false)
})

test('pulses come from tool starts and failed tool ends, and old ones are dropped', () => {
  const all = pulsesFrom(events)
  assert.equal(all.length, 11)
  assert.equal(all.filter(p => p.isError).length, 3)
  assert.deepEqual(all[0], { agent: 'a-arch', kind: 'read', at: FIVE_T0 + 3000, isError: false })
  assert.equal(prunePulses(all, FIVE_T0 + 30_000).length, 2)
  const many = Array.from({ length: 100 }, (_, i) => ({ agent: 'x', kind: 'bash' as const, at: FIVE_T0 + i, isError: false }))
  assert.equal(prunePulses(many, FIVE_T0 + 100).length, MAX_PULSES)
})

test('an unparseable or too-large reply keeps the last good state, flags it, and a good reply clears it', () => {
  const state = foldAll(FIVE_SWARM, events.slice(0, 10))
  const good = applyReply(emptyModel(), { v: 1, kind: 'state', swarm: FIVE_SWARM, offset: 10, state }, FIVE_T0).model
  assert.equal(good.degraded, null)
  const a = applyReply(good, null, FIVE_T0)
  assert.deepEqual([a.model.degraded, a.model.state === state, a.model.offset, a.changed], ['unreadable', true, 10, true])
  assert.deepEqual(feedArgs(a.model), { since: 10, swarm: FIVE_SWARM })
  const b = applyReply(a.model, { v: 1, kind: 'too-large', agents: 900 }, FIVE_T0)
  assert.deepEqual([b.model.degraded, b.model.state === state], ['too-large', true])
  const c = applyReply(b.model, { v: 1, kind: 'events', swarm: FIVE_SWARM, offset: 20, events: events.slice(10, 12), bad: 0 }, FIVE_T0)
  assert.equal(c.model.degraded, null)
  assert.equal(c.model.offset, 20)
  assert.equal(applyReply(a.model, { v: 1, kind: 'none' }, FIVE_T0).model.degraded, null)
})

test('a too-large reply before any state leaves the model empty but flagged', () => {
  const r = applyReply(emptyModel(), { v: 1, kind: 'too-large', agents: 500 }, FIVE_T0)
  assert.deepEqual([r.model.state, r.model.degraded], [null, 'too-large'])
  assert.deepEqual(feedArgs(r.model), { since: 0 })
})
