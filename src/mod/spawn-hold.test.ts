import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { KIT } from './test-engine.ts'

// The kit loads the plugin's own register.ts, so these drive the spawn hold through the real hooks. Nothing sits beneath
// the plugin: the hooks here stand for the engine (agent.spawn starts agents a1, a2, ...) and the MCP server (omnis_wait
// answers only when a test lets it, as if the wait were long).

const SID = 'abcdef12-3456-7890-abcd-ef1234567890'
const T0 = Date.parse('2026-11-15T10:00:00.000Z')
type Rec = { type: string; agent?: string; data: Record<string, unknown> }
type Seen = { records: Rec[]; started: string[]; waits: Array<() => void>; refuse: number; waitAs: 'hang' | 'error' }

function engine(on: On): Seen {
  const seen: Seen = { records: [], started: [], waits: [], refuse: 0, waitAs: 'hang' }
  let id = 0
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SID }))
  on('state.get', () => ({ value: { value: undefined, version: 0 } }))
  on('state.set', () => ({ value: { isSet: true as const, version: 1 } }))
  on('agent.list', () => ({ value: [] }))
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'plugin:omnis-swarm:omnis-swarm' } }))
  on('mcp.call', (_$, e) => {
    const ok = { value: { content: [{ type: 'text' as const, text: 'ok s1' }], isError: false } }
    if (e.tool === 'omnis_wait') {
      if (seen.waitAs === 'error') return { value: { content: [{ type: 'text' as const, text: 'no such tool' }], isError: true } }
      return new Promise(resolve => seen.waits.push(() => resolve(ok)))
    }
    const a = e.args as Rec
    seen.records.push({ type: a.type, ...(a.agent !== undefined && { agent: a.agent }), data: a.data })
    return ok
  })
  on('agent.spawn', (_$, e) => {
    if (seen.refuse > 0) {
      seen.refuse--
      return { deny: 'refused' }
    }
    const agentId = `a${++id}`
    seen.started.push(`${agentId}:${e.subagentType}`)
    return { model: 'claude-opus-5-5', agentId }
  })
  on('turn.step', async function* (_$, e) {
    yield { kind: 'text' as const, index: 0, text: 'hi' }
    return { turnId: e.turnId, index: e.index, answer: 'hi', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  on('turn.complete', () => ({ text: '' }))
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
/** Starts a spawn and answers a handle saying whether it has come back yet. */
function spawn($: Engine, subagentType: string, extra: Record<string, unknown> = {}) {
  const box: { done: boolean; result: unknown } = { done: false, result: undefined }
  const p = $.agent.spawn({
    tool_use_id: `toolu_${++n}`, subagentType, description: 'x', prompt: 'p', provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5', background: true, fork: false, ...extra,
  } as never).then(r => {
    box.done = true
    box.result = r
    return r
  })
  return { box, p }
}

async function drain<R>(stream: AsyncGenerator<unknown, R>): Promise<R> {
  let next = await stream.next()
  while (next.done !== true) next = await stream.next()
  return next.value
}
const step = ($: Engine, agentId: string) => drain($.turn.step({ turnId: `t${++n}`, index: 0, model: 'claude-opus-5-5', messageCount: 1, agentId }))
const finish = ($: Engine, agentId: string) => $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: `t${++n}`, agentId, reason: 'aborted' })
const holds = (seen: Seen) => seen.records.filter(r => r.type === 'spawn.held').map(r => r.data)
/** Lets every pending omnis_wait answer, as the server does after its second. */
function answerWaits(seen: Seen): void {
  const w = seen.waits.splice(0)
  for (const f of w) f()
}

test('the first of a type starts at once, the rest wait for its first response, then start', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  const first = spawn($, 'Explore')
  await first.p
  const second = spawn($, 'Explore')
  const third = spawn($, 'Explore')
  await clock.settle()
  expect([second.box.done, third.box.done]).toEqual([false, false])
  expect(seen.started).toEqual(['a1:Explore'])
  await clock.advance(41_000)
  await step($, 'a1')
  await Promise.all([second.p, third.p])
  await clock.settle()
  expect(seen.started).toEqual(['a1:Explore', 'a2:Explore', 'a3:Explore'])
  expect(holds(seen)).toEqual([
    { role: 'Explore', phase: 'start', count: 1, ms: 0 },
    { role: 'Explore', phase: 'end', count: 2, ms: 41_000, why: 'answered' },
  ])
  // Warm now: the next one goes straight away.
  await spawn($, 'Explore').p
  expect(seen.started.length).toBe(4)
})

test('different types are never held against each other', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await spawn($, 'Explore').p
  await spawn($, 'Plan').p
  await spawn($, 'general-purpose').p
  await spawn($, 'Explore', { model: 'haiku' }).p
  await clock.settle()
  expect(seen.started).toEqual(['a1:Explore', 'a2:Plan', 'a3:general-purpose', 'a4:Explore'])
  expect(holds(seen)).toEqual([])
})

test('a hold lets go at 4 minutes when the first never answers', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await spawn($, 'Explore').p
  const second = spawn($, 'Explore')
  await clock.settle()
  await clock.advance(239_000)
  answerWaits(seen)
  await clock.settle()
  expect(second.box.done).toBe(false)
  await clock.advance(1000)
  answerWaits(seen)
  await second.p
  await clock.settle()
  expect(holds(seen).at(-1)).toEqual({ role: 'Explore', phase: 'end', count: 1, ms: 240_000, why: 'timeout' })
})

test('a first agent that stops before answering lets the rest go', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await spawn($, 'Explore').p
  const second = spawn($, 'Explore')
  await clock.settle()
  await clock.advance(12_000)
  await finish($, 'a1')
  await second.p
  await clock.settle()
  expect(holds(seen).at(-1)).toEqual({ role: 'Explore', phase: 'end', count: 1, ms: 12_000, why: 'failed' })
})

test('a first spawn that is refused hands the lead to the next one', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  seen.refuse = 1
  const first = spawn($, 'Explore')
  const second = spawn($, 'Explore')
  const third = spawn($, 'Explore')
  await first.p
  await second.p
  await clock.settle()
  expect(seen.started).toEqual(['a1:Explore'])
  expect(third.box.done).toBe(false)
  await step($, 'a1')
  await third.p
  expect(seen.started).toEqual(['a1:Explore', 'a2:Explore'])
})

test('forks, resumed agents and teammates are never held', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await spawn($, 'Explore').p
  await spawn($, 'Explore', { fork: true }).p
  await spawn($, 'Explore', { resume: { agentId: 'old' } }).p
  await spawn($, 'Explore', { isTeammate: true }).p
  await clock.settle()
  expect(seen.started.length).toBe(4)
  expect(holds(seen)).toEqual([])
})

test('without the server wait the hold still lets go, inside the hook budget', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  seen.waitAs = 'error'
  await spawn($, 'Explore').p
  const second = spawn($, 'Explore')
  for (let i = 0; i < 80 && !second.box.done; i++) await clock.advance(250)
  expect(second.box.done).toBe(true)
  expect(seen.started).toEqual(['a1:Explore', 'a2:Explore'])
})

test('off: agents of one type all start at once and nothing is recorded', { ...KIT, options: { cacheHold: 'off' } }, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await spawn($, 'Explore').p
  await spawn($, 'Explore').p
  await spawn($, 'Explore').p
  await clock.settle()
  expect(seen.started.length).toBe(3)
  expect(holds(seen)).toEqual([])
})
