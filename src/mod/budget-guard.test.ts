import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// The kit loads the plugin's own register.ts (recorder and budget guard included); a test's userConfig goes in its options.

const LOADED = { timeoutMs: 60000 }
const SID = 'abcdef12-3456-7890-abcd-ef1234567890'
const T0 = Date.parse('2026-10-22T10:00:00.000Z')
type Seen = { records: Array<{ type: string; agent?: string; data: Record<string, unknown> }>; toasts: string[]; sends: Array<{ to: unknown; text: string }>; appends: string[]; deliver: boolean }

function engine(on: On): Seen {
  // The kit stores a plugin's appends itself; mock.session is the test's one session.append hook.
  const session = mock.session(on)
  const seen: Seen = {
    records: [], toasts: [], sends: [], deliver: true,
    get appends() { return session.appended().map(row => JSON.stringify(row.message)) },
  }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SID }))
  on('state.get', () => ({ value: { value: undefined, version: 0 } }))
  on('state.set', () => ({ value: { isSet: true as const, version: 1 } }))
  on('agent.list', () => ({ value: [] }))
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'plugin:omnis-swarm:omnis-swarm' } }))
  on('mcp.call', (_$, e) => {
    const a = e.args as { type: string; agent?: string; data: Record<string, unknown> }
    seen.records.push({ type: a.type, ...(a.agent !== undefined && { agent: a.agent }), data: a.data })
    return { value: { content: [{ type: 'text', text: 'ok s1' }], isError: false } }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(String(e.text))
    return { value: undefined }
  })
  on('session.send', (_$, e) => {
    seen.sends.push({ to: e.to, text: e.text })
    return seen.deliver ? { isDelivered: true } : { isDelivered: false, reason: 'No agent is reachable' }
  })
  on('tool.check', () => ({ decision: 'allow' }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a1' }))
  return seen
}

async function boot($: Engine, on: On) {
  const clock = mock.clock(on, { now: T0 })
  const seen = engine(on)
  await $.session.start({ cwd: '/p', surface: null, isInteractive: false })
  await clock.settle()
  await $.agent.spawn({
    tool_use_id: 'toolu_1', name: 'coder-b', subagentType: 'coder', description: 'x', prompt: 'p',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false,
  })
  await clock.settle()
  return { clock, seen }
}

// session.send hooks see the recipient as SendMessage spells it, so { agentId: 'a1' } arrives as 'a1'.
// The timer ticks every 15 s from the spawn, so the stages fire on the 20:00 and 30:00 ticks exactly.
test('20 minutes in: guard.warned and a toast; 30 minutes: a nudge, a copy to main and guard.nudged', LOADED, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await clock.advance(21 * 60_000)
  await clock.settle()
  expect(seen.records.filter(r => r.type === 'guard.warned')).toEqual([{ type: 'guard.warned', agent: 'a1', data: { limit: 'time', value: 20, threshold: 20 } }])
  expect(seen.toasts).toContain('coder-b: 20 min, past its 20 min time-box')
  await clock.advance(10 * 60_000)
  await clock.settle()
  expect(seen.sends).toEqual([{ to: 'a1', text: "You're past your time-box (30 min / $5). Wrap up what you have, report to main, and stop." }])
  expect(seen.appends[0]).toContain('[OmnisSwarm budget guard] coder-b passed its 30 min time-box')
  expect(seen.records.find(r => r.type === 'guard.nudged')!.data).toEqual({ limit: 'time', value: 30, threshold: 30, delivered: true })
})

test('a nudge that is not delivered is recorded with its reason and not retried', LOADED, async ($, on) => {
  const { clock, seen } = await boot($, on)
  seen.deliver = false
  await clock.advance(31 * 60_000)
  await clock.settle()
  await clock.advance(5 * 60_000)
  await clock.settle()
  expect(seen.sends.length).toBe(1)
  expect(seen.records.find(r => r.type === 'guard.nudged')!.data).toEqual({ limit: 'time', value: 30, threshold: 30, delivered: false, reason: 'No agent is reachable' })
})

test('past the swarm budget the lead may not spawn; a subagent, other tools and a raised budget may', LOADED, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await $.session.measure({ context: { window: 1 }, cost: { usd: 21 }, changed: ['cost'] } as never)
  await clock.settle()
  expect(seen.records.some(r => r.type === 'guard.blocked')).toBe(true)
  const lead = await $.tool.check({ tool: 'Agent', input: {}, tool_use_id: 't1' })
  expect(lead.decision).toBe('deny')
  expect(lead.reason).toBe('Swarm budget $20 reached. Raise it with /omnis budget <usd> or finish with the agents you have.')
  expect((await $.tool.check({ tool: 'Agent', input: {}, tool_use_id: 't2', agentId: 'a1' })).decision).toBe('allow')
  expect((await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 't3' })).decision).toBe('allow')
})

test('a limit from userConfig is used', { ...LOADED, options: { budgetAgentMinutes: 9 } }, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await clock.advance(7 * 60_000)
  await clock.settle()
  expect(seen.records.find(r => r.type === 'guard.warned')!.data).toEqual({ limit: 'time', value: 6, threshold: 6 })
})

test('no running agent, no timer', LOADED, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = engine(on)
  await $.session.start({ cwd: '/p', surface: null, isInteractive: false })
  await clock.advance(60 * 60_000)
  await clock.settle()
  expect(seen.records.filter(r => r.type.startsWith('guard.'))).toEqual([])
})
