import { expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'
import { agentLabel } from './agent-name.ts'
import { KIT } from './test-engine.ts'

const AGENTS = [
  { id: 'a1', name: 'coder-1', description: 'fix the parser', type: 'coder' },
  { id: 'a2', name: '', description: 'write the docs', type: 'writer' },
  { id: 'a3', name: '', description: '', type: 'agent' },
]

// The kit refuses a probe plugin that passes $ to an imported helper, so the helper runs against a stub of the one call it makes.
const engine = (list: () => Promise<unknown>) => ({ agent: { list } }) as unknown as EngineInterface

test('names an agent by name, then description, then id, and the lead as main', KIT, async () => {
  const $ = engine(async () => AGENTS)
  const labels = await Promise.all([null, 'a1', 'a2', 'a3', 'a9'].map(id => agentLabel($, id)))
  expect(labels.join('|')).toBe('main|coder-1|write the docs|a3|a9')
})

test('falls back to the id when the agent list cannot be read', KIT, async () => {
  const $ = engine(async () => { throw new Error('gone') })
  expect(await agentLabel($, 'a1')).toBe('a1')
  expect(await agentLabel($, null)).toBe('main')
})

test('control characters in a name never reach a message', KIT, async () => {
  const $ = engine(async () => [{ id: 'a1', name: 'a\u001b[31mb', description: '', type: 'coder' }])
  expect(await agentLabel($, 'a1')).toBe('a [31mb')
})
