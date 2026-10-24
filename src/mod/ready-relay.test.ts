import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { KIT } from './test-engine.ts'

const SID = 'abcdef12-3456-7890-abcd-ef1234567890'
const T0 = Date.parse('2026-10-24T10:00:00.000Z')
const TASK_UPDATE = 'mcp__plugin_omnis-swarm_omnis-swarm__omnis_task_update'
const READY = 'Now ready: t4 Build the parser (dev-3), t5 Write the docs (no assignee).'

type Seen = { reply: { text: string; isError?: boolean }; readonly appends: string[] }

function engine(on: On): Seen {
  const session = mock.session(on)
  const seen: Seen = { reply: { text: '' }, get appends() { return session.appended().map(row => JSON.stringify(row.message)) } }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SID }))
  on('session.cwd', () => ({ value: '/p' }))
  on('agent.list', () => ({ value: [{ id: 'a1', name: 'coder-1', description: '', type: 'coder' }] as never }))
  // The gate guard asks the server what a close would run; here it runs nothing.
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'plugin:omnis-swarm:omnis-swarm' } }))
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: '{"run":false}' }], isError: false } }))
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', () => ({ result: { content: 'ok' } as never, text: seen.reply.text, ...(seen.reply.isError === true && { isError: true as const }) }) as never)
  return seen
}

async function boot($: Engine, on: On) {
  const clock = mock.clock(on, { now: T0 })
  const seen = engine(on)
  await $.session.start({ cwd: '/p', surface: null, isInteractive: false })
  await clock.settle()
  return { clock, seen }
}

let n = 0
const closeAs = ($: Engine, agentId: string | undefined, tool = TASK_UPDATE) =>
  $.tool.call({ tool, tool_use_id: `toolu_${++n}`, id: 't3', state: 'done', ...(agentId !== undefined && { agentId }) } as never)

test('a subagent closing a task has its Now ready line relayed to main with the exact text', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  seen.reply = { text: `Task t3 is now done.\n${READY}` }
  const result = await closeAs($, 'a1')
  await clock.settle()
  expect(result.text).toBe(`Task t3 is now done.\n${READY}`)
  expect(seen.appends.length).toBe(1)
  expect(JSON.parse(seen.appends[0]!).content).toEqual([{ type: 'text', text: `[OmnisSwarm] coder-1 closed t3. ${READY}` }])
})

test('the relay works under any server alias', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  seen.reply = { text: `Task t3 is now done.\n${READY}` }
  await closeAs($, 'a1', 'mcp__omnis-swarm__omnis_task_update')
  await clock.settle()
  expect(seen.appends.length).toBe(1)
})

test('main closing a task is not relayed, because it saw the reply itself', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  seen.reply = { text: `Task t3 is now done.\n${READY}` }
  await closeAs($, undefined)
  await clock.settle()
  expect(seen.appends).toEqual([])
})

test('a reply without the line is not relayed', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  seen.reply = { text: 'Task t3 is now done.' }
  await closeAs($, 'a1')
  await clock.settle()
  expect(seen.appends).toEqual([])
})

test('an error result is not relayed, even if its text has the line', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  seen.reply = { text: `Gate failed.\n${READY}`, isError: true }
  await closeAs($, 'a1')
  await clock.settle()
  expect(seen.appends).toEqual([])
})

test('other tools are not relayed', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  seen.reply = { text: `Task t4 created.\n${READY}` }
  await closeAs($, 'a1', 'mcp__plugin_omnis-swarm_omnis-swarm__omnis_task_create')
  await clock.settle()
  expect(seen.appends).toEqual([])
})
