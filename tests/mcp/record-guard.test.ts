import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRecordTools } from '../../src/mcp/tools/record.ts'
import { Session } from '../../src/mcp/session.ts'
import { swarmLogPath } from '../../src/core/log.ts'
import { tmpRoot } from '../helpers.ts'

const SID = 'abcdef12-3456-7890-abcd-ef1234567890'
const NOW = new Date('2026-10-22T10:00:00.000Z')
const tool = (root: string) => createRecordTools({ root, session: new Session(root), now: () => NOW })[0]!
const call = (root: string, body: Record<string, unknown>) => tool(root).handler({ sessionId: SID, ts: NOW.toISOString(), ...body })

test('omnis_record answers ok and the swarm the event landed in', () => {
  const root = tmpRoot()
  const out = call(root, { type: 'budget.set', data: { swarmUsd: 30 } })
  assert.match(out.text, /^ok session-[a-z0-9]{8}$/)
  const swarm = out.text.slice(3)
  const line = JSON.parse(readFileSync(swarmLogPath(root, swarm), 'utf8').trim().split('\n').at(-1)!)
  assert.deepEqual(line.data, { swarmUsd: 30 })
})

test('guard events are rebuilt from known fields', () => {
  const root = tmpRoot()
  call(root, { type: 'guard.nudged', agent: 'a1', data: { limit: 'time', value: 31, threshold: 30, delivered: false, reason: 'gone', extra: 'x' } })
  call(root, { type: 'guard.blocked', data: { value: 20.5, threshold: 20 } })
})

for (const [label, body] of [
  ['budget.set with no keys', { type: 'budget.set', data: {} }],
  ['budget.set past its ceiling', { type: 'budget.set', data: { agentMinutes: 1441 } }],
  ['budget.set with zero', { type: 'budget.set', data: { swarmUsd: 0 } }],
  ['a warned time limit with no agent', { type: 'guard.warned', data: { limit: 'time', value: 21, threshold: 20 } }],
  ['a warned swarm limit with an agent', { type: 'guard.warned', agent: 'a1', data: { limit: 'swarmCost', value: 11, threshold: 10 } }],
  ['a nudge on the swarm limit', { type: 'guard.nudged', agent: 'a1', data: { limit: 'swarmCost', value: 1, threshold: 1, delivered: true } }],
  ['a nudge with no delivered flag', { type: 'guard.nudged', agent: 'a1', data: { limit: 'time', value: 31, threshold: 30 } }],
  ['a blocked event with an agent', { type: 'guard.blocked', agent: 'a1', data: { value: 21, threshold: 20 } }],
  ['an infinite value', { type: 'guard.blocked', data: { value: 1e400, threshold: 20 } }],
  ['a reason with a newline', { type: 'guard.nudged', agent: 'a1', data: { limit: 'time', value: 31, threshold: 30, delivered: false, reason: 'a\nb' } }],
] as const) {
  test(`omnis_record refuses ${label}`, () => {
    assert.throws(() => call(tmpRoot(), body as unknown as Record<string, unknown>), { name: 'InputError' })
  })
}
