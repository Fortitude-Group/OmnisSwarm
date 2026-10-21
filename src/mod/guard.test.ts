import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const RECORD = 'mcp__plugin_omnis-swarm_omnis-swarm__omnis_record'
const FEED = 'mcp__plugin_omnis-swarm_omnis-swarm__omnis_feed'
const BARE_RECORD = 'mcp__omnis-swarm__omnis_record'

// Nothing sits beneath the plugin in a test: these hooks stand for the engine.
function engine(on: On): void {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.describe', (_$, e) => ({ description: e.description }))
}

test('the model is refused both internal tools', async ($, on) => {
  engine(on)
  for (const tool of [RECORD, FEED, BARE_RECORD]) {
    const verdict = await $.tool.check({ tool, input: {} })
    expect(verdict.decision).toBe('deny')
    expect(verdict.reason).toContain('internal to the omnis-swarm plugin')
  }
})

test('every other tool, our public ones included, is left to the engine', async ($, on) => {
  engine(on)
  expect((await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })).decision).toBe('allow')
  expect((await $.tool.check({ tool: 'mcp__plugin_omnis-swarm_omnis-swarm__omnis_swarm_status', input: {} })).decision).toBe('allow')
})

test('another plugin is refused too', {
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

test('internal tools wait behind ToolSearch, described as internal; others keep their description', async ($, on) => {
  engine(on)
  const internal = await $.tool.describe({ tool: RECORD, description: 'raw', provider: { plugin: 'mcp:omnis-swarm', tier: 'user' } })
  expect(internal.isDeferred).toBe(true)
  expect(internal.description).toContain('Internal to the omnis-swarm plugin')
  const other = await $.tool.describe({ tool: 'Bash', description: 'Runs a command', provider: { plugin: 'engine', tier: 'core' } })
  expect(other).toEqual({ description: 'Runs a command' })
})

// The fail-closed .catch cannot be driven from here: the kit only accepts plain data, so no event can make the
// guard's own check throw, and the host's validate report ("gating hook with .catch: tool.check") is the check on it.
