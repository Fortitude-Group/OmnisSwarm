import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { KIT, never } from './test-engine.ts'

const T0 = Date.parse('2026-10-24T10:00:00.000Z')
const UPDATE = 'mcp__plugin_omnis-swarm_omnis-swarm__omnis_task_update'
const DENIED = 'The gate command is not allowed by your permission rules: npm test. Allow it, or set the gateCommand setting.'
const FAILED = 'Could not check permission for the gate. Try again, or mark it done with skipGate and a note.'
const RUN_PLAN = JSON.stringify({ run: true, command: 'npm test', dir: '/p/wt' })

type Plan = 'run' | 'none' | 'error' | 'throw' | 'hang' | 'garbage' | 'disconnected'
type Seen = { plan: Plan; bash: 'allow' | 'ask' | 'deny'; beneath: 'allow' | 'ask' | 'deny'; planCalls: Array<Record<string, unknown>>; bashChecks: unknown[] }

// Nothing sits beneath the plugin in a test: these hooks stand for the engine, its rules and the server.
function engine(on: On): Seen {
  const seen: Seen = { plan: 'run', bash: 'allow', beneath: 'allow', planCalls: [], bashChecks: [] }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'abcdef12-3456-7890-abcd-ef1234567890' }))
  on('session.cwd', () => ({ value: '/p' }))
  on('state.get', () => ({ value: { value: undefined, version: 0 } }))
  on('state.set', () => ({ value: { isSet: true as const, version: 1 } }))
  on('agent.list', () => ({ value: [] }))
  on('mcp.connect', () => ({
    value: seen.plan === 'disconnected' ? { isConnected: false, reason: 'unlisted', message: 'not listed' } : { isConnected: true, server: 'plugin:omnis-swarm:omnis-swarm' },
  }) as never)
  on('mcp.call', async (_$, e) => {
    if (e.tool !== 'omnis_gate_plan') return { value: { content: [{ type: 'text', text: 'ok' }], isError: false } }
    seen.planCalls.push(e.args)
    if (seen.plan === 'hang') await never()
    if (seen.plan === 'throw') throw new Error('Connection closed')
    const text = seen.plan === 'none' ? '{"run":false}' : seen.plan === 'garbage' ? 'Output too large' : seen.plan === 'error' ? 'No swarm is running.' : RUN_PLAN
    return { value: { content: [{ type: 'text', text }], isError: seen.plan === 'error' } }
  })
  on('tool.check', (_$, e) => {
    if (e.tool !== 'Bash') return { decision: seen.beneath }
    seen.bashChecks.push(e.input)
    return { decision: seen.bash }
  })
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
const done = ($: Engine, input: Record<string, unknown> = {}, tool = UPDATE) =>
  $.tool.check({ tool, input: { id: 't1', state: 'done', ...input }, tool_use_id: `toolu_${++n}` } as never)

test('a gate the Bash rules allow lets the call through to its own verdict', KIT, async ($, on) => {
  const { seen } = await boot($, on)
  expect((await done($)).decision).toBe('allow')
  expect(seen.bashChecks).toEqual([{ command: 'npm test', description: 'OmnisSwarm verification gate' }])
  expect(seen.planCalls).toEqual([{ id: 't1' }])
  seen.beneath = 'ask'
  expect((await done($)).decision).toBe('ask')
})

test('a gate the Bash rules deny is refused with the command named', KIT, async ($, on) => {
  const { seen } = await boot($, on)
  seen.bash = 'deny'
  expect(await done($)).toEqual({ decision: 'deny', reason: DENIED })
})

test('a gate the Bash rules would ask about asks for this call, naming the command and folder', KIT, async ($, on) => {
  const { seen } = await boot($, on)
  seen.bash = 'ask'
  const verdict = await done($)
  expect(verdict.decision).toBe('ask')
  expect(verdict.reason).toBe('OmnisSwarm will run the verification gate: npm test in /p/wt')
})

test('when the plan says nothing would run, the call goes on without a Bash check', KIT, async ($, on) => {
  const { seen } = await boot($, on)
  seen.plan = 'none'
  seen.bash = 'deny'
  expect((await done($)).decision).toBe('allow')
  expect(seen.bashChecks).toEqual([])
})

test('a plan that fails, throws, is unreadable or has no server fails closed', KIT, async ($, on) => {
  const { seen } = await boot($, on)
  for (const plan of ['error', 'throw', 'garbage', 'disconnected'] as const) {
    seen.plan = plan
    expect(await done($)).toEqual({ decision: 'deny', reason: FAILED })
  }
  expect(seen.bashChecks).toEqual([])
})

test('a plan slower than 2 s fails closed', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  seen.plan = 'hang'
  const pending = done($)
  await clock.advance(1999)
  await clock.advance(1)
  expect(await pending).toEqual({ decision: 'deny', reason: FAILED })
})

test('only done without skipGate is checked; the worktree goes to the plan; any server alias counts', KIT, async ($, on) => {
  const { seen } = await boot($, on)
  seen.bash = 'deny'
  expect((await done($, { state: 'active' })).decision).toBe('allow')
  expect((await done($, { skipGate: true, note: 'flaky' })).decision).toBe('allow')
  expect((await done($, {}, 'mcp__plugin_omnis-swarm_omnis-swarm__omnis_task_create')).decision).toBe('allow')
  expect(seen.planCalls).toEqual([])
  expect((await done($, { worktree: '/p/wt' }, 'mcp__omnis-swarm__omnis_task_update')).decision).toBe('deny')
  expect(seen.planCalls).toEqual([{ id: 't1', worktree: '/p/wt' }])
})
