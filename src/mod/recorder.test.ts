import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentInfo, On } from 'claude-code'

/** A kit call costs ~100 ms and many more when the machine is busy, so these tests get far more than the kit's 5 s. */
const LOADED = { timeoutMs: 60000 }

const SID = 'abcdef12-3456-7890-abcd-ef1234567890'
const SERVER = 'plugin:omnis-swarm:omnis-swarm'
type Sent = { sessionId: string; ts: string; type: string; agent?: string; data: Record<string, unknown>; dropped?: number }
type Write = { key: string; value: unknown }
type Options = {
  connected?: boolean; failCalls?: number; throwCalls?: boolean; noSessionId?: boolean; agents?: AgentInfo[]
  /** mcp.connect never answers. */
  hangConnect?: boolean
  /** Every omnis_record call waits for this before answering. */
  gate?: Promise<unknown>
  /** Every $.state write waits for this before landing. */
  stateGate?: Promise<unknown>
  /** What $.state holds when the plugin loads, as after a reload. */
  stored?: { seen?: string[]; dropped?: number }
  writes?: Write[]
}

// Nothing sits beneath the plugin in a test: these hooks stand for the engine and the MCP server.
function engine(on: On, opts: Options = {}): Sent[] {
  const sent: Sent[] = []
  let failures = opts.failCalls ?? 0
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => {
    if (opts.noSessionId === true) throw new Error('no session')
    return { value: SID }
  })
  on('state.get', (_$, e) => {
    const key = String(e.key)
    return { value: { value: key === 'seen' ? opts.stored?.seen : key === 'dropped' ? opts.stored?.dropped : undefined, version: 0 } }
  })
  on('state.set', async (_$, e) => {
    opts.writes?.push({ key: String(e.key), value: e.value })
    if (opts.stateGate !== undefined) await opts.stateGate
    return { value: { isSet: true as const, version: 1 } }
  })
  on('mcp.connect', () => (opts.hangConnect === true ? new Promise<never>(() => {}) : {
    value: opts.connected === false ? { isConnected: false, reason: 'unlisted', message: 'not listed' } : { isConnected: true, server: SERVER },
  }))
  on('mcp.call', async (_$, e) => {
    if (e.server === SERVER && e.tool === 'omnis_record') sent.push(e.args as Sent)
    if (opts.gate !== undefined) await opts.gate
    if (opts.throwCalls === true) throw new Error('Connection closed')
    if (failures > 0) {
      failures--
      return { value: { content: [{ type: 'text', text: 'Connection closed' }], isError: true } }
    }
    return { value: { content: [{ type: 'text', text: 'ok' }], isError: false } }
  })
  listed = 0
  on('agent.list', () => {
    listed++
    return { value: opts.agents ?? [] }
  })
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

/** Yields one microtask at a time until the condition holds; the recorder works in the background, so tests wait for what they expect. */
async function until(cond: () => boolean, max = 20000): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (cond()) return
    await Promise.resolve()
  }
  throw new Error(`until: the condition still did not hold after ${max} microtask yields`)
}

/** A fixed wait, for assertions that nothing (more) was sent. */
async function settle(): Promise<void> {
  for (let i = 0; i < 2000; i++) await Promise.resolve()
}

/** Counts agent.list answers: the last await of the recorder's start, so recording is on once it is up. */
let listed = 0

/** Starts the session and waits for the recorder to be up. */
async function start($: Engine) {
  const result = await $.session.start({ cwd: '/project', surface: null, isInteractive: false })
  await until(() => listed > 0)
  return result
}

/** For a session where the recorder never comes up. */
async function startQuiet($: Engine) {
  const result = await $.session.start({ cwd: '/project', surface: null, isInteractive: false })
  await settle()
  return result
}

type ToolCall = Parameters<Engine['tool']['call']>[0]
const call = ($: Engine, input: ToolCall) => $.tool.call(input)

async function spawnWorker($: Engine): Promise<void> {
  await $.agent.spawn({
    tool_use_id: 'toolu_1', prompt: 'Find the docs and report back', description: 'Find the docs', subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false, name: 'probe-worker',
  })
}

/** Runs a stream to its end and answers what it returns. */
async function drain<R>(stream: AsyncGenerator<unknown, R>): Promise<R> {
  let step = await stream.next()
  while (step.done !== true) step = await stream.next()
  return step.value
}

/**
 * A tool call as a subagent's loop raises it. The kit passes agentId through to the plugin's hooks at
 * run time, but its type for the test's own call leaves it out (an engine call site sets it), hence the cast.
 */
const fromAgent = <T extends object>(call: T, agentId: string): T => ({ ...call, agentId }) as T

test('a lead tool call is recorded at start and end, stamped with the session and a time', LOADED, async ($, on) => {
  const sent = engine(on)
  await start($)
  await call($, { tool: 'Bash', command: 'npm test' })
  await until(() => sent.length === 2)
  expect(sent).toEqual([
    { sessionId: SID, ts: expect.any(String), type: 'agent.tool', agent: 'lead', data: { phase: 'start', tool: 'Bash', kind: 'bash', subject: 'npm test', isError: false } },
    { sessionId: SID, ts: expect.any(String), type: 'agent.tool', agent: 'lead', data: { phase: 'end', tool: 'Bash', kind: 'bash', subject: 'npm test', isError: false } },
  ])
  expect(new Date(sent[0]!.ts).toISOString()).toBe(sent[0]!.ts)
})

test('a spawned agent is started once, and only agents seen spawning are recorded', LOADED, async ($, on) => {
  const sent = engine(on)
  await start($)
  await spawnWorker($)
  await spawnWorker($)
  await call($, fromAgent({ tool: 'Read', file_path: '/project/README.md' }, 'a1'))
  await call($, fromAgent({ tool: 'Read', file_path: '/project/other.md' }, 'fork-unknown'))
  await until(() => sent.length === 3)
  await settle()
  expect(sent.filter(s => s.type === 'agent.started')).toEqual([
    { sessionId: SID, ts: expect.any(String), type: 'agent.started', agent: 'a1', data: { name: 'probe-worker', role: 'general-purpose', description: 'Find the docs', parent: 'lead' } },
  ])
  const tools = sent.filter(s => s.type === 'agent.tool')
  expect(tools.map(s => s.agent)).toEqual(['a1', 'a1'])
  expect(tools[0]!.data.subject).toBe('/project/README.md')
})

test('a model step with usage is recorded for its agent, the lead included; a step without usage is not', LOADED, async ($, on) => {
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

test('a subagent turn end is recorded as agent.finished; the lead turn end is not', LOADED, async ($, on) => {
  const sent = engine(on)
  await start($)
  await spawnWorker($)
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 't1', agentId: 'a1', reason: 'refusal', refusal: { category: 'cyber', explanation: null } })
  await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 't2', reason: 'answer' })
  expect(sent.filter(s => s.type === 'agent.finished')).toEqual([
    { sessionId: SID, ts: expect.any(String), type: 'agent.finished', agent: 'a1', data: { outcome: 'failed', reason: 'refusal' } },
  ])
})

test('delivered model messages are recorded from session.send; undelivered and plugin sends are not', LOADED, async ($, on) => {
  const sent = engine(on)
  await start($)
  await spawnWorker($)
  await $.session.send({ to: 'main', text: 'hello from probe', origin: { kind: 'model' }, agentId: 'a1' })
  await $.session.send({ to: 'nobody', text: 'lost', origin: { kind: 'model' }, agentId: 'a1' })
  await $.session.send({ to: 'main', text: 'from a plugin', origin: { kind: 'plugin', name: 'other' } })
  expect(sent.filter(s => s.type === 'message.sent').map(s => [s.agent, s.data])).toEqual([['a1', { to: 'main', summary: 'hello from probe' }]])
})

test('a protocol SendMessage is recorded from the tool call, without its free text; a plain-text one is not', LOADED, async ($, on) => {
  const sent = engine(on)
  await start($)
  await call($, { tool: 'SendMessage', to: 'probe-worker', message: { type: 'shutdown_response', request_id: 'r1', approve: false, reason: 'still busy' } })
  await call($, { tool: 'SendMessage', to: 'probe-worker', message: 'plain text', summary: 'hi' })
  await until(() => sent.length === 5)
  await settle()
  expect(sent.filter(s => s.type === 'message.sent').map(s => s.data)).toEqual([{ to: 'probe-worker', summary: '[shutdown_response] approve: no' }])
  expect(JSON.stringify(sent)).not.toContain('still busy')
})

test('session.measure is recorded when context or cost changed', LOADED, async ($, on) => {
  const sent = engine(on)
  await start($)
  await $.session.measure({ context: { tokens: 54378, window: 1000000, percent: 5 }, rateLimits: [], cost: { usd: 0.5079974 }, changed: ['context', 'cost'] })
  await $.session.measure({ context: { window: 1000000 }, rateLimits: [], changed: ['rateLimits'] })
  expect(sent.filter(s => s.type === 'session.measure')).toEqual([
    { sessionId: SID, ts: expect.any(String), type: 'session.measure', data: { contextWindow: 1000000, contextTokens: 54378, contextPercent: 5, costUsd: 0.5079974 } },
  ])
})

test("the recorder's own internal tool calls are not recorded", LOADED, async ($, on) => {
  const sent = engine(on)
  await start($)
  await call($, { tool: 'mcp__plugin_omnis-swarm_omnis-swarm__omnis_record', sessionId: SID })
  await call($, { tool: 'mcp__plugin_omnis-swarm_omnis-swarm__omnis_feed', since: 0 })
  await settle()
  expect(sent).toEqual([])
})

test('results pass through unchanged when the server fails, and the loss rides on later events', LOADED, async ($, on) => {
  const sent = engine(on, { failCalls: 2 })
  await start($)
  const first = await call($, { tool: 'Bash', command: 'ls' })
  const second = await call($, { tool: 'Bash', command: 'pwd' })
  await call($, { tool: 'Bash', command: 'whoami' })
  await until(() => sent.length >= 6)
  expect(first.result).toEqual({ stdout: 'ok' })
  expect(second.result).toEqual({ stdout: 'ok' })
  // A call's end waits for its start to settle, so the first loss rides on that end, which then fails too;
  // both are counted again on the next call, which gets through carrying 2.
  expect(sent[0]!.dropped).toBeUndefined()
  expect(Math.max(...sent.map(s => s.dropped ?? 0))).toBe(2)
})

test('a server that rejects outright changes nothing for the session', LOADED, async ($, on) => {
  engine(on, { throwCalls: true })
  await start($)
  const result = await call($, { tool: 'Bash', command: 'ls' })
  expect(result.result).toEqual({ stdout: 'ok' })
})

test('with no server connection or no session id nothing is sent and the session is untouched', LOADED, async ($, on) => {
  const sent = engine(on, { connected: false })
  expect((await startQuiet($)).cwd).toBe('/project')
  await call($, { tool: 'Bash', command: 'ls' })
  expect(sent).toEqual([])
})

test('a failing session id lookup leaves session.start unchanged and recording off', LOADED, async ($, on) => {
  const sent = engine(on, { noSessionId: true })
  expect((await startQuiet($)).cwd).toBe('/project')
  await call($, { tool: 'Bash', command: 'ls' })
  expect(sent).toEqual([])
})

test('a second session.start sends nothing new, and agents running before it are recovered once', LOADED, async ($, on) => {
  const sent = engine(on, { agents: [{ id: 'a7', description: 'Earlier task', type: 'Explore', status: 'running', name: 'scout' }] })
  await start($)
  await start($)
  await until(() => sent.length === 1)
  expect(sent.filter(s => s.type === 'agent.started').map(s => [s.agent, s.data])).toEqual([
    ['a7', { name: 'scout', role: 'Explore', description: 'Earlier task', parent: 'lead' }],
  ])
  await call($, fromAgent({ tool: 'Grep', pattern: 'TODO' }, 'a7'))
  await until(() => sent.length === 3)
  expect(sent.filter(s => s.type === 'agent.tool').map(s => s.agent)).toEqual(['a7', 'a7'])
})

test('session.start returns at once even when the server connection never comes', LOADED, async ($, on) => {
  const sent = engine(on, { hangConnect: true })
  expect((await $.session.start({ cwd: '/project', surface: null, isInteractive: false })).cwd).toBe('/project')
  await call($, { tool: 'Bash', command: 'ls' })
  expect(sent).toEqual([])
})

for (const throwCalls of [false, true]) {
  test(`every hook returns what next gave it, unchanged (server throwing: ${throwCalls})`, LOADED, async ($, on) => {
    engine(on, { throwCalls })
    await start($)
    const spawned = await $.agent.spawn({
      tool_use_id: 'toolu_1', prompt: 'p', description: 'd', subagentType: 'general-purpose',
      provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false, name: 'probe-worker',
    })
    expect(spawned).toEqual({ model: 'claude-opus-5-5', agentId: 'a1' })
    const step = await drain($.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1, agentId: 'a1' }))
    expect(step).toEqual({
      turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { input_tokens: 2, output_tokens: 210, cache_read_input_tokens: 5, cache_creation_input_tokens: 42374, model: 'claude-opus-5-5' },
    })
    const done = await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 't1', agentId: 'a1', reason: 'answer' })
    expect(done).toEqual({ text: '' })
    const delivered = await $.session.send({ to: 'main', text: 'hi', origin: { kind: 'model' }, agentId: 'a1' })
    expect(delivered).toEqual({ isDelivered: true })
    const undelivered = await $.session.send({ to: 'nobody', text: 'hi', origin: { kind: 'model' }, agentId: 'a1' })
    expect(undelivered).toEqual({ isDelivered: false, reason: 'No agent named nobody' })
    const measured = await $.session.measure({ context: { tokens: 1, window: 10, percent: 10 }, rateLimits: [], cost: { usd: 0.1 }, changed: ['context'] })
    expect(measured).toEqual({ changed: ['context'] })
  })
}

test('a tool end is sent only after its start call has settled', LOADED, async ($, on) => {
  let release!: () => void
  const gate = new Promise<void>(resolve => (release = resolve))
  const sent = engine(on, { gate })
  await start($)
  const result = await call($, { tool: 'Bash', command: 'ls' })
  expect(result.result).toEqual({ stdout: 'ok' })
  await until(() => sent.length === 1)
  await settle()
  expect(sent.map(s => (s.data as { phase?: string }).phase)).toEqual(['start'])
  release()
  await until(() => sent.length === 2)
  expect(sent.map(s => (s.data as { phase?: string }).phase)).toEqual(['start', 'end'])
})

/** Seventy running agents: one session.start raises seventy agent.started events at once, so no test loops over slow kit calls. */
const crowd: AgentInfo[] = Array.from({ length: 70 }, (_, i) => ({ id: `w${i}`, description: 'Task', type: 'Explore', status: 'running', name: `worker-${i}` }))

test('with 64 calls in flight the next are dropped, and the count rides on the first call after', LOADED, async ($, on) => {
  let release!: () => void
  const gate = new Promise<void>(resolve => (release = resolve))
  const sent = engine(on, { gate, agents: crowd })
  await start($)
  await until(() => sent.length === 64)
  await settle()
  expect(sent.length).toBe(64)
  release()
  await settle()
  await $.session.measure({ context: { tokens: 1, window: 10 }, rateLimits: [], changed: ['context'] })
  await until(() => sent.length === 65)
  expect(sent[64]!.dropped).toBe(6)
  expect(sent.slice(0, 64).some(s => s.dropped !== undefined)).toBe(false)
})

test('a burst of drops costs one state save in flight and one more, not one each', LOADED, async ($, on) => {
  let release!: () => void
  const stateGate = new Promise<void>(resolve => (release = resolve))
  const writes: Write[] = []
  engine(on, { gate: new Promise(() => {}), stateGate, writes, agents: crowd })
  await start($)
  await until(() => writes.some(w => w.key === 'dropped'))
  await settle()
  expect(writes.filter(w => w.key === 'dropped').length).toBe(1)
  release()
  await until(() => writes.filter(w => w.key === 'dropped').length === 2)
  await settle()
  const dropped = writes.filter(w => w.key === 'dropped')
  expect(dropped.length).toBe(2)
  expect(dropped[1]!.value).toBe(6)
})

test('after a reload the seen agents and the drop count come back from state, once', LOADED, async ($, on) => {
  const sent = engine(on, {
    stored: { seen: ['a7'], dropped: 3 },
    agents: [{ id: 'a7', description: 'Earlier task', type: 'Explore', status: 'running', name: 'scout' }],
  })
  await start($)
  await start($)
  await settle()
  expect(sent.filter(s => s.type === 'agent.started')).toEqual([])
  await call($, fromAgent({ tool: 'Grep', pattern: 'TODO' }, 'a7'))
  await until(() => sent.length === 2)
  expect(sent.map(s => [s.agent, s.dropped])).toEqual([['a7', 3], ['a7', undefined]])
})

test('two session.starts in quick succession carry the stored drop count exactly once', LOADED, async ($, on) => {
  const sent = engine(on, { stored: { dropped: 3 } })
  await Promise.all([
    $.session.start({ cwd: '/project', surface: null, isInteractive: false }),
    $.session.start({ cwd: '/project', surface: null, isInteractive: false }),
  ])
  await until(() => listed > 1)
  await settle()
  await call($, { tool: 'Bash', command: 'ls' })
  await until(() => sent.length === 2)
  expect(sent.map(s => s.dropped)).toEqual([3, undefined])
})
