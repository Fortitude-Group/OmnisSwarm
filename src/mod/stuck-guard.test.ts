import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { KIT } from './test-engine.ts'

const SID = 'abcdef12-3456-7890-abcd-ef1234567890'
type Seen = { records: Array<{ type: string; agent?: string; data: Record<string, unknown> }>; sends: Array<{ to: unknown; text: string }>; readonly appends: string[]; fail: boolean; deliver: boolean }

function engine(on: On): Seen {
  const session = mock.session(on)
  const seen: Seen = { records: [], sends: [], fail: true, deliver: true, get appends() { return session.appended().map(row => JSON.stringify(row.message)) } }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SID }))
  on('state.get', () => ({ value: { value: undefined, version: 0 } }))
  on('state.set', () => ({ value: { isSet: true as const, version: 1 } }))
  on('agent.list', () => ({ value: [{ id: 'a1', name: 'coder-1', description: '', type: 'coder' }] as never }))
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'plugin:omnis-swarm:omnis-swarm' } }))
  on('mcp.call', (_$, e) => {
    const a = e.args as { type: string; agent?: string; data: Record<string, unknown> }
    seen.records.push({ type: a.type, ...(a.agent !== undefined && { agent: a.agent }), data: a.data })
    return { value: { content: [{ type: 'text', text: 'ok s1' }], isError: false } }
  })
  on('session.send', (_$, e) => {
    seen.sends.push({ to: e.to, text: e.text })
    return seen.deliver ? { isDelivered: true } : { isDelivered: false, reason: 'No agent is reachable' }
  })
  on('tool.call', () => (seen.fail ? { isError: true as const, result: 'x', text: 'x' } : { result: { content: 'x' } as never, text: 'x' }))
  on('turn.complete', () => ({ text: '' }))
  return seen
}

async function boot($: Engine, on: On) {
  const clock = mock.clock(on, { now: Date.parse('2026-10-23T10:00:00.000Z') })
  const seen = engine(on)
  await $.session.start({ cwd: '/p', surface: null, isInteractive: false })
  await clock.settle()
  return { clock, seen }
}

let n = 0
const run = ($: Engine, tool: string, args: Record<string, unknown>, agentId?: string) =>
  $.tool.call({ tool, tool_use_id: `toolu_${++n}`, ...args, ...(agentId !== undefined && { agentId }) } as never)
const stuck = (seen: Seen) => seen.records.filter(r => r.type === 'agent.stuck')

test('five failures in a row: one nudge, a line to main and agent.stuck', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  for (let i = 0; i < 6; i++) await run($, 'Bash', { command: `try ${i}` }, 'a1')
  await clock.settle()
  expect(seen.sends).toEqual([{ to: 'a1', text: "Your last 5 tool calls failed. Step back and try another approach, or report to main what's blocking you." }])
  expect(seen.appends.some(a => a.includes('[OmnisSwarm] coder-1 looks stuck (failing) and was asked to step back.'))).toBe(true)
  expect(stuck(seen)).toEqual([{ type: 'agent.stuck', agent: 'a1', data: { pattern: 'failing', count: 5, subject: 'try 4', delivered: true } }])
})

test('the same read four times with no edit: a repeating nudge, once, until an edit re-arms it', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  seen.fail = false
  for (let i = 0; i < 5; i++) await run($, 'Read', { file_path: 'src/a.ts' }, 'a1')
  await clock.settle()
  expect(seen.sends.map(s => s.text)).toEqual(["You've run Read on src/a.ts 4 times with no change in between. Step back and try another approach, or report to main."])
  await run($, 'Edit', { file_path: 'src/a.ts' }, 'a1')
  for (let i = 0; i < 4; i++) await run($, 'Read', { file_path: 'src/a.ts' }, 'a1')
  await clock.settle()
  expect(seen.sends.length).toBe(2)
})

test('a nudge that is not delivered says so to main and in the event', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  seen.deliver = false
  for (let i = 0; i < 5; i++) await run($, 'Bash', { command: `x${i}` }, 'a1')
  await clock.settle()
  expect(seen.appends.some(a => a.includes('The message was not delivered: No agent is reachable.'))).toBe(true)
  expect(stuck(seen)[0]!.data).toEqual({ pattern: 'failing', count: 5, subject: 'x4', delivered: false, reason: 'No agent is reachable' })
})

test('the lead and internal tools are never nudged, and a finished agent starts over', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  for (let i = 0; i < 6; i++) await run($, 'Bash', { command: 'x' })
  for (let i = 0; i < 6; i++) await run($, 'mcp__plugin_omnis-swarm_omnis-swarm__omnis_record', {}, 'a1')
  for (let i = 0; i < 4; i++) await run($, 'Bash', { command: `x${i}` }, 'a1')
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', agentId: 'a1', reason: 'answer' })
  await run($, 'Bash', { command: 'x' }, 'a1')
  await clock.settle()
  expect(seen.sends).toEqual([])
})

test('five refused edits in a row: one failing nudge, as a refused edit re-arms nothing', KIT, async ($, on) => {
  on('session.cwd', () => ({ value: '/p' }))
  on('tool.check', { tool: 'Edit' }, () => ({ decision: 'deny' as const, reason: 'coder-2 is editing src/a.ts.' }))
  const { clock, seen } = await boot($, on)
  seen.fail = false
  for (let i = 0; i < 6; i++) await run($, 'Edit', { file_path: 'src/a.ts' }, 'a1')
  await clock.settle()
  expect(seen.sends.map(s => s.text)).toEqual(["Your last 5 tool calls failed. Step back and try another approach, or report to main what's blocking you."])
  expect(stuck(seen)).toEqual([{ type: 'agent.stuck', agent: 'a1', data: { pattern: 'failing', count: 5, subject: 'src/a.ts', delivered: true } }])
})
