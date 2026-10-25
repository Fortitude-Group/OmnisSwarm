import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldAll } from '../../src/core/fold.ts'
import { isClean, parseRow, rowLine, rowsFromState, type HistoryRow } from '../../src/core/history.ts'
import type { SwarmEvent } from '../../src/core/events.ts'
import { at, ev } from '../helpers.ts'

const P = '0123456789abcdef'
const usage = (agent: string, model: string, atSec: number) =>
  ev('agent.usage', { model, input: 1000, output: 500, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, { agent, atSec })
const started = (agent: string, role: string, atSec = 1) => ev('agent.started', { name: agent, role, description: 'do the thing', parent: 'lead' }, { agent, atSec })
const finished = (agent: string, outcome: 'answer' | 'failed' | 'aborted', atSec: number) => ev('agent.finished', { outcome }, { agent, atSec })
const swarm = (events: SwarmEvent[]) => foldAll('s1', [ev('swarm.started', { name: 's1', topology: 'hierarchical', implicit: false }, { src: 'mcp' }), ...events])

test('a finished subagent gives one row with its role, answering model, cost, minutes and finish time', () => {
  const s = swarm([started('dev-1', 'omnis-developer'), usage('dev-1', 'claude-sonnet-5-5', 2), finished('dev-1', 'answer', 181)])
  const [row, ...rest] = rowsFromState(s, P)
  assert.equal(rest.length, 0)
  assert.equal(row!.id, 's1/dev-1')
  assert.equal(row!.role, 'omnis-developer')
  assert.equal(row!.model, 'claude-sonnet-5-5')
  assert.equal(row!.clean, true)
  assert.equal(row!.at, new Date(at(181)).toISOString())
  assert.equal(row!.project, P)
  assert.equal(row!.v, 1)
  assert.equal(typeof row!.minutes, 'number')
  assert.equal(Math.round(row!.costUsd * 100), row!.costUsd * 100)
  assert.equal(JSON.stringify(row).includes('do the thing'), false)
})

test('the lead, unfinished agents and agents with no usage get no row', () => {
  const s = swarm([
    started('dev-1', 'omnis-developer'), usage('dev-1', 'claude-opus-5-5', 2),
    started('dev-2', 'omnis-developer'), finished('dev-2', 'answer', 5),
    usage('lead', 'claude-opus-5-5', 3),
  ])
  assert.deepEqual(rowsFromState(s, P), [])
})

test('a bad project key gives no rows', () => {
  const s = swarm([started('dev-1', 'omnis-developer'), usage('dev-1', 'claude-opus-5-5', 2), finished('dev-1', 'answer', 5)])
  assert.deepEqual(rowsFromState(s, 'nothex'), [])
})

test('a plugin agent type with colons is a valid role', () => {
  const s = swarm([started('x', 'searchfit-seo:seo-auditor:AGENT'), usage('x', 'claude-haiku-5-5', 2), finished('x', 'answer', 5)])
  assert.equal(rowsFromState(s, P)[0]!.role, 'searchfit-seo:seo-auditor:AGENT')
})

test('clean needs an answer: failed and aborted are not clean', () => {
  for (const outcome of ['failed', 'aborted'] as const) {
    const s = swarm([started('dev-1', 'r'), usage('dev-1', 'claude-opus-5-5', 2), finished('dev-1', outcome, 5)])
    assert.equal(rowsFromState(s, P)[0]!.clean, false, outcome)
  }
})

test('an agent the stuck guard nudged is not clean', () => {
  const s = swarm([started('dev-1', 'r'), usage('dev-1', 'claude-opus-5-5', 2),
    ev('agent.stuck', { pattern: 'failing', count: 3, subject: 'npm test', delivered: true }, { agent: 'dev-1', atSec: 3, src: 'recorder' }),
    finished('dev-1', 'answer', 5)])
  assert.equal(rowsFromState(s, P)[0]!.clean, false)
})

test('an agent asked to wrap up by the time-box or its budget is not clean', () => {
  for (const limit of ['time', 'agentCost'] as const) {
    const s = swarm([started('dev-1', 'r'), usage('dev-1', 'claude-opus-5-5', 2),
      ev('guard.nudged', { limit, value: 40, threshold: 30, delivered: true }, { agent: 'dev-1', atSec: 3, src: 'recorder' }),
      finished('dev-1', 'answer', 5)])
    assert.equal(rowsFromState(s, P)[0]!.clean, false, limit)
  }
})

test('every task the agent held must end done with its gate passed, none or not run', () => {
  const base = (extra: SwarmEvent[]) => swarm([started('dev-1', 'r'), usage('dev-1', 'claude-opus-5-5', 2),
    ev('task.created', { id: 't1', title: 'a', assignee: 'dev-1' }, { src: 'mcp', atSec: 1 }), ...extra, finished('dev-1', 'answer', 9)])
  const done = ev('task.updated', { id: 't1', state: 'done' }, { src: 'mcp', atSec: 6 })
  const gate = (result: 'passed' | 'failed' | 'none' | 'skipped') => ev('gate.ran', { task: 't1', result, ms: 10, mode: 'block' }, { src: 'mcp', atSec: 5 })
  assert.equal(rowsFromState(base([done]), P)[0]!.clean, true)
  assert.equal(rowsFromState(base([gate('passed'), done]), P)[0]!.clean, true)
  assert.equal(rowsFromState(base([gate('none'), done]), P)[0]!.clean, true)
  assert.equal(rowsFromState(base([gate('failed'), done]), P)[0]!.clean, false)
  assert.equal(rowsFromState(base([gate('skipped'), done]), P)[0]!.clean, false)
  assert.equal(rowsFromState(base([]), P)[0]!.clean, false)
})

test('isClean is exported and agrees with the row', () => {
  const s = swarm([started('dev-1', 'r'), usage('dev-1', 'claude-opus-5-5', 2), finished('dev-1', 'answer', 5)])
  assert.equal(isClean(s, s.agents['dev-1']!), true)
})

const good: HistoryRow = { v: 1, id: 's1/dev-1', role: 'omnis-developer', model: 'claude-sonnet-5-5', clean: true, costUsd: 0.41, minutes: 6, at: '2026-10-25T10:00:00.000Z', project: P }

test('rowLine and parseRow round-trip a row', () => {
  const line = rowLine(good)
  assert.ok(line.endsWith('\n'))
  assert.deepEqual(parseRow(line.trim()), good)
})

test('parseRow refuses bad JSON, wrong version and bad fields, and drops extra fields', () => {
  assert.equal(parseRow('{'), null)
  assert.equal(parseRow('[]'), null)
  for (const patch of [{ v: 2 }, { id: '' }, { id: 'x'.repeat(131) }, { role: 'has space' }, { model: 'a/b' }, { clean: 'yes' },
    { costUsd: -1 }, { costUsd: Number.MAX_VALUE }, { minutes: 'six' }, { at: 'never' }, { project: 'ABC' }]) {
    assert.equal(parseRow(JSON.stringify({ ...good, ...patch })), null, JSON.stringify(patch))
  }
  assert.deepEqual(parseRow(JSON.stringify({ ...good, prompt: 'secret' })), good)
})
