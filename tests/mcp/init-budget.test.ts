// tests/mcp/init-budget.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createTools } from '../../src/mcp/tools.ts'
import { Session } from '../../src/mcp/session.ts'
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
})

test('the schema lists the budget object', () => {
  const schema = init(tmpRoot()).inputSchema as { properties: Record<string, { properties?: Record<string, unknown> }> }
  assert.deepEqual(Object.keys(schema.properties.budget!.properties!), ['agentMinutes', 'agentUsd', 'swarmUsd'])
})
