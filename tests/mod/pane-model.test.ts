import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FeedReply } from '../../src/core/feed-reply.ts'
import { emptyState, foldAll } from '../../src/core/fold.ts'
import { COALESCE_MS, MAX_PULSES, applyReply, markPulses, emptyModel, feedArgs, prunePulses, pulsesFrom } from '../../src/mod/pane-model.ts'
import { ev } from '../helpers.ts'
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
  assert.deepEqual([b.model.degraded, b.model.state === state, b.model.degradedAgents], ['too-large', true, 900])
  const c = applyReply(b.model, { v: 1, kind: 'events', swarm: FIVE_SWARM, offset: 20, events: events.slice(10, 12), bad: 0 }, FIVE_T0)
  assert.equal(c.model.degraded, null)
  assert.equal(c.model.degradedAgents, 0)
  assert.equal(c.model.offset, 20)
  assert.equal(applyReply(a.model, { v: 1, kind: 'none' }, FIVE_T0).model.degraded, null)
})

test('a too-large reply before any state leaves the model empty but flagged', () => {
  const r = applyReply(emptyModel(), { v: 1, kind: 'too-large', agents: 500 }, FIVE_T0)
  assert.deepEqual([r.model.state, r.model.degraded], [null, 'too-large'])
  assert.deepEqual(feedArgs(r.model), { since: 0 })
})

test('hiddenFinished follows the state reply and is kept across events', () => {
  const state = foldAll(FIVE_SWARM, events.slice(0, 10))
  const a = applyReply(emptyModel(), { v: 1, kind: 'state', swarm: FIVE_SWARM, offset: 10, state, hiddenFinished: 7 }, FIVE_T0).model
  assert.equal(a.hiddenFinished, 7)
  const b = applyReply(a, { v: 1, kind: 'events', swarm: FIVE_SWARM, offset: 20, events: events.slice(10, 12), bad: 0 }, FIVE_T0).model
  assert.equal(b.hiddenFinished, 7)
  const c = applyReply(b, { v: 1, kind: 'state', swarm: FIVE_SWARM, offset: 30, state }, FIVE_T0).model
  assert.equal(c.hiddenFinished, 0)
})

test('hiddenFinished is cleared once folded events bring in an agent the state did not hold', () => {
  // The new agent may be one the server left out of the trimmed state, so the count can no longer be trusted.
  const state = foldAll(FIVE_SWARM, events.slice(0, 8))
  assert.equal(Object.hasOwn(state.agents, 'a-cod2'), false)
  const a = applyReply(emptyModel(), { v: 1, kind: 'state', swarm: FIVE_SWARM, offset: 8, state, hiddenFinished: 7 }, FIVE_T0).model
  const b = applyReply(a, { v: 1, kind: 'events', swarm: FIVE_SWARM, offset: 9, events: events.slice(8, 9), bad: 0 }, FIVE_T0).model
  assert.equal(Object.hasOwn(b.state!.agents, 'a-cod2'), true)
  assert.equal(b.hiddenFinished, 0)
})

test('a steady tool cadence flickers on a stable schedule once per 600 ms or more, never zero, as pulses are pruned frame by frame', () => {
  for (const cadence of [300, 400, 550, 700]) {
    let model = applyReply(emptyModel(), { v: 1, kind: 'state', swarm: FIVE_SWARM, offset: 1, state: emptyState(FIVE_SWARM) }, 0).model
    const base = Date.parse(events[0]!.ts)
    const starts = Array.from({ length: Math.ceil(20_000 / cadence) }, (_, i) => i)
    const flag = new Map<number, boolean>()
    const drawn = new Set<number>()
    let offset = 1
    for (let now = base; now <= base + 20_000; now += 50) {
      const due = starts.filter(i => base + i * cadence > now - 50 && base + i * cadence <= now)
      const batch = due.map(i => {
        const e = ev('agent.tool', { phase: 'start', tool: 'Bash', kind: 'bash', subject: 'x', isError: false }, { agent: 'a-x' })
        return { ...e, ts: new Date(base + i * cadence).toISOString() }
      })
      offset += batch.length
      model = applyReply(model, { v: 1, kind: 'events', swarm: FIVE_SWARM, offset, events: batch, bad: 0 }, now).model
      for (const p of model.pulses) {
        const was = flag.get(p.at)
        assert.ok(was === undefined || was === (p.coalesced === true), 'a pulse never changes its mark')
        flag.set(p.at, p.coalesced === true)
        if (p.coalesced !== true) drawn.add(p.at)
      }
    }
    const times = [...drawn].sort((a, b) => a - b)
    assert.ok(times.length > 20_000 / (COALESCE_MS + cadence) - 1, `cadence ${cadence}: flickers keep coming`)
    for (let i = 1; i < times.length; i++) {
      const gap = times[i]! - times[i - 1]!
      assert.ok(gap >= COALESCE_MS && gap < COALESCE_MS + cadence, `cadence ${cadence}: gap ${gap}`)
    }
  }
})

test('coalescing treats any agent id alike, including __proto__ and constructor', () => {
  for (const agent of ['__proto__', 'constructor', 'toString']) {
    const p = (at: number) => ({ agent, kind: 'bash' as const, at, isError: false })
    const { pulses, lastFlicker } = markPulses([p(1000), p(1300), p(1700)], Object.create(null))
    assert.deepEqual(pulses.map(x => x.coalesced === true), [false, true, false], agent)
    assert.equal(Object.hasOwn(lastFlicker, agent), true)
    // And from an ordinary object carried in as the previous record.
    assert.equal(markPulses([p(5000)], {}).pulses[0]!.coalesced, undefined)
  }
})

test('the last-flicker entry of a long-gone agent is dropped, a recent one is kept', () => {
  const p = (agent: string, at: number) => ({ agent, kind: 'bash' as const, at, isError: false })
  const first = markPulses([p('old', 1000), p('recent', 9700)], {})
  assert.deepEqual(Object.keys(first.lastFlicker), ['recent'])
  const next = markPulses([p('busy', 10_000)], first.lastFlicker)
  assert.deepEqual(Object.keys(next.lastFlicker).sort(), ['busy', 'recent'])
  assert.deepEqual(Object.keys(markPulses([], next.lastFlicker).lastFlicker).sort(), ['busy', 'recent'])
})
