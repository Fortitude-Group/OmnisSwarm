import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { KIT, never } from './test-engine.ts'

const T0 = Date.parse('2026-10-24T10:00:00.000Z')
const UPDATE = 'mcp__plugin_omnis-swarm_omnis-swarm__omnis_task_update'
const DENIED = 'The gate command is not allowed by your permission rules: npm test. Allow it, or set the gateCommand setting.'
const FAILED = 'Could not check permission for the gate. Try again, or mark it done with skipGate and a note.'
const DIGEST = 'ab'.repeat(32)
const PLAN = { run: true, id: 't1', dir: '/p/wt', command: 'npm test', digest: DIGEST }
const APPROVAL = { id: 't1', dir: '/p/wt', command: 'npm test', digest: DIGEST }

type Reply = 'ok' | 'error' | 'throw' | 'hang' | 'garbage'
type Seen = {
  plan: Reply | 'none' | 'disconnected'; approve: Reply; bash: 'allow' | 'ask' | 'deny'; beneath: 'allow' | 'ask' | 'deny'
  /** The settings rule the Bash verdict names; undefined when a mode or the tool's own check decided. */
  rule: string | undefined
  planCalls: Array<Record<string, unknown>>; approvals: Array<Record<string, unknown>>; bashChecks: unknown[]
}

/** How the stub server answers one call. */
async function answer(how: Reply, ok: string) {
  if (how === 'hang') await never()
  if (how === 'throw') throw new Error('Connection closed')
  const text = how === 'garbage' ? 'Output too large' : how === 'error' ? 'No swarm is running.' : ok
  return { value: { content: [{ type: 'text', text }], isError: how === 'error' } }
}

// Nothing sits beneath the plugin in a test: these hooks stand for the engine, its rules and the server.
function engine(on: On): Seen {
  const seen: Seen = { plan: 'ok', approve: 'ok', bash: 'allow', beneath: 'allow', rule: 'Bash(npm test)', planCalls: [], approvals: [], bashChecks: [] }
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
    if (e.tool === 'omnis_gate_plan') {
      seen.planCalls.push(e.args)
      if (seen.plan === 'none') return answer('ok', '{"run":false}')
      return answer(seen.plan === 'disconnected' ? 'ok' : seen.plan, JSON.stringify(PLAN))
    }
    if (e.tool === 'omnis_gate_approve') {
      seen.approvals.push(e.args)
      return answer(seen.approve, 'approved')
    }
    return { value: { content: [{ type: 'text', text: 'ok' }], isError: false } }
  })
  on('tool.check', (_$, e) => {
    if (e.tool !== 'Bash') return { decision: seen.beneath }
    seen.bashChecks.push(e.input)
    return { decision: seen.bash, ...(seen.rule !== undefined && { rule: seen.rule }) }
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

test('an allow that names no rule (a mode, a sandbox, a tool check) becomes an ask, and is approved', KIT, async ($, on) => {
  const { seen } = await boot($, on)
  seen.rule = undefined
  const verdict = await done($)
  expect(verdict.decision).toBe('ask')
  expect(verdict.reason).toBe('OmnisSwarm will run the verification gate: npm test in /p/wt')
  expect(seen.approvals).toEqual([APPROVAL])
})

test('when the rest of the chain refuses the call, nothing is approved', KIT, async ($, on) => {
  const { seen } = await boot($, on)
  seen.beneath = 'deny'
  expect((await done($)).decision).toBe('deny')
  seen.bash = 'ask'
  expect((await done($)).decision).toBe('deny')
  expect(seen.approvals).toEqual([])
})

test('a gate an explicit Bash allow rule allows is approved, and the call goes on to its own verdict', KIT, async ($, on) => {
  const { seen } = await boot($, on)
  expect((await done($)).decision).toBe('allow')
  expect(seen.planCalls).toEqual([{ id: 't1' }])
  expect(seen.bashChecks).toEqual([{ command: 'npm test', description: 'OmnisSwarm verification gate in /p/wt' }])
  expect(seen.approvals).toEqual([APPROVAL])
  seen.beneath = 'ask'
  expect((await done($)).decision).toBe('ask')
})

test('a gate the Bash rules deny is refused with the command named, and not approved', KIT, async ($, on) => {
  const { seen } = await boot($, on)
  seen.bash = 'deny'
  expect(await done($)).toEqual({ decision: 'deny', reason: DENIED })
  expect(seen.approvals).toEqual([])
})

test('a gate the Bash rules would ask about is approved and asks for this call, naming the command and folder', KIT, async ($, on) => {
  const { seen } = await boot($, on)
  seen.bash = 'ask'
  const verdict = await done($)
  expect(verdict.decision).toBe('ask')
  expect(verdict.reason).toBe('OmnisSwarm will run the verification gate: npm test in /p/wt')
  expect(seen.approvals).toEqual([APPROVAL])
})

test('when the plan says nothing would run, the call goes on with no Bash check and no approval', KIT, async ($, on) => {
  const { seen } = await boot($, on)
  seen.plan = 'none'
  seen.bash = 'deny'
  expect((await done($)).decision).toBe('allow')
  expect(seen.bashChecks).toEqual([])
  expect(seen.approvals).toEqual([])
})

test('a plan that fails, throws, is unreadable or has no server fails closed', KIT, async ($, on) => {
  const { seen } = await boot($, on)
  for (const plan of ['error', 'throw', 'garbage', 'disconnected'] as const) {
    seen.plan = plan
    expect(await done($)).toEqual({ decision: 'deny', reason: FAILED })
  }
  expect(seen.bashChecks).toEqual([])
  expect(seen.approvals).toEqual([])
})

test('an approval that fails or throws fails closed', KIT, async ($, on) => {
  const { seen } = await boot($, on)
  for (const approve of ['error', 'throw'] as const) {
    seen.approve = approve
    expect(await done($)).toEqual({ decision: 'deny', reason: FAILED })
  }
  seen.bash = 'ask'
  expect(await done($)).toEqual({ decision: 'deny', reason: FAILED })
})

test('a plan slower than 2 s fails closed', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  seen.plan = 'hang'
  const pending = done($)
  await clock.advance(1999)
  await clock.advance(1)
  expect(await pending).toEqual({ decision: 'deny', reason: FAILED })
})

test('an approval slower than 2 s fails closed', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  seen.approve = 'hang'
  const pending = done($)
  await clock.advance(2000)
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
