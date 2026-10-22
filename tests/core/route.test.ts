import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { EventData } from '../../src/core/events.ts'
import { foldAll, LEAD } from '../../src/core/fold.ts'
import { sameModel } from '../../src/core/prices.ts'
import { isSwarmState } from '../../src/core/state-check.ts'
import { agentStats } from '../../src/core/stats.ts'
import { at, ev } from '../helpers.ts'

const near = (a: number | null | undefined, b: number) => assert.ok(typeof a === 'number' && Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`)
const coder = ev('agent.started', { name: 'coder', role: 'coder', description: '', parent: LEAD }, { agent: 'a1', atSec: 1 })
const call = (atSec: number, model: string, requested?: string) => {
  const data: EventData['agent.usage'] = { model, input: 1000, output: 1000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }
  if (requested !== undefined) data.requested = requested
  return ev('agent.usage', data, { agent: 'a1', atSec })
}

test('sameModel ignores case, a bracketed suffix and a date stamp, and nothing else', () => {
  assert.ok(sameModel('claude-haiku-5-5', 'claude-haiku-5-5'))
  assert.ok(sameModel('claude-opus-5-5[1m]', 'claude-opus-5-5-20261001'))
  assert.ok(sameModel('Claude-Sonnet-5-5', 'claude-sonnet-5-5'))
  assert.ok(!sameModel('claude-sonnet-5-5', 'claude-haiku-5-5'))
  assert.ok(!sameModel('claude-sonnet-5-5', 'claude-sonnet-5'))
  assert.ok(!sameModel('claude-sonnet-5-5', 'gpt-5-mini'))
})

test('an agent with no routed call has no route', () => {
  const s = foldAll('s1', [coder, call(2, 'claude-sonnet-5-5')])
  assert.equal(Object.hasOwn(s.agents.a1!, 'route'), false)
  assert.equal(agentStats(s, 'a1', at(3))!.route, null)
})

test('a routed call records the requested model and prices the baseline at it, unrouted calls included', () => {
  const s = foldAll('s1', [coder, call(2, 'claude-sonnet-5-5'), call(3, 'claude-haiku-5-5', 'claude-sonnet-5-5')])
  const a = s.agents.a1!
  assert.equal(a.model, 'claude-haiku-5-5')
  assert.deepEqual(a.route, { calls: 1, requested: 'claude-sonnet-5-5', baselineUsd: 0.024, baselineKnown: true })
  near(a.costUsd, 0.0126)
  const r = agentStats(s, 'a1', at(4))!.route!
  assert.equal(r.requested, 'claude-sonnet-5-5')
  assert.equal(r.calls, 1)
  near(r.savedPct, 1 - 0.0126 / 0.024)
})

test('unrouted calls after a route still add to the baseline at their own price', () => {
  const s = foldAll('s1', [coder, call(2, 'claude-haiku-5-5', 'claude-sonnet-5-5'), call(3, 'claude-sonnet-5-5')])
  near(s.agents.a1!.route!.baselineUsd, 0.024)
  assert.equal(s.agents.a1!.route!.calls, 1)
})

test('a requested id that only differs by date or suffix is not a route', () => {
  const s = foldAll('s1', [coder, call(2, 'claude-haiku-5-5-20261001', 'claude-haiku-5-5[1m]')])
  assert.equal(s.agents.a1!.route, undefined)
})

test('routing up to a dearer model shows a negative saving', () => {
  const s = foldAll('s1', [coder, call(2, 'claude-sonnet-5-5', 'claude-haiku-5-5')])
  near(agentStats(s, 'a1', at(3))!.route!.savedPct, 1 - 0.012 / 0.0006)
})

test('an unpriced model on either side leaves the saving unknown but keeps the route', () => {
  const answered = foldAll('s1', [coder, call(2, 'gpt-5-mini', 'claude-sonnet-5-5')])
  assert.equal(agentStats(answered, 'a1', at(3))!.route!.savedPct, null)
  assert.equal(agentStats(answered, 'a1', at(3))!.route!.requested, 'claude-sonnet-5-5')
  const requested = foldAll('s1', [coder, call(2, 'claude-haiku-5-5', 'mystery')])
  assert.equal(requested.agents.a1!.route!.baselineKnown, false)
  assert.equal(agentStats(requested, 'a1', at(3))!.route!.savedPct, null)
})

test('a routed state passes the state check, and a malformed route does not', () => {
  const s = foldAll('s1', [coder, call(2, 'claude-haiku-5-5', 'claude-sonnet-5-5')])
  assert.ok(isSwarmState(JSON.parse(JSON.stringify(s)), 's1'))
  const bad = JSON.parse(JSON.stringify(s))
  bad.agents.a1.route.requested = 'x\u0007'
  assert.ok(!isSwarmState(bad, 's1'))
  const extra = JSON.parse(JSON.stringify(s))
  extra.agents.a1.route.spy = 1
  assert.ok(!isSwarmState(extra, 's1'))
})
