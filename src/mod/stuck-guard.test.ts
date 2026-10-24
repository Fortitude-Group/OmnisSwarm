import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { KIT } from './test-engine.ts'

const SID = 'abcdef12-3456-7890-abcd-ef1234567890'
type Seen = {
  records: Array<{ type: string; agent?: string; data: Record<string, unknown> }>; sends: Array<{ to: unknown; text: string }>; readonly appends: string[]; fail: boolean; deliver: boolean
  /** omnis_handoff calls, what it answers, and how. `order` lists record types and 'handoff' as they reached the server. */
  handoffs: Array<{ agent: unknown; why: unknown }>; handoffReply: string; handoffMode: 'ok' | 'error' | 'throw' | 'hang'; order: string[]
}

function engine(on: On): Seen {
  const session = mock.session(on)
  const seen: Seen = {
    records: [], sends: [], fail: true, deliver: true, get appends() { return session.appended().map(row => JSON.stringify(row.message)) },
    handoffs: [], handoffReply: '{"notes":[]}', handoffMode: 'ok', order: [],
  }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SID }))
  on('state.get', () => ({ value: { value: undefined, version: 0 } }))
  on('state.set', () => ({ value: { isSet: true as const, version: 1 } }))
  on('agent.list', () => ({ value: [{ id: 'a1', name: 'coder-1', description: '', type: 'coder' }] as never }))
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'plugin:omnis-swarm:omnis-swarm' } }))
  on('mcp.call', (_$, e) => {
    if (e.tool === 'omnis_handoff') {
      seen.handoffs.push({ agent: (e.args as Record<string, unknown>).agent, why: (e.args as Record<string, unknown>).why })
      seen.order.push('handoff')
      if (seen.handoffMode === 'throw') throw new Error('Connection closed')
      if (seen.handoffMode === 'hang') return new Promise<never>(() => {})
      return { value: { content: [{ type: 'text', text: seen.handoffReply }], isError: seen.handoffMode === 'error' } }
    }
    const a = e.args as { type: string; agent?: string; data: Record<string, unknown> }
    seen.order.push(a.type)
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

// Stuck again and finished while stuck (spec 3.2 and 3.3)

const NUDGE = "Your last 5 tool calls failed. Step back and try another approach, or report to main what's blocking you."
const STOP = "You're still stuck. Stop here, and report to main what you tried and what's blocking you."
const MAIN_ONE = '[OmnisSwarm] coder-1 is stuck on t3 (failing). Its handoff note is in memory: handoff/t3. To hand it on, stop coder-1, then give t3 a new assignee and tell it to read handoff/t3 first.'
const ended = ($: Engine) => $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', agentId: 'a1', reason: 'answer' })
let tag = 0
/** `n` failed Bash calls, each a different command so the repeat pattern stays out of it. */
async function fails($: Engine, seen: Seen, n: number): Promise<void> {
  seen.fail = true
  tag++
  for (let i = 0; i < n; i++) await run($, 'Bash', { command: `try ${tag}-${i}` }, 'a1')
}
/** A call that works, which re-arms the failing pattern. */
async function works($: Engine, seen: Seen): Promise<void> {
  seen.fail = false
  await run($, 'Bash', { command: `fine ${++tag}` }, 'a1')
}
const lines = (seen: Seen, part: string) => seen.appends.filter(a => a.includes(part))

async function twice($: Engine, on: On, reply = '{"notes":["handoff/t3"]}', mode: Seen['handoffMode'] = 'ok') {
  const { clock, seen } = await boot($, on)
  seen.handoffReply = reply
  seen.handoffMode = mode
  await fails($, seen, 5)
  await works($, seen)
  await fails($, seen, 5)
  await clock.advance(2000)
  await clock.settle()
  return { clock, seen }
}

test('the second hit in a run sends the stop text, asks for the handoff after agent.stuck, and tells main', KIT, async ($, on) => {
  const { seen } = await twice($, on)
  expect(seen.sends.map(s => s.text)).toEqual([NUDGE, STOP])
  expect(seen.handoffs).toEqual([{ agent: 'a1', why: 'stuck' }])
  expect(seen.order.filter(o => o === 'agent.stuck' || o === 'handoff')).toEqual(['agent.stuck', 'agent.stuck', 'handoff'])
  expect(stuck(seen).map(r => r.data.count)).toEqual([5, 5])
  expect(lines(seen, 'is stuck on')).toHaveLength(1)
  expect(lines(seen, 'is stuck on t3')[0]).toContain(MAIN_ONE)
  expect(lines(seen, 'looks stuck')).toHaveLength(1)
})

test('a third hit in the same run is told to stop but writes no second note', KIT, async ($, on) => {
  const { clock, seen } = await twice($, on)
  await works($, seen)
  await fails($, seen, 5)
  await clock.settle()
  expect(seen.sends.map(s => s.text)).toEqual([NUDGE, STOP, STOP])
  expect(seen.handoffs).toHaveLength(1)
  expect(lines(seen, 'is stuck on')).toHaveLength(1)
})

test('the repeating pattern counts too, and the main text names it', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  seen.handoffReply = '{"notes":["handoff/t3"]}'
  await fails($, seen, 5)
  seen.fail = false
  for (let i = 0; i < 4; i++) await run($, 'Read', { file_path: 'src/a.ts' }, 'a1')
  await clock.settle()
  expect(seen.sends.map(s => s.text)).toEqual([NUDGE, "You're still stuck. Stop here, and report to main what you tried and what's blocking you."])
  expect(lines(seen, 'is stuck on t3 (repeating)')).toHaveLength(1)
  expect(seen.handoffs).toEqual([{ agent: 'a1', why: 'stuck' }])
})

test('a turn that ends while still stuck asks for a handoff with why finished', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  seen.handoffReply = '{"notes":["handoff/t3"]}'
  await fails($, seen, 5)
  await clock.settle()
  expect(seen.handoffs).toEqual([])
  await ended($)
  await clock.settle()
  expect(seen.handoffs).toEqual([{ agent: 'a1', why: 'finished' }])
  expect(lines(seen, 'finished while stuck on t3 (failing)')[0]).toContain(MAIN_ONE.replace('is stuck on', 'finished while stuck on'))
})

test('a turn that ends after the pattern re-armed, or that was never stuck, asks for nothing', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  seen.handoffReply = '{"notes":["handoff/t3"]}'
  await fails($, seen, 5)
  await works($, seen)
  await ended($)
  await run($, 'Bash', { command: 'again' }, 'a1')
  await ended($)
  await clock.settle()
  expect(seen.handoffs).toEqual([])
})

test('a turn that ends after the stuck-again handoff was taken asks for nothing more, and a new run starts over', KIT, async ($, on) => {
  const { clock, seen } = await twice($, on)
  await ended($)
  await clock.settle()
  expect(seen.handoffs).toHaveLength(1)
  await fails($, seen, 5)
  await clock.settle()
  expect(seen.sends.map(s => s.text)).toEqual([NUDGE, STOP, NUDGE])
  expect(seen.handoffs).toHaveLength(1)
})

test('with no open task the stuck-again line says so', KIT, async ($, on) => {
  const { seen } = await twice($, on, '{"notes":[]}')
  expect(lines(seen, '[OmnisSwarm] coder-1 is stuck (failing) and has no open task to hand on.')).toHaveLength(1)
})

test('with no open task a finished turn asks, and says nothing to main', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  seen.handoffReply = '{"notes":[]}'
  await fails($, seen, 5)
  await clock.settle()
  const before = seen.appends.length
  await ended($)
  await clock.settle()
  expect(seen.handoffs).toEqual([{ agent: 'a1', why: 'finished' }])
  expect(seen.appends.length).toBe(before)
})

test('several notes use the plural wording', KIT, async ($, on) => {
  const { seen } = await twice($, on, '{"notes":["handoff/t3","handoff/t5"]}')
  expect(lines(seen, 'is stuck on t3, t5 (failing). Its handoff notes are in memory: handoff/t3, handoff/t5. To hand them on, stop coder-1, then give each a new assignee and tell it to read its note first.')).toHaveLength(1)
})

/** The agent still hears the stop text, and main hears nothing more, however the handoff call goes wrong. */
async function failsOpen($: Engine, on: On, reply: string, mode: Seen['handoffMode']): Promise<void> {
  const { seen } = await twice($, on, reply, mode)
  expect(seen.sends.map(s => s.text)).toEqual([NUDGE, STOP])
  expect(seen.handoffs).toEqual([{ agent: 'a1', why: 'stuck' }])
  expect(lines(seen, 'is stuck on')).toEqual([])
  expect(lines(seen, 'no open task')).toEqual([])
}

test('a handoff error leaves the stop text sent and main told nothing more', KIT, ($, on) => failsOpen($, on, 'omnis_handoff failed', 'error'))
test('a handoff call that throws leaves the stop text sent and main told nothing more', KIT, ($, on) => failsOpen($, on, '', 'throw'))
test('a garbled handoff reply leaves the stop text sent and main told nothing more', KIT, ($, on) => failsOpen($, on, 'Output too large (61.2KB), saved to a file.', 'ok'))
test('a handoff reply slower than 2 s is given up on', KIT, ($, on) => failsOpen($, on, '{"notes":["handoff/t3"]}', 'hang'))
