// tests/core/budget.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldAll, fold, LEAD } from '../../src/core/fold.ts'
import {
  DEFAULT_LIMITS, billingFrom, budgetText, planReading, blockReason, effective, evaluate, isBlocked, limitsFrom, nudgeText, parseBudget, parseUsd, swarmCost, toastText, warnLevel,
} from '../../src/core/budget.ts'
import { at, ev } from '../helpers.ts'

const started = ev('agent.started', { name: 'coder-b', role: 'coder', description: '', parent: LEAD }, { agent: 'a1', atSec: 0 })
const min = (m: number) => at(0) + m * 60_000

test('limits come from the options, a bad value falling back to the default', () => {
  assert.deepEqual(limitsFrom({}), DEFAULT_LIMITS)
  assert.deepEqual(limitsFrom({ budgetAgentMinutes: 45, budgetAgentUsd: -2, budgetSwarmUsd: 'x' }), { ...DEFAULT_LIMITS, agentMinutes: 45 })
  assert.deepEqual(limitsFrom({ budgetSwarmUsd: 1001 }), DEFAULT_LIMITS)
  assert.deepEqual(limitsFrom({ budgetAgentMinutes: 0.5 }), DEFAULT_LIMITS)
  assert.deepEqual(limitsFrom({ budgetAgentMinutes: 1, budgetAgentUsd: 0.5, budgetSwarmUsd: 1000 }), { agentMinutes: 1, agentUsd: 0.5, swarmUsd: 1000 })
})

test('warn levels are the spec fractions of the act level', () => {
  assert.equal(warnLevel(DEFAULT_LIMITS, 'agentMinutes'), 20)
  assert.equal(warnLevel(DEFAULT_LIMITS, 'agentUsd'), 3)
  assert.equal(warnLevel(DEFAULT_LIMITS, 'swarmUsd'), 10)
})

test('parseBudget takes a partial object and refuses anything else', () => {
  assert.deepEqual(parseBudget({ swarmUsd: 30 }), { ok: true, patch: { swarmUsd: 30 } })
  assert.equal(parseBudget({}).ok, false)
  assert.equal(parseBudget({ agentMinutes: 0 }).ok, false)
  assert.equal(parseBudget({ agentUsd: 1001 }).ok, false)
  assert.equal(parseBudget({ swarmUsd: 5, extra: 1 }).ok, false)
  assert.equal(parseBudget([5]).ok, false)
})

test('parseUsd reads 30, $30 and 2.50 and refuses the rest', () => {
  assert.equal(parseUsd('30'), 30)
  assert.equal(parseUsd('$30'), 30)
  assert.equal(parseUsd('2.50'), 2.5)
  for (const bad of ['0', '-1', '1001', '1e3', 'abc', '', '2.555']) assert.equal(parseUsd(bad), null, bad)
})

test('effective limits take the swarm overrides', () => {
  const s = foldAll('s1', [ev('budget.set', { swarmUsd: 40 }, { atSec: 1 })])
  assert.deepEqual(effective(DEFAULT_LIMITS, s), { ...DEFAULT_LIMITS, swarmUsd: 40 })
})

test('swarm cost is session cost over its baseline, or the agents before any session cost', () => {
  const s = foldAll('s1', [started, ev('agent.usage', { model: 'claude-opus-5-5', input: 0, output: 100_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, { agent: 'a1', atSec: 1 })])
  assert.equal(swarmCost(s, null), 2)
  fold(s, ev('session.measure', { contextWindow: 1, costUsd: 7.5 }, { atSec: 2 }))
  assert.equal(swarmCost(s, 1.5), 6)
  assert.equal(swarmCost(s, null), 7.5)
})

test('time: warn at 20 min, nudge at 30, each once', () => {
  const s = foldAll('s1', [started])
  assert.deepEqual(evaluate(s, DEFAULT_LIMITS, 0, min(19)), [])
  assert.deepEqual(evaluate(s, DEFAULT_LIMITS, 0, min(21)), [{ kind: 'warn', agent: 'a1', limit: 'time', value: 21, threshold: 20 }])
  fold(s, ev('guard.warned', { limit: 'time', value: 21, threshold: 20 }, { agent: 'a1', atSec: 21 * 60 }))
  assert.deepEqual(evaluate(s, DEFAULT_LIMITS, 0, min(25)), [])
  assert.deepEqual(evaluate(s, DEFAULT_LIMITS, 0, min(31)), [{ kind: 'nudge', agent: 'a1', limit: 'time', value: 31, threshold: 30 }])
})

test('a jump past both stages gives the warning and the nudge together', () => {
  const s = foldAll('s1', [started])
  assert.deepEqual(evaluate(s, DEFAULT_LIMITS, 0, min(40)).map(a => a.kind), ['warn', 'nudge'])
})

test('finished agents, the lead and placeholders are not timed', () => {
  const s = foldAll('s1', [started, ev('agent.finished', { outcome: 'answer' }, { agent: 'a1', atSec: 60 }), ev('message.sent', { to: 'ghost', summary: '' }, { atSec: 61 })])
  assert.deepEqual(evaluate(s, DEFAULT_LIMITS, 0, min(90)), [])
})

test('raising a limit re-arms the stages above where they fired', () => {
  const s = foldAll('s1', [started, ev('guard.warned', { limit: 'time', value: 21, threshold: 20 }, { agent: 'a1', atSec: 1 })])
  const raised = { ...DEFAULT_LIMITS, agentMinutes: 60 }
  assert.deepEqual(evaluate(s, raised, 0, min(39)), [])
  assert.deepEqual(evaluate(s, raised, 0, min(41)).map(a => a.kind), ['warn'])
})

test('raising the agent cost and swarm limits re-arms their stages', () => {
  const usage = ev('agent.usage', { model: 'claude-opus-5-5', input: 0, output: 100_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, { agent: 'a1', atSec: 1 })
  const s = foldAll('s1', [started, usage, ev('guard.warned', { limit: 'agentCost', value: 3.1, threshold: 3 }, { agent: 'a1', atSec: 2 }),
    ev('guard.nudged', { limit: 'agentCost', value: 5.1, threshold: 5, delivered: true }, { agent: 'a1', atSec: 3 }),
    ev('guard.warned', { limit: 'swarmCost', value: 10.4, threshold: 10 }, { atSec: 4 }), ev('guard.blocked', { value: 20, threshold: 20 }, { atSec: 5 })])
  assert.deepEqual(evaluate(s, DEFAULT_LIMITS, 20, min(1)), [])
  const raised = { ...DEFAULT_LIMITS, agentUsd: 0.5, swarmUsd: 40 }
  // agent at $2: warn at 0.5*0.6=0.3 and act at 0.5 are below the $3/$5 already fired, so nothing; swarm 25 passes the new warn (20) only
  assert.deepEqual(evaluate(s, raised, 25, min(1)), [{ kind: 'swarm-warn', value: 25, threshold: 20 }])
  const high = { ...DEFAULT_LIMITS, agentUsd: 10, swarmUsd: 60 }
  assert.deepEqual(evaluate(s, high, 60, min(1)).map(a => a.kind), ['swarm-warn', 'block'])
  fold(s, ev('agent.usage', { model: 'claude-opus-5-5', input: 0, output: 200_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, { agent: 'a1', atSec: 6 }))
  assert.deepEqual(evaluate(s, { ...high, agentUsd: 5.5 }, 0, min(1)).map(a => a.kind), ['warn', 'nudge'])
})

test('swarm cost warns at half and blocks at the limit', () => {
  const s = foldAll('s1', [started])
  assert.deepEqual(evaluate(s, DEFAULT_LIMITS, 10.4, min(1)), [{ kind: 'swarm-warn', value: 10.4, threshold: 10 }])
  fold(s, ev('guard.warned', { limit: 'swarmCost', value: 10.4, threshold: 10 }, { atSec: 61 }))
  assert.deepEqual(evaluate(s, DEFAULT_LIMITS, 20, min(1)), [{ kind: 'block', value: 20, threshold: 20 }])
  assert.equal(isBlocked(DEFAULT_LIMITS, 20), true)
  assert.equal(isBlocked(DEFAULT_LIMITS, 19.99), false)
})

test('the words', () => {
  assert.equal(toastText({ kind: 'warn', agent: 'a1', limit: 'time', value: 21.4, threshold: 20 }, 'coder-b', DEFAULT_LIMITS), 'coder-b: 21 min, past its 20 min time-box')
  assert.equal(toastText({ kind: 'warn', agent: 'a1', limit: 'agentCost', value: 3.1, threshold: 3 }, 'coder-b', DEFAULT_LIMITS), 'coder-b: ≈$3.10, past its $3 warning')
  assert.equal(toastText({ kind: 'nudge', agent: 'a1', limit: 'time', value: 31, threshold: 30 }, 'coder-b', DEFAULT_LIMITS), 'coder-b: 31 min, asked to wrap up (30 min time-box)')
  // Under ten minutes a whole-minute floor would read as short of the limit, so one decimal, never rounded up.
  assert.equal(toastText({ kind: 'nudge', agent: 'a1', limit: 'time', value: 1.54, threshold: 1.5 }, 'tester', DEFAULT_LIMITS), 'tester: 1.5 min, asked to wrap up (1.5 min time-box)')
  assert.equal(toastText({ kind: 'warn', agent: 'a1', limit: 'time', value: 1.06, threshold: 1 }, 'tester', DEFAULT_LIMITS), 'tester: 1 min, past its 1 min time-box')
  assert.equal(toastText({ kind: 'warn', agent: 'a1', limit: 'time', value: 6.99, threshold: 6 }, 'tester', DEFAULT_LIMITS), 'tester: 6.9 min, past its 6 min time-box')
  assert.equal(toastText({ kind: 'block', value: 20, threshold: 20 }, '', DEFAULT_LIMITS), 'Swarm budget $20 reached: new agents are blocked. /omnis budget <usd> raises it.')
  assert.equal(nudgeText(DEFAULT_LIMITS), "You're past your time-box (30 min / $5). Wrap up what you have, report to main, and stop.")
  assert.equal(blockReason(DEFAULT_LIMITS), 'Swarm budget $20 reached. Raise it with /omnis budget <usd> or finish with the agents you have.')
  assert.equal(budgetText(DEFAULT_LIMITS, 4.123), 'Budget: each agent 30 min / $5 (warns at 20 min / $3); swarm $20 (warns at $10). Swarm so far ≈$4.12. New agents: allowed.')
})

test('billing comes from the options, anything unknown meaning auto', () => {
  assert.equal(billingFrom({}), 'auto')
  assert.equal(billingFrom({ billing: 'subscription' }), 'subscription')
  assert.equal(billingFrom({ billing: 'api' }), 'api')
  assert.equal(billingFrom({ billing: 'API' }), 'auto')
  assert.equal(billingFrom({ billing: 3 }), 'auto')
})

test('a 5-hour or 7-day window is a subscription reading, a gateway spend limit or nothing is not', () => {
  assert.deepEqual(planReading([{ kind: 'five_hour', percentUsed: 34.5 }, { kind: 'seven_day', percentUsed: 12 }]), { fiveHour: 34.5 })
  assert.deepEqual(planReading([{ kind: 'seven_day', percentUsed: 12 }]), { fiveHour: null })
  assert.deepEqual(planReading([{ kind: 'five_hour', percentUsed: 140 }]), { fiveHour: 100 })
  assert.deepEqual(planReading([{ kind: 'five_hour', percentUsed: 'x' }]), { fiveHour: null })
  assert.equal(planReading([{ kind: 'spend_limit', percentUsed: 50 }]), null)
  assert.equal(planReading([]), null)
  assert.equal(planReading(undefined), null)
  assert.equal(planReading([null, 'five_hour', { kind: 7 }]), null)
})

test('with dollars off only the time-box is checked: no agent cost stages, no swarm warn or block', () => {
  const state = foldAll('s1', [started, ev('agent.usage', { model: 'claude-opus-5-5', input: 0, output: 450_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, { agent: 'a1', atSec: 1 })])
  const off = evaluate(state, DEFAULT_LIMITS, 50, min(31), false)
  assert.deepEqual(off.map(a => [a.kind, 'limit' in a ? a.limit : null]), [['warn', 'time'], ['nudge', 'time']])
  const on = evaluate(state, DEFAULT_LIMITS, 50, min(31))
  assert.ok(on.some(a => a.kind === 'block') && on.some(a => a.kind === 'nudge' && a.limit === 'agentCost'))
})

test('the subscription words: no dollar budget in the nudge or the budget line', () => {
  assert.equal(nudgeText(DEFAULT_LIMITS, false), "You're past your time-box (30 min). Wrap up what you have, report to main, and stop.")
  assert.equal(budgetText(DEFAULT_LIMITS, 12.5, { fiveHour: 34 }),
    'Budget: on a subscription, so no dollar limits (costs are shown for reference). Each agent 30 min (warns at 20 min). Swarm so far ≈$12.50. 5-hour window 34% used. New agents: allowed.')
  assert.equal(budgetText(DEFAULT_LIMITS, 0, { fiveHour: null }),
    'Budget: on a subscription, so no dollar limits (costs are shown for reference). Each agent 30 min (warns at 20 min). Swarm so far ≈$0.00. New agents: allowed.')
})
