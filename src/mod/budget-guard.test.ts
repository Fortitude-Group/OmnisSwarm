import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { RUN } from './test-engine.ts'

// The kit loads the plugin's own register.ts (recorder and budget guard included); a test's userConfig goes in its options.
// A test's own import of budget-guard.ts is a separate copy, so limits are raised here through omnis_swarm_init's
// budget, a hook the loaded guard sees. Re-arming within one swarm is covered by tests/core/budget.test.ts.

const LOADED = { timeoutMs: 60000 }
const SID = 'abcdef12-3456-7890-abcd-ef1234567890'
const T0 = Date.parse('2026-10-22T10:00:00.000Z')
type Seen = { records: Array<{ type: string; agent?: string; data: Record<string, unknown> }>; toasts: string[]; sends: Array<{ to: unknown; text: string }>; appends: string[]; deliver: boolean; output: number; reply: 'started' | 'renamed' | 'other'; hold: Promise<void> | null }

function engine(on: On): Seen {
  // The kit stores a plugin's appends itself; mock.session is the test's one session.append hook.
  const session = mock.session(on)
  const seen: Seen = {
    records: [], toasts: [], sends: [], deliver: true, output: 0, reply: 'started', hold: null,
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
  on('session.send', async (_$, e) => {
    seen.sends.push({ to: e.to, text: e.text })
    if (seen.hold !== null) await seen.hold
    return seen.deliver ? { isDelivered: true } : { isDelivered: false, reason: 'No agent is reachable' }
  })
  on('tool.check', () => ({ decision: 'allow' }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a1' }))
  // omnis_swarm_init answers as the server does: a new swarm, a name for the running implicit one, or (other) wording the guard does not know.
  on('tool.call', (_$, e) => ({
    result: { content: 'ok' } as never,
    ...(String(e.tool).endsWith('__omnis_swarm_init') && {
      text: { started: 'Swarm "auth" started as auth (hierarchical).', renamed: 'Swarm "auth" (hierarchical) now names the running session swarm s1.', other: 'Swarm auth is ready.' }[seen.reply],
    }),
  }))
  // One model step whose usage is seen.output output tokens (claude-opus-5-5: $20 a million, so 150,000 is $3).
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const,
      usage: { input_tokens: 0, output_tokens: seen.output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' },
    }
  })
  return seen
}

/** Runs a stream to its end and answers what it returns. */
async function drain<R>(stream: AsyncGenerator<unknown, R>): Promise<R> {
  let next = await stream.next()
  while (next.done !== true) next = await stream.next()
  return next.value
}

/** A model step of agent a1's that spends `output` tokens. */
async function step($: Engine, output: number, seen: Seen): Promise<void> {
  seen.output = output
  await drain($.turn.step({ turnId: `t${output}`, index: 0, model: 'claude-opus-5-5', messageCount: 1, agentId: 'a1' }))
}

/** The session's running cost, as Claude Code reports it. */
const measure = ($: Engine, usd: number) => $.session.measure({ context: { window: 1 }, cost: { usd }, changed: ['cost'] } as never)

const leadSpawn = ($: Engine, id: string) => $.tool.check({ tool: 'Agent', input: {}, tool_use_id: id })

/** A successful omnis_swarm_init call carrying a budget: the next swarm's limits. */
const swarmInit = ($: Engine, budget: Record<string, number>) =>
  $.tool.call({ tool: 'mcp__plugin_omnis-swarm_omnis-swarm__omnis_swarm_init', tool_use_id: 'toolu_init', topology: 'hierarchical', budget } as never)

/**
 * A time stage's data: the threshold exactly, the value at most one 15 s tick (0.25 min) past it. The recorder stamps
 * events in real time and the guard maps them onto the mock clock at bind, so a slow kit call can push a stage one tick on.
 */
function expectTimeStage(data: Record<string, unknown> | undefined, threshold: number, rest: Record<string, unknown> = {}): void {
  const { value, ...others } = data ?? {}
  expect(others).toEqual({ limit: 'time', threshold, ...rest })
  expect(typeof value === 'number' && value >= threshold && value < threshold + 0.26).toBe(true)
}

const dataOf = (seen: Seen, type: string, limit?: string) => seen.records.find(r => r.type === type && (limit === undefined || r.data.limit === limit))?.data

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
// The timer ticks every 15 s from the spawn, so the stages fire on the 20:00 and 30:00 ticks (one tick later on a slow kit).
test('20 minutes in: guard.warned and a toast; 30 minutes: a nudge, a copy to main and guard.nudged', LOADED, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await clock.advance(21 * 60_000)
  await clock.settle()
  const warned = seen.records.filter(r => r.type === 'guard.warned')
  expect(warned.length).toBe(1)
  expect(warned[0]!.agent).toBe('a1')
  expectTimeStage(warned[0]!.data, 20)
  expect(seen.toasts).toContain('coder-b: 20 min, past its 20 min time-box')
  await clock.advance(10 * 60_000)
  await clock.settle()
  expect(seen.sends).toEqual([{ to: 'a1', text: "You're past your time-box (30 min / $5). Wrap up what you have, report to main, and stop." }])
  expect(seen.appends[0]).toContain('[OmnisSwarm budget guard] coder-b passed its 30 min time-box')
  expectTimeStage(dataOf(seen, 'guard.nudged'), 30, { delivered: true })
})

test('a nudge that is not delivered is recorded with its reason and not retried', LOADED, async ($, on) => {
  const { clock, seen } = await boot($, on)
  seen.deliver = false
  await clock.advance(31 * 60_000)
  await clock.settle()
  await clock.advance(5 * 60_000)
  await clock.settle()
  expect(seen.sends.length).toBe(1)
  expectTimeStage(dataOf(seen, 'guard.nudged'), 30, { delivered: false, reason: 'No agent is reachable' })
  expect(seen.appends[0]).toContain('The message was not delivered: No agent is reachable.')
})

test('past the swarm budget the lead may not spawn; a subagent, other tools and a raised budget may', LOADED, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await measure($, 21)
  await clock.settle()
  expect(dataOf(seen, 'guard.blocked')).toEqual({ value: 21, threshold: 20 })
  const lead = await leadSpawn($, 't1')
  expect(lead.decision).toBe('deny')
  expect(lead.reason).toBe('Swarm budget $20 reached. Raise it with /omnis budget <usd> or finish with the agents you have.')
  expect((await $.tool.check({ tool: 'Agent', input: {}, tool_use_id: 't2', agentId: 'a1' })).decision).toBe('allow')
  expect((await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 't3' })).decision).toBe('allow')
  // A $30 budget: the new swarm starts from the $21 already spent, so $20 more is past the default but allowed.
  await swarmInit($, { swarmUsd: 30 })
  await clock.settle()
  await measure($, 41)
  await clock.settle()
  expect((await leadSpawn($, 't4')).decision).toBe('allow')
  await measure($, 52)
  await clock.settle()
  const again = await leadSpawn($, 't5')
  expect(again.decision).toBe('deny')
  expect(again.reason).toBe('Swarm budget $30 reached. Raise it with /omnis budget <usd> or finish with the agents you have.')
})

test('a limit from userConfig is used', { ...LOADED, options: { budgetAgentMinutes: 9 } }, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await clock.advance(7 * 60_000)
  await clock.settle()
  expectTimeStage(dataOf(seen, 'guard.warned'), 6)
})

test('no running agent, no timer', LOADED, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = engine(on)
  await $.session.start({ cwd: '/p', surface: null, isInteractive: false })
  await clock.advance(60 * 60_000)
  await clock.settle()
  expect(seen.records.filter(r => r.type.startsWith('guard.'))).toEqual([])
})

test('the swarm warns at half its budget, and a raised budget moves the warn and the block', LOADED, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await measure($, 11)
  await clock.settle()
  expect(seen.records.filter(r => r.type === 'guard.warned')).toEqual([{ type: 'guard.warned', data: { limit: 'swarmCost', value: 11, threshold: 10 } }])
  expect(seen.toasts).toContain('Swarm ≈$11.00, past its $10 warning')
  // $40 from the next swarm on: it warns at $20 and blocks at $40, counted from the $11 spent before it.
  await swarmInit($, { swarmUsd: 40 })
  await clock.settle()
  await measure($, 36)
  await clock.settle()
  expect(seen.records.filter(r => r.type === 'guard.warned').map(r => r.data)).toEqual([
    { limit: 'swarmCost', value: 11, threshold: 10 }, { limit: 'swarmCost', value: 25, threshold: 20 },
  ])
  expect((await leadSpawn($, 't1')).decision).toBe('allow')
  await measure($, 52)
  await clock.settle()
  expect(seen.records.filter(r => r.type === 'guard.blocked').map(r => r.data)).toEqual([{ value: 41, threshold: 40 }])
  expect((await leadSpawn($, 't2')).decision).toBe('deny')
})

test('renaming the running swarm keeps its agents timed and its cost, and applies the budget', LOADED, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await measure($, 12)
  await clock.settle()
  seen.reply = 'renamed'
  await swarmInit($, { swarmUsd: 30 })
  await clock.settle()
  // Still the swarm that began at $0: $31 is past the new $30 budget.
  await measure($, 31)
  await clock.settle()
  expect(seen.records.filter(r => r.type === 'guard.blocked').map(r => r.data)).toEqual([{ value: 31, threshold: 30 }])
  expect((await leadSpawn($, 't1')).decision).toBe('deny')
  // coder-b is still running, so its time-box still warns.
  await clock.advance(21 * 60_000)
  await clock.settle()
  expectTimeStage(dataOf(seen, 'guard.warned', 'time'), 20)
})

test('an init reply in unknown wording keeps the swarm and still applies its budget', LOADED, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await measure($, 12)
  await clock.settle()
  seen.reply = 'other'
  await swarmInit($, { swarmUsd: 30 })
  await clock.settle()
  await measure($, 31)
  await clock.settle()
  expect(seen.records.filter(r => r.type === 'guard.blocked').map(r => r.data)).toEqual([{ value: 31, threshold: 30 }])
  expect((await leadSpawn($, 't1')).decision).toBe('deny')
})

test('a nudge answered after omnis_swarm_end is not recorded, so no swarm is started for it', LOADED, async ($, on) => {
  const { clock, seen } = await boot($, on)
  let release = (): void => undefined
  seen.hold = new Promise(resolve => { release = resolve })
  await clock.advance(31 * 60_000)
  await clock.settle()
  expect(seen.sends.length).toBe(1)
  await $.tool.call({ tool: 'mcp__plugin_omnis-swarm_omnis-swarm__omnis_swarm_end', tool_use_id: 'toolu_end' } as never)
  await clock.settle()
  release()
  await clock.settle()
  expect(seen.records.filter(r => r.type === 'guard.nudged')).toEqual([])
  expect(seen.appends[0]).toContain('[OmnisSwarm budget guard] coder-b passed its 30 min time-box')
})

test('omnis_swarm_end lets the block go', LOADED, async ($, on) => {
  const { clock } = await boot($, on)
  await measure($, 21)
  await clock.settle()
  expect((await leadSpawn($, 't1')).decision).toBe('deny')
  await $.tool.call({ tool: 'mcp__plugin_omnis-swarm_omnis-swarm__omnis_swarm_end', tool_use_id: 'toolu_end' } as never)
  await clock.settle()
  expect((await leadSpawn($, 't2')).decision).toBe('allow')
})

test("an omnis_swarm_init budget is the next swarm's limit", LOADED, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = engine(on)
  await $.session.start({ cwd: '/p', surface: null, isInteractive: false })
  await clock.settle()
  await swarmInit($, { agentMinutes: 60 })
  await clock.settle()
  await $.agent.spawn({
    tool_use_id: 'toolu_1', name: 'coder-b', subagentType: 'coder', description: 'x', prompt: 'p',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false,
  })
  await clock.settle()
  await clock.advance(21 * 60_000)
  await clock.settle()
  expect(dataOf(seen, 'guard.warned')).toBeUndefined()
  await clock.advance(20 * 60_000)
  await clock.settle()
  expectTimeStage(dataOf(seen, 'guard.warned'), 40)
})

test("an agent's estimated spend warns at $3 and nudges at $5", LOADED, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await step($, 150_000, seen)
  await clock.settle()
  expect(seen.records.filter(r => r.type === 'guard.warned')).toEqual([{ type: 'guard.warned', agent: 'a1', data: { limit: 'agentCost', value: 3, threshold: 3 } }])
  expect(seen.toasts).toContain('coder-b: ≈$3.00, past its $3 warning')
  expect(seen.sends).toEqual([])
  await step($, 100_000, seen)
  await clock.settle()
  expect(seen.sends.length).toBe(1)
  expect(dataOf(seen, 'guard.nudged')).toEqual({ limit: 'agentCost', value: 5, threshold: 5, delivered: true })
  expect(seen.appends[0]).toContain('[OmnisSwarm budget guard] coder-b passed its $5 budget')
})

const omnis = ($: Engine, args: string) => $.command.run({ command: 'omnis', args, ...RUN }).then(r => r.text)

test('/omnis budget 30 is recorded, lifts the block, and the guard blocks again at the new limit', LOADED, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await measure($, 21)
  await clock.settle()
  expect((await leadSpawn($, 't8')).decision).toBe('deny')
  expect(await omnis($, 'budget 30')).toBe('Swarm budget set to $30. New agents: allowed.')
  await clock.settle()
  expect(seen.records.filter(r => r.type === 'budget.set').map(r => r.data)).toEqual([{ swarmUsd: 30 }])
  expect((await leadSpawn($, 't9')).decision).toBe('allow')
  await measure($, 31)
  await clock.settle()
  expect(seen.records.filter(r => r.type === 'guard.blocked').map(r => r.data)).toEqual([{ value: 21, threshold: 20 }, { value: 31, threshold: 30 }])
  expect((await leadSpawn($, 't10')).decision).toBe('deny')
})

test('/omnis budget with no swarm running waits for the next swarm, shows it, and records it when the swarm begins', LOADED, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = engine(on)
  await $.session.start({ cwd: '/p', surface: null, isInteractive: false })
  await clock.settle()
  expect(await omnis($, 'budget 30')).toBe('No swarm is running. The swarm budget will be $30 for the next swarm.')
  expect(await omnis($, 'budget')).toContain("New agents: allowed. Next swarm's budget: $30.")
  expect(seen.records.filter(r => r.type === 'budget.set')).toEqual([])
  await measure($, 25)
  await clock.settle()
  expect(seen.records.filter(r => r.type === 'budget.set').map(r => r.data)).toEqual([{ swarmUsd: 30 }])
  expect((await leadSpawn($, 't1')).decision).toBe('allow')
  expect(await omnis($, 'budget')).toContain('swarm $30 (warns at $15). Swarm so far ≈$25.00.')
})

/** A measurement as a subscription reports it: its 5-hour and 7-day windows come with the cost. */
const planMeasure = ($: Engine, usd: number, fiveHour = 34) =>
  $.session.measure({ context: { window: 1 }, cost: { usd }, rateLimits: [{ kind: 'five_hour', percentUsed: fiveHour }, { kind: 'seven_day', percentUsed: 8 }], changed: ['cost', 'rateLimits'] } as never)

test('on a subscription the dollar limits are off: no swarm warning or block, costs still shown, the time-box still nudges', LOADED, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await planMeasure($, 21)
  await clock.settle()
  await planMeasure($, 60, 41.5)
  await clock.settle()
  expect(seen.records.filter(r => r.type === 'guard.blocked' || r.type === 'guard.warned')).toEqual([])
  expect((await leadSpawn($, 't1')).decision).toBe('allow')
  expect(await omnis($, 'budget')).toBe(
    'Budget: on a subscription, so no dollar limits (costs are shown for reference). Each agent 30 min (warns at 20 min). Swarm so far ≈$60.00. 5-hour window 41.5% used. New agents: allowed.')
  expect(await omnis($, 'budget 30')).toBe("Saved $30 as the swarm budget, but you're on a subscription, so dollar limits are off. Set billing to api in /config to enforce it.")
  await clock.advance(31 * 60_000)
  await clock.settle()
  expect(seen.sends).toEqual([{ to: 'a1', text: "You're past your time-box (30 min). Wrap up what you have, report to main, and stop." }])
})

test('an agent on a subscription spending past $5 is not nudged for it', LOADED, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await planMeasure($, 1)
  await clock.settle()
  await step($, 300_000, seen)
  await clock.settle()
  expect(seen.records.filter(r => r.type === 'guard.warned' || r.type === 'guard.nudged')).toEqual([])
  expect(seen.sends).toEqual([])
})

test('billing api keeps the dollar limits on even when a subscription window is reported', { ...LOADED, options: { billing: 'api' } }, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await planMeasure($, 21)
  await clock.settle()
  expect(dataOf(seen, 'guard.blocked')).toEqual({ value: 21, threshold: 20 })
  expect((await leadSpawn($, 't1')).decision).toBe('deny')
})

test('billing subscription turns the dollar limits off before any window is reported', { ...LOADED, options: { billing: 'subscription' } }, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await measure($, 21)
  await clock.settle()
  expect(seen.records.filter(r => r.type === 'guard.blocked')).toEqual([])
  expect((await leadSpawn($, 't1')).decision).toBe('allow')
  expect(await omnis($, 'budget')).toContain('on a subscription, so no dollar limits')
})
