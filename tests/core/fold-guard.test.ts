import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldAll, LEAD } from '../../src/core/fold.ts'
import { isSwarmState } from '../../src/core/state-check.ts'
import { ev } from '../helpers.ts'

const start = ev('agent.started', { name: 'coder-b', role: 'coder', description: '', parent: LEAD }, { agent: 'a1', atSec: 1 })

test('a fresh state has no budget overrides and no guard stages', () => {
  const s = foldAll('s1', [start])
  assert.deepEqual(s.budget, { agentMinutes: null, agentUsd: null, swarmUsd: null })
  assert.deepEqual(s.guard, { warn: null, block: null })
  assert.equal(s.agents.a1!.guard, undefined)
})

test('budget.set merges valid keys and skips bad ones', () => {
  const s = foldAll('s1', [
    ev('budget.set', { swarmUsd: 30 }, { atSec: 2 }),
    ev('budget.set', { agentMinutes: 45, agentUsd: -1 }, { atSec: 3 }),
    ev('budget.set', { agentUsd: 5000 } as never, { atSec: 4 }),
  ])
  assert.deepEqual(s.budget, { agentMinutes: 45, agentUsd: null, swarmUsd: 30 })
})

test('guard events record the threshold each stage fired at, and say so in the feed', () => {
  const s = foldAll('s1', [
    start,
    ev('guard.warned', { limit: 'time', value: 21, threshold: 20 }, { agent: 'a1', atSec: 5 }),
    ev('guard.nudged', { limit: 'agentCost', value: 5.2, threshold: 5, delivered: false, reason: 'gone' }, { agent: 'a1', atSec: 6 }),
    ev('guard.warned', { limit: 'swarmCost', value: 10.4, threshold: 10 }, { atSec: 7 }),
    ev('guard.blocked', { value: 20.1, threshold: 20 }, { atSec: 8 }),
  ])
  assert.deepEqual(s.agents.a1!.guard, { timeWarn: 20, timeAct: null, costWarn: null, costAct: 5 })
  assert.deepEqual(s.guard, { warn: 10, block: 20 })
  assert.deepEqual(s.feed.slice(-4).map(f => f.text), [
    'coder-b: 21 min, past its 20 min warning',
    'coder-b asked to wrap up at ≈$5.20 (not delivered)',
    'swarm: ≈$10.40, past its $10 warning',
    'swarm budget $20 reached: new agents blocked',
  ])
  assert.equal(isSwarmState(JSON.parse(JSON.stringify(s)), 's1'), true)
})

test('a guard event with a bad limit or numbers changes nothing', () => {
  const s = foldAll('s1', [start, ev('guard.warned', { limit: 'nope', value: Number.NaN, threshold: 20 } as never, { agent: 'a1', atSec: 5 })])
  assert.equal(s.agents.a1!.guard, undefined)
})
