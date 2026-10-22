// tests/mcp/init-budget.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createTools } from '../../src/mcp/tools.ts'
import { Session } from '../../src/mcp/session.ts'
import { createRecordTools } from '../../src/mcp/tools/record.ts'
import { swarmLogPath } from '../../src/core/log.ts'
import { tmpRoot } from '../helpers.ts'

const init = (root: string) => createTools({ root, session: new Session(root) }).find(t => t.name === 'omnis_swarm_init')!

test('omnis_swarm_init with a budget writes budget.set after swarm.started', () => {
  const root = tmpRoot()
  init(root).handler({ name: 'auth', topology: 'mesh', budget: { swarmUsd: 40, agentMinutes: 45 } })
  const lines = readFileSync(swarmLogPath(root, 'auth'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.deepEqual(lines.map(l => l.type), ['swarm.started', 'budget.set'])
  assert.deepEqual(lines[1].data, { agentMinutes: 45, swarmUsd: 40 })
  assert.equal(lines[1].src, 'mcp')
})

test('omnis_swarm_init refuses a bad budget before writing anything', () => {
  const root = tmpRoot()
  assert.throws(() => init(root).handler({ name: 'x', topology: 'mesh', budget: { swarmUsd: 0 } }), { name: 'InputError' })
  assert.throws(() => init(root).handler({ name: 'x', topology: 'mesh', budget: { tokens: 5 } }), { name: 'InputError' })
  assert.equal(existsSync(swarmLogPath(root, 'x')), false)
})

test('naming an implicit session swarm with a budget writes swarm.started then budget.set', () => {
  const root = tmpRoot()
  const session = new Session(root)
  const clock = () => new Date('2026-10-21T10:00:05.000Z')
  const [record] = createRecordTools({ root, session, now: clock })
  const sid = 'abcdef12-3456-7890-abcd-ef1234567890'
  record!.handler({ sessionId: sid, ts: '2026-10-21T10:00:01.234Z', type: 'agent.tool', agent: 'lead', data: { phase: 'start', tool: 'Bash', kind: 'bash', subject: 'npm test', isError: false } })
  const tool = createTools({ root, session, now: clock }).find(t => t.name === 'omnis_swarm_init')!
  const text = tool.handler({ name: 'auth', topology: 'mesh', budget: { agentUsd: 2 } }).text
  const id = /session swarm (\S+)\./.exec(text)![1]!
  const lines = readFileSync(swarmLogPath(root, id), 'utf8').trim().split(/\r?\n/).map(l => JSON.parse(l))
  const types = lines.map(l => l.type)
  const started = types.lastIndexOf('swarm.started')
  assert.equal(types[started + 1], 'budget.set')
  assert.equal(types.length, started + 2)
  assert.deepEqual(lines[started + 1].data, { agentUsd: 2 })
})

test('the schema lists the budget object', () => {
  const schema = init(tmpRoot()).inputSchema as { properties: Record<string, { properties?: Record<string, unknown> }> }
  assert.deepEqual(Object.keys(schema.properties.budget!.properties!), ['agentMinutes', 'agentUsd', 'swarmUsd'])
})
