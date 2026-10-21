import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentInfo, On } from 'claude-code'

const SID = 'abcdef12-3456-7890-abcd-ef1234567890'
const SERVER = 'plugin:omnis-swarm:omnis-swarm'
type Sent = { sessionId: string; ts: string; type: string; agent?: string; data: Record<string, unknown>; dropped?: number }
type Options = { connected?: boolean; failCalls?: number; throwCalls?: boolean; noSessionId?: boolean; agents?: AgentInfo[] }

// Nothing sits beneath the plugin in a test: these hooks stand for the engine and the MCP server.
function engine(on: On, opts: Options = {}): Sent[] {
  const sent: Sent[] = []
  let failures = opts.failCalls ?? 0
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => {
    if (opts.noSessionId === true) throw new Error('no session')
    return { value: SID }
  })
  on('mcp.connect', () => ({
    value: opts.connected === false ? { isConnected: false, reason: 'unlisted', message: 'not listed' } : { isConnected: true, server: SERVER },
  }))
  on('mcp.call', (_$, e) => {
    if (e.server === SERVER && e.tool === 'omnis_record') sent.push(e.args as Sent)
    if (opts.throwCalls === true) throw new Error('Connection closed')
    if (failures > 0) {
      failures--
      return { value: { content: [{ type: 'text', text: 'Connection closed' }], isError: true } }
    }
    return { value: { content: [{ type: 'text', text: 'ok' }], isError: false } }
  })
  on('agent.list', () => ({ value: opts.agents ?? [] }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a1' }))
  on('tool.call', () => ({ result: { stdout: 'ok' } as never }))
  on('turn.complete', () => ({ text: '' }))
  on('session.send', (_$, e) => (e.to === 'nobody' ? { isDelivered: false, reason: 'No agent named nobody' } : { isDelivered: true }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const,
      usage: e.index === 9 ? null : { input_tokens: 2, output_tokens: 210, cache_read_input_tokens: 5, cache_creation_input_tokens: 42374, model: 'claude-opus-5-5' },
    }
  })
  return sent
}

const start = ($: Engine) => $.session.start({ cwd: '/project', surface: null, isInteractive: false })

async function spawnWorker($: Engine): Promise<void> {
  await $.agent.spawn({
    tool_use_id: 'toolu_1', prompt: 'Find the docs and report back', description: 'Find the docs', subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false, name: 'probe-worker',
  })
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) {
    // only the hooks matter here
  }
}

/**
 * A tool call as a subagent's loop raises it. The kit passes agentId through to the plugin's hooks at
 * run time, but its type for the test's own call leaves it out (an engine call site sets it), hence the cast.
 */
const fromAgent = <T extends object>(call: T, agentId: string): T => ({ ...call, agentId }) as T

test('a lead tool call is recorded at start and end, stamped with the session and a time', async ($, on) => {
  const sent = engine(on)
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(sent).toEqual([
    { sessionId: SID, ts: expect.any(String), type: 'agent.tool', agent: 'lead', data: { phase: 'start', tool: 'Bash', kind: 'bash', subject: 'npm test', isError: false } },
    { sessionId: SID, ts: expect.any(String), type: 'agent.tool', agent: 'lead', data: { phase: 'end', tool: 'Bash', kind: 'bash', subject: 'npm test', isError: false } },
  ])
  expect(new Date(sent[0]!.ts).toISOString()).toBe(sent[0]!.ts)
})

test('a spawned agent is started once, and only agents seen spawning are recorded', async ($, on) => {
  const sent = engine(on)
  await start($)
  await spawnWorker($)
  await spawnWorker($)
  await $.tool.call(fromAgent({ tool: 'Read', file_path: '/project/README.md' }, 'a1'))
  await $.tool.call(fromAgent({ tool: 'Read', file_path: '/project/other.md' }, 'fork-unknown'))
  expect(sent.filter(s => s.type === 'agent.started')).toEqual([
    { sessionId: SID, ts: expect.any(String), type: 'agent.started', agent: 'a1', data: { name: 'probe-worker', role: 'general-purpose', description: 'Find the docs', parent: 'lead' } },
  ])
  const tools = sent.filter(s => s.type === 'agent.tool')
  expect(tools.map(s => s.agent)).toEqual(['a1', 'a1'])
  expect(tools[0]!.data.subject).toBe('/project/README.md')
})

test('a model step with usage is recorded for its agent, the lead included; a step without usage is not', async ($, on) => {
  const sent = engine(on)
  await start($)
  await spawnWorker($)
  await drain($.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1, agentId: 'a1' }))
  await drain($.turn.step({ turnId: 't2', index: 0, model: 'claude-opus-5-5', messageCount: 1 }))
  await drain($.turn.step({ turnId: 't3', index: 9, model: 'claude-opus-5-5', messageCount: 1 }))
  const usage = sent.filter(s => s.type === 'agent.usage')
  expect(usage.map(s => s.agent)).toEqual(['a1', 'lead'])
  expect(usage[0]!.data).toEqual({ model: 'claude-opus-5-5', input: 2, output: 210, cacheRead: 5, cacheWrite5m: 42374, cacheWrite1h: 0 })
})

test('a subagent turn end is recorded as agent.finished; the lead turn end is not', async ($, on) => {
  const sent = engine(on)
  await start($)
  await spawnWorker($)
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 't1', agentId: 'a1', reason: 'refusal', refusal: { category: 'cyber', explanation: null } })
  await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 't2', reason: 'answer' })
  expect(sent.filter(s => s.type === 'agent.finished')).toEqual([
    { sessionId: SID, ts: expect.any(String), type: 'agent.finished', agent: 'a1', data: { outcome: 'failed', reason: 'refusal' } },
  ])
})

test('delivered model messages are recorded from session.send; undelivered and plugin sends are not', async ($, on) => {
  const sent = engine(on)
  await start($)
  await spawnWorker($)
  await $.session.send({ to: 'main', text: 'hello from probe', origin: { kind: 'model' }, agentId: 'a1' })
  await $.session.send({ to: 'nobody', text: 'lost', origin: { kind: 'model' }, agentId: 'a1' })
  await $.session.send({ to: 'main', text: 'from a plugin', origin: { kind: 'plugin', name: 'other' } })
  expect(sent.filter(s => s.type === 'message.sent').map(s => [s.agent, s.data])).toEqual([['a1', { to: 'main', summary: 'hello from probe' }]])
})

test('a protocol SendMessage is recorded from the tool call, without its free text; a plain-text one is not', async ($, on) => {
  const sent = engine(on)
  await start($)
  await $.tool.call({ tool: 'SendMessage', to: 'probe-worker', message: { type: 'shutdown_response', request_id: 'r1', approve: false, reason: 'still busy' } })
  await $.tool.call({ tool: 'SendMessage', to: 'probe-worker', message: 'plain text', summary: 'hi' })
  expect(sent.filter(s => s.type === 'message.sent').map(s => s.data)).toEqual([{ to: 'probe-worker', summary: '[shutdown_response] approve: no' }])
  expect(JSON.stringify(sent)).not.toContain('still busy')
})

test('session.measure is recorded when context or cost changed', async ($, on) => {
  const sent = engine(on)
  await start($)
  await $.session.measure({ context: { tokens: 54378, window: 1000000, percent: 5 }, rateLimits: [], cost: { usd: 0.5079974 }, changed: ['context', 'cost'] })
  await $.session.measure({ context: { window: 1000000 }, rateLimits: [], changed: ['rateLimits'] })
  expect(sent.filter(s => s.type === 'session.measure')).toEqual([
    { sessionId: SID, ts: expect.any(String), type: 'session.measure', data: { contextWindow: 1000000, contextTokens: 54378, contextPercent: 5, costUsd: 0.5079974 } },
  ])
})

test("the recorder's own internal tool calls are not recorded", async ($, on) => {
  const sent = engine(on)
  await start($)
  await $.tool.call({ tool: 'mcp__plugin_omnis-swarm_omnis-swarm__omnis_record', sessionId: SID })
  await $.tool.call({ tool: 'mcp__plugin_omnis-swarm_omnis-swarm__omnis_feed', since: 0 })
  expect(sent).toEqual([])
})

test('results pass through unchanged when the server fails, and the loss rides on later events', async ($, on) => {
  const sent = engine(on, { failCalls: 2 })
  await start($)
  const first = await $.tool.call({ tool: 'Bash', command: 'ls' })
  const second = await $.tool.call({ tool: 'Bash', command: 'pwd' })
  await $.tool.call({ tool: 'Bash', command: 'whoami' })
  expect(first.result).toEqual({ stdout: 'ok' })
  expect(second.result).toEqual({ stdout: 'ok' })
  // The two failed calls settle asynchronously, so their count may ride on one later call or be split over two.
  expect(sent.slice(2).reduce((n, s) => n + (s.dropped ?? 0), 0)).toBe(2)
  expect(sent.slice(0, 2).some(s => s.dropped !== undefined)).toBe(false)
})

test('a server that rejects outright changes nothing for the session', async ($, on) => {
  engine(on, { throwCalls: true })
  await start($)
  const result = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(result.result).toEqual({ stdout: 'ok' })
})

test('with no server connection or no session id nothing is sent and the session is untouched', async ($, on) => {
  const sent = engine(on, { connected: false })
  expect((await start($)).cwd).toBe('/project')
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(sent).toEqual([])
})

test('a failing session id lookup leaves session.start unchanged and recording off', async ($, on) => {
  const sent = engine(on, { noSessionId: true })
  expect((await start($)).cwd).toBe('/project')
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(sent).toEqual([])
})

test('a second session.start sends nothing new, and agents running before it are recovered once', async ($, on) => {
  const sent = engine(on, { agents: [{ id: 'a7', description: 'Earlier task', type: 'Explore', status: 'running', name: 'scout' }] })
  await start($)
  await start($)
  expect(sent.filter(s => s.type === 'agent.started').map(s => [s.agent, s.data])).toEqual([
    ['a7', { name: 'scout', role: 'Explore', description: 'Earlier task', parent: 'lead' }],
  ])
  await $.tool.call(fromAgent({ tool: 'Grep', pattern: 'TODO' }, 'a7'))
  expect(sent.filter(s => s.type === 'agent.tool').map(s => s.agent)).toEqual(['a7', 'a7'])
})
