import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { registerGuard } from './guard.ts'
import { KIT } from './test-engine.ts'

const RECORD = 'mcp__plugin_omnis-swarm_omnis-swarm__omnis_record'
const FEED = 'mcp__plugin_omnis-swarm_omnis-swarm__omnis_feed'
const REPLAY = 'mcp__plugin_omnis-swarm_omnis-swarm__omnis_replay'
const EXPORT = 'mcp__plugin_omnis-swarm_omnis-swarm__omnis_export'
const REPORT = 'mcp__plugin_omnis-swarm_omnis-swarm__omnis_report'
const FENCE = 'mcp__plugin_omnis-swarm_omnis-swarm__omnis_fence'
const GATE_PLAN = 'mcp__plugin_omnis-swarm_omnis-swarm__omnis_gate_plan'
const APPROVE = 'mcp__plugin_omnis-swarm_omnis-swarm__omnis_gate_approve'
const HANDOFF = 'mcp__plugin_omnis-swarm_omnis-swarm__omnis_handoff'
const BARE_RECORD = 'mcp__omnis-swarm__omnis_record'

// Nothing sits beneath the plugin in a test: these hooks stand for the engine.
function engine(on: On): void {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.describe', (_$, e) => ({ description: e.description }))
}

test('the model is refused every internal tool', KIT, async ($, on) => {
  engine(on)
  for (const tool of [RECORD, FEED, REPLAY, EXPORT, REPORT, FENCE, GATE_PLAN, APPROVE, HANDOFF, BARE_RECORD, 'mcp__omnis-swarm__omnis_handoff', 'mcp__omnis-swarm__omnis_fence', 'mcp__omnis-swarm__omnis_gate_plan', 'mcp__omnis-swarm__omnis_gate_approve']) {
    const verdict = await $.tool.check({ tool, input: {} })
    expect(verdict.decision).toBe('deny')
    expect(verdict.reason).toContain('internal to the omnis-swarm plugin')
    expect(verdict.reason).toContain('omnis_fence')
    expect(verdict.reason).toContain('omnis_gate_plan')
    expect(verdict.reason).toContain('omnis_gate_approve')
    expect(verdict.reason).toContain('omnis_handoff')
  }
})

test('every other tool, our public ones included, is left to the engine', KIT, async ($, on) => {
  engine(on)
  expect((await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })).decision).toBe('allow')
  expect((await $.tool.check({ tool: 'mcp__plugin_omnis-swarm_omnis-swarm__omnis_swarm_status', input: {} })).decision).toBe('allow')
})

test('another plugin is refused too', {
  ...KIT,
  plugins: [{
    name: 'intruder',
    register(on) {
      on('session.start', async ($, e, next) => {
        const result = await next(e)
        const verdict = await $.tool.check({ tool: 'mcp__plugin_omnis-swarm_omnis-swarm__omnis_record', input: {} })
        $.ui.status(`verdict ${verdict.decision}`)
        return result
      })
    },
  }],
}, async ($, on) => {
  const statuses: string[] = []
  engine(on)
  on('ui.status', (_$, e) => {
    statuses.push(String(e.text))
    return { value: undefined }
  })
  await $.session.start({ cwd: '/project', surface: null, isInteractive: false })
  expect(statuses).toContain('verdict deny')
})

test('internal tools wait behind ToolSearch, described as internal; others keep their description', KIT, async ($, on) => {
  engine(on)
  for (const tool of [RECORD, FEED, BARE_RECORD]) {
    const internal = await $.tool.describe({ tool, description: 'raw', provider: { plugin: 'mcp:omnis-swarm', tier: 'user' } })
    expect(internal.isDeferred).toBe(true)
    expect(internal.description).toContain('Internal to the omnis-swarm plugin')
  }
  const other = await $.tool.describe({ tool: 'Bash', description: 'Runs a command', provider: { plugin: 'engine', tier: 'core' } })
  expect(other).toEqual({ description: 'Runs a command' })
})

// Plain-code tests of the hook itself: registerGuard against a fake `on` that records each hook and its .catch.
type Hook = (...args: any[]) => any
function capture(): { check: Hook; checkCatch: Hook } {
  const hooks: Record<string, Hook> = {}
  const catches: Record<string, Hook> = {}
  const fakeOn = ((name: string, hook: Hook) => {
    hooks[name] = hook
    return { catch: (handler: Hook) => { catches[name] = handler } }
  }) as unknown as On
  registerGuard(fakeOn)
  return { check: hooks['tool.check']!, checkCatch: catches['tool.check']! }
}
const allowNext = (plugin: string) => Object.assign(async () => ({ decision: 'allow' }), { origin: { plugin, tier: 'user' } })
const self$ = { plugin: { name: 'omnis-swarm' } }

test('the plugin own call is passed on, the engine call is denied', KIT, async () => {
  const { check } = capture()
  for (const tool of [RECORD, FEED, BARE_RECORD]) {
    expect((await check(self$, { tool, input: {} }, allowNext('omnis-swarm'))).decision).toBe('allow')
    expect((await check(self$, { tool, input: {} }, allowNext('engine'))).decision).toBe('deny')
  }
})

test('a throwing check fails closed for internal tools and open for the rest', KIT, async () => {
  const { check, checkCatch } = capture()
  const broken = { get plugin(): never { throw new Error('boom') } }
  for (const tool of [RECORD, FEED, BARE_RECORD]) {
    expect(() => check(broken, { tool, input: {} }, allowNext('engine'))).toThrow('boom')
    const verdict = await checkCatch(broken, { tool, input: {} }, allowNext('engine'))
    expect(verdict.decision).toBe('deny')
    expect(verdict.reason).toContain('internal to the omnis-swarm plugin')
  }
  expect((await checkCatch(broken, { tool: 'Bash', input: {} }, allowNext('engine'))).decision).toBe('allow')
})
