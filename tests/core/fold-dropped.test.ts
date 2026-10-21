import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { EventData } from '../../src/core/events.ts'
import { emptyState, fold } from '../../src/core/fold.ts'
import { ev } from '../helpers.ts'

const tool = (dropped: unknown): EventData['agent.tool'] =>
  ({ phase: 'start', tool: 'Bash', kind: 'bash', subject: 'ls', isError: false, dropped }) as EventData['agent.tool']

test('a recorder event carrying dropped adds it to gaps', () => {
  const state = emptyState('s1')
  fold(state, ev('agent.tool', tool(3), { agent: 'lead' }))
  fold(state, ev('agent.tool', tool(2), { agent: 'lead', atSec: 1 }))
  assert.equal(state.gaps, 5)
  assert.equal(state.agents.lead?.tools.bash, 2)
})

test('dropped is ignored from other writers and when it is not a positive number', () => {
  const state = emptyState('s1')
  fold(state, ev('agent.tool', tool(4), { agent: 'lead', src: 'mcp' }))
  for (const bad of [-1, 0, Number.NaN, '7', null]) fold(state, ev('agent.tool', tool(bad), { agent: 'lead' }))
  fold(state, ev('agent.tool', { phase: 'end', tool: 'Bash', kind: 'bash', subject: 'ls', isError: false }, { agent: 'lead' }))
  assert.equal(state.gaps, 0)
})
