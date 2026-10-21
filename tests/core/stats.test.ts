import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldAll, LEAD } from '../../src/core/fold.ts'
import { agentStats, fileClashes, swarmTotals, STALE_TOOL_MS } from '../../src/core/stats.ts'
import { at, ev } from '../helpers.ts'

const near = (a: number | null, b: number) => assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`)
const start = (id: string, name: string, atSec = 0) => ev('agent.started', { name, role: name, description: '', parent: LEAD }, { agent: id, atSec })
const usage = (id: string, atSec: number, u: { input?: number; output?: number; cacheRead?: number }) =>
  ev('agent.usage', { model: 'claude-sonnet-5-5', input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite5m: 0, cacheWrite1h: 0 }, { agent: id, atSec })
const edit = (id: string, path: string, atSec: number) => ev('agent.tool', { phase: 'start', tool: 'Edit', kind: 'edit', subject: path, isError: false }, { agent: id, atSec })

const state = () => foldAll('s1', [
  start('a1', 'coder'),
  usage('a1', 10, { input: 1000, output: 500, cacheRead: 9000 }),
  usage('a1', 20, { output: 1000, cacheRead: 10000 }),
])

test('agentStats works out tokens, cost, cache hit, context fill and speed', () => {
  const s = agentStats(state(), 'a1', at(21))!
  assert.equal(s.tokens.total, 21500)
  near(s.costUsd, 0.0208)
  near(s.cacheHitRate, 0.95)
  near(s.contextFill, 0.01)
  near(s.speedTps, 75)
  assert.deepEqual(s.speedSeries, [50, 100])
  assert.equal(s.status, 'running')
  assert.equal(s.lifetimeMs, 21_000)
})

test('status goes from running to waiting to done or failed', () => {
  const s = state()
  assert.equal(agentStats(s, 'a1', at(40))!.status, 'waiting')
  const done = foldAll('s1', [start('a1', 'coder'), ev('agent.finished', { outcome: 'aborted' }, { agent: 'a1', atSec: 3 })])
  assert.equal(agentStats(done, 'a1', at(4))!.status, 'done')
  const failed = foldAll('s1', [start('a1', 'coder'), ev('agent.finished', { outcome: 'failed' }, { agent: 'a1', atSec: 3 })])
  assert.equal(agentStats(failed, 'a1', at(4))!.status, 'failed')
})

test('speed only counts the last 30 seconds', () => {
  assert.equal(agentStats(state(), 'a1', at(60))!.speedTps, null)
})

test('stats with no calls are null rather than zero', () => {
  const s = agentStats(foldAll('s1', [start('a1', 'coder')]), 'a1', at(1))!
  assert.equal(s.cacheHitRate, null)
  assert.equal(s.contextFill, null)
  assert.equal(s.speedTps, null)
  assert.equal(s.costUsd, 0)
})

test('an unpriced model gives a null cost', () => {
  const s = foldAll('s1', [start('a1', 'coder'), ev('agent.usage', { model: 'mystery', input: 5, output: 5, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, { agent: 'a1', atSec: 1 })])
  assert.equal(agentStats(s, 'a1', at(2))!.costUsd, null)
})

test('three failed tool calls in a row mark an agent as stuck', () => {
  const fail = (atSec: number) => ev('agent.tool', { phase: 'end', tool: 'Bash', kind: 'bash', subject: 'npm test', isError: true }, { agent: 'a1', atSec })
  const s = foldAll('s1', [start('a1', 'coder'), fail(1), fail(2), fail(3)])
  assert.equal(agentStats(s, 'a1', at(4))!.stuck, true)
})

test('two agents editing one file within ten minutes is a clash', () => {
  const s = foldAll('s1', [
    start('a1', 'coder'), start('a2', 'tester'),
    edit('a1', 'src/auth.ts', 10), edit('a2', 'src/auth.ts', 100),
    edit('a1', 'src/old.ts', 10), edit('a2', 'src/old.ts', 10 + 601),
  ])
  assert.deepEqual(fileClashes(s), [{ path: 'src/auth.ts', agents: ['a1', 'a2'] }])
  assert.deepEqual(agentStats(s, 'a2', at(200))!.clashes, ['src/auth.ts'])
})

test('swarmTotals adds up the swarm', () => {
  const s = foldAll('s1', [
    start('a1', 'coder'),
    usage('a1', 10, { input: 1000, output: 500, cacheRead: 9000 }),
    usage('a1', 20, { output: 1000, cacheRead: 10000 }),
    start('a2', 'tester', 5),
    ev('message.sent', { to: 'tester', summary: 'go' }, { agent: 'a1', atSec: 21 }),
    ev('message.sent', { to: 'tester', summary: 'again' }, { agent: 'a1', atSec: 22 }),
    ev('message.sent', { to: 'ghost', summary: '?' }, { agent: 'a2', atSec: 23 }),
    ev('task.created', { id: 't1', title: 'x' }, { atSec: 24, src: 'mcp' }),
    ev('task.created', { id: 't2', title: 'y' }, { atSec: 24, src: 'mcp' }),
    ev('task.updated', { id: 't2', state: 'done' }, { atSec: 25, src: 'mcp' }),
  ])
  const t = swarmTotals(s, at(25))
  assert.equal(t.agents, 2) // coder and tester; the lead never acted and the ghost placeholder is not counted
  assert.equal(t.tokens, 21500)
  near(t.costUsd, 0.0208)
  assert.equal(t.costPartial, false)
  near(t.burnPerMin, 0.0208 / 5)
  assert.deepEqual(t.busiestLink, { from: 'a1', to: 'a2', count: 2 })
  assert.equal(t.mostExpensive, 'a1')
  assert.deepEqual(t.tasks, { pending: 1, active: 0, done: 1, failed: 0 })
  assert.equal(t.clashes, 0)
})

const toolStart = (id: string, atSec: number) => ev('agent.tool', { phase: 'start', tool: 'Bash', kind: 'bash', subject: 'sleep', isError: false }, { agent: id, atSec })
const toolEnd = (id: string, atSec: number, isError: boolean) => ev('agent.tool', { phase: 'end', tool: 'Bash', kind: 'bash', subject: 'npm test', isError }, { agent: id, atSec })

test('an open tool call stops counting as running once it is stale', () => {
  const s = foldAll('s1', [start('a1', 'coder'), toolStart('a1', 0)])
  assert.equal(STALE_TOOL_MS, 300_000)
  assert.equal(agentStats(s, 'a1', at(60))!.status, 'running')
  assert.equal(agentStats(s, 'a1', at(301))!.status, 'waiting')
})

test('an agent that has finished is not stuck', () => {
  const s = foldAll('s1', [start('a1', 'coder'), toolEnd('a1', 1, true), toolEnd('a1', 2, true), toolEnd('a1', 3, true), ev('agent.finished', { outcome: 'failed' }, { agent: 'a1', atSec: 4 })])
  assert.equal(agentStats(s, 'a1', at(5))!.stuck, false)
})

test('stuck needs exactly three failures in a row', () => {
  const run = (...evs: ReturnType<typeof toolEnd>[]) => agentStats(foldAll('s1', [start('a1', 'coder'), ...evs]), 'a1', at(10))!.stuck
  assert.equal(run(toolEnd('a1', 1, true), toolEnd('a1', 2, true)), false)
  assert.equal(run(toolEnd('a1', 1, true), toolEnd('a1', 2, true), toolEnd('a1', 3, true)), true)
  assert.equal(run(toolEnd('a1', 1, true), toolEnd('a1', 2, true), toolEnd('a1', 3, false), toolEnd('a1', 4, true)), false)
})

test('clashes: old ones drop when now is given, the 600 s boundary counts, and a precomputed list is used', () => {
  const two = (gap: number) => foldAll('s1', [start('a1', 'coder'), start('a2', 'tester'), edit('a1', 'f.ts', 10), edit('a2', 'f.ts', 10 + gap)])
  assert.equal(fileClashes(two(600)).length, 1)
  assert.equal(fileClashes(two(601)).length, 0)
  const s = two(5)
  assert.equal(fileClashes(s, at(3600)).length, 0)
  assert.equal(fileClashes(s, at(100)).length, 1)
  assert.equal(fileClashes(s).length, 1)
  assert.deepEqual(agentStats(s, 'a1', at(3600))!.clashes, [])
  assert.deepEqual(agentStats(s, 'a1', at(3600), [{ path: 'x.ts', agents: ['a1'] }])!.clashes, ['x.ts'])
  assert.equal(swarmTotals(s, at(100), []).clashes, 0)
  assert.equal(swarmTotals(s, at(100)).clashes, 1)
})

test('costPartial is true when one agent is unpriced', () => {
  const s = foldAll('s1', [start('a1', 'coder'), usage('a1', 1, { input: 10 }), start('a2', 'tester'),
    ev('agent.usage', { model: 'mystery', input: 5, output: 5, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, { agent: 'a2', atSec: 2 })])
  assert.equal(swarmTotals(s, at(3)).costPartial, true)
})

test('the burn rate ignores spend older than five minutes', () => {
  const s = foldAll('s1', [start('a1', 'coder'), usage('a1', 10, { output: 1000 })])
  assert.equal(swarmTotals(s, at(400)).burnPerMin, 0)
  assert.ok(swarmTotals(s, at(300)).burnPerMin > 0)
})

test('an empty swarm has no busiest link or most expensive agent', () => {
  const t = swarmTotals(foldAll('s1', []), at(1))
  assert.equal(t.busiestLink, null)
  assert.equal(t.mostExpensive, null)
  assert.equal(t.agents, 0)
})

test('agentStats is null for unknown ids, including inherited names', () => {
  assert.equal(agentStats(state(), 'nope', at(1)), null)
  assert.equal(agentStats(state(), 'toString', at(1)), null)
})

test('context fill is capped at 1', () => {
  const s = foldAll('s1', [start('a1', 'coder'), usage('a1', 1, { input: 50_000_000 })])
  assert.equal(agentStats(s, 'a1', at(2))!.contextFill, 1)
})

test('a resumed agent is running again and its lifetime adds up its runs', () => {
  const s = foldAll('s1', [
    start('a1', 'coder'),
    ev('agent.finished', { outcome: 'answer' }, { agent: 'a1', atSec: 11 }),
    usage('a1', 30, { output: 10 }),
  ])
  assert.equal(agentStats(s, 'a1', at(32))!.status, 'running')
  assert.equal(agentStats(s, 'a1', at(32))!.lifetimeMs, 11_000 + 2_000)
  assert.equal(agentStats(s, 'a1', at(60))!.status, 'waiting')
})

test('swarm totals carry session cost and context percent, null when unknown', () => {
  assert.equal(swarmTotals(foldAll('s1', []), at(1)).contextPercent, null)
  assert.equal(swarmTotals(foldAll('s1', []), at(1)).sessionCostUsd, null)
  const t = swarmTotals(foldAll('s1', [ev('session.measure', { contextTokens: 100_000, contextWindow: 400_000, costUsd: 2 }, { atSec: 1 })]), at(2))
  assert.equal(t.contextPercent, 25)
  assert.equal(t.sessionCostUsd, 2)
  const c = swarmTotals(foldAll('s1', [ev('session.measure', { contextWindow: 10, contextPercent: 999 }, { atSec: 1 })]), at(2))
  assert.equal(c.contextPercent, 100)
})
