import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { KIT } from './test-engine.ts'

const SID = 'abcdef12-3456-7890-abcd-ef1234567890'
const T0 = Date.parse('2026-10-24T10:00:00.000Z')
const TASK_UPDATE = 'mcp__plugin_omnis-swarm_omnis-swarm__omnis_task_update'
const TASK_CREATE = 'mcp__omnis-swarm__omnis_task_create'
const REFUSED = 'src/x.ts is outside the files your task owns (t1: docs/, tests/**). Ask main to widen the task, or leave it to the agent that owns it.'
const ROOTS = ['/p', '/w/wt1']

/** How omnis_fence answers: a fence per agent id, or a fault. */
type Server = 'ok' | 'isError' | 'throw' | 'garbage' | 'hang'
type Seen = {
  records: Array<{ type: string; agent?: string; data: Record<string, unknown> }>
  asks: string[]
  readonly appends: string[]
  fences: Record<string, unknown>
  server: Server
}

function engine(on: On): Seen {
  const session = mock.session(on)
  const seen: Seen = { records: [], asks: [], fences: {}, server: 'ok', get appends() { return session.appended().map(row => JSON.stringify(row.message)) } }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SID }))
  on('session.cwd', () => ({ value: '/p' }))
  on('state.get', () => ({ value: { value: undefined, version: 0 } }))
  on('state.set', () => ({ value: { isSet: true as const, version: 1 } }))
  on('agent.list', () => ({ value: [{ id: 'a1', name: 'coder-1', description: '', type: 'coder' }, { id: 'a2', name: 'coder-2', description: '', type: 'coder' }] as never }))
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'plugin:omnis-swarm:omnis-swarm' } }))
  on('mcp.call', (_$, e) => {
    const args = e.args as Record<string, unknown>
    if (e.tool === 'omnis_fence') {
      const agent = String(args.agent)
      seen.asks.push(agent)
      if (seen.server === 'throw') throw new Error('server gone')
      if (seen.server === 'hang') return new Promise<never>(() => {})
      const text = seen.server === 'garbage' ? 'ok s1' : JSON.stringify(seen.fences[agent] ?? { fenced: false })
      return { value: { content: [{ type: 'text', text }], isError: seen.server === 'isError' } }
    }
    const a = args as { type: string; agent?: string; data: Record<string, unknown> }
    seen.records.push({ type: a.type, ...(a.agent !== undefined && { agent: a.agent }), data: a.data })
    return { value: { content: [{ type: 'text', text: 'ok s1' }], isError: false } }
  })
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', () => ({ result: { content: 'ok' } as never, text: 'ok' }))
  on('turn.complete', () => ({ text: '' }))
  return seen
}

async function boot($: Engine, on: On) {
  const clock = mock.clock(on, { now: T0 })
  const seen = engine(on)
  seen.fences.a1 = { fenced: true, tasks: ['t1'], owns: ['docs/', 'tests/**'], roots: ROOTS }
  await $.session.start({ cwd: '/p', surface: null, isInteractive: false })
  await clock.settle()
  return { clock, seen }
}

let n = 0
const editAs = ($: Engine, agentId: string | undefined, file: string, tool = 'Edit') =>
  $.tool.check({ tool, input: tool === 'NotebookEdit' ? { notebook_path: file } : { file_path: file }, tool_use_id: `toolu_${++n}`, ...(agentId !== undefined && { agentId }) } as never)
const updateAs = ($: Engine, agentId: string | undefined, input: Record<string, unknown>) =>
  $.tool.check({ tool: TASK_UPDATE, input, tool_use_id: `toolu_${++n}`, ...(agentId !== undefined && { agentId }) } as never)
const fences = (seen: Seen) => seen.records.filter(r => r.type === 'fence.blocked')

test('a fenced subagent editing outside its files is refused with the exact text, and one event is recorded', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  expect(await editAs($, 'a1', 'src/x.ts')).toEqual({ decision: 'deny', reason: REFUSED })
  expect((await editAs($, 'a1', '/p/src/x.ts', 'Write')).decision).toBe('deny')
  expect((await editAs($, 'a1', 'src/x.nb', 'NotebookEdit')).decision).toBe('deny')
  await clock.settle()
  expect(fences(seen)).toEqual([
    { type: 'fence.blocked', agent: 'a1', data: { path: 'src/x.ts', tasks: ['t1'], mode: 'block' } },
    { type: 'fence.blocked', agent: 'a1', data: { path: 'src/x.nb', tasks: ['t1'], mode: 'block' } },
  ])
})

test('inside the fence passes, matched relative to the longest root, and a path under no root passes', KIT, async ($, on) => {
  await boot($, on)
  expect((await editAs($, 'a1', 'docs/guide.md')).decision).toBe('allow')
  expect((await editAs($, 'a1', '/p/tests/a/b.test.ts')).decision).toBe('allow')
  expect((await editAs($, 'a1', '/w/wt1/docs/x.md', 'Write')).decision).toBe('allow')
  expect((await editAs($, 'a1', '/w/wt1/src/x.ts')).decision).toBe('deny')
  expect((await editAs($, 'a1', '/tmp/scratch.txt', 'Write')).decision).toBe('allow')
  expect((await editAs($, 'a1', '/w/other/src/x.ts')).decision).toBe('allow')
})

test('the lead is never fenced or asked about, and an unfenced subagent goes free', KIT, async ($, on) => {
  const { seen } = await boot($, on)
  expect((await editAs($, undefined, 'src/x.ts')).decision).toBe('allow')
  expect(seen.asks).toEqual([])
  expect((await editAs($, 'a2', 'src/x.ts')).decision).toBe('allow')
  expect(seen.asks).toEqual(['a2'])
})

test('warn lets the edit through and tells main, once a minute per agent and path', { ...KIT, options: { scopeFence: 'warn' } }, async ($, on) => {
  const { clock, seen } = await boot($, on)
  expect((await editAs($, 'a1', 'src/x.ts')).decision).toBe('allow')
  expect((await editAs($, 'a1', 'src/x.ts')).decision).toBe('allow')
  await clock.settle()
  const told = seen.appends.filter(a => a.includes('[OmnisSwarm scope fence]'))
  expect(told.length).toBe(1)
  expect(told[0]!.includes("[OmnisSwarm scope fence] coder-1 edited src/x.ts, outside t1's files.")).toBe(true)
  expect(fences(seen).map(r => r.data.mode)).toEqual(['warn'])
})

test('off asks nothing and fences nothing', { ...KIT, options: { scopeFence: 'off' } }, async ($, on) => {
  const { seen } = await boot($, on)
  expect((await editAs($, 'a1', 'src/x.ts')).decision).toBe('allow')
  expect(seen.asks).toEqual([])
  expect(fences(seen)).toEqual([])
})

test('an unknown setting is block', { ...KIT, options: { scopeFence: 'loud' } }, async ($, on) => {
  await boot($, on)
  expect((await editAs($, 'a1', 'src/x.ts')).decision).toBe('deny')
})

test('fence.blocked is recorded once a minute per agent and path', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await editAs($, 'a1', 'src/x.ts')
  await clock.advance(30_000)
  expect((await editAs($, 'a1', 'src/x.ts')).decision).toBe('deny')
  await clock.advance(30_000)
  expect((await editAs($, 'a1', 'src/x.ts')).decision).toBe('deny')
  await clock.settle()
  expect(fences(seen).length).toBe(2)
})

test('the answer is cached 10 s, and any task create or update drops it', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await editAs($, 'a1', 'src/x.ts')
  await editAs($, 'a1', 'src/y.ts')
  expect(seen.asks).toEqual(['a1'])
  await clock.advance(10_000)
  await editAs($, 'a1', 'src/x.ts')
  expect(seen.asks).toEqual(['a1', 'a1'])
  seen.fences.a1 = { fenced: true, tasks: ['t1'], owns: ['src/**'], roots: ROOTS }
  await $.tool.call({ tool: TASK_UPDATE, tool_use_id: `toolu_${++n}`, id: 't1', state: 'active', owns: ['src/**'] } as never)
  expect((await editAs($, 'a1', 'src/x.ts')).decision).toBe('allow')
  expect(seen.asks.length).toBe(3)
  seen.fences.a1 = { fenced: false }
  await $.tool.call({ tool: TASK_CREATE, tool_use_id: `toolu_${++n}`, title: 'x' } as never)
  await editAs($, 'a1', 'lib/x.ts')
  expect(seen.asks.length).toBe(4)
})

for (const fault of ['isError', 'throw', 'garbage'] as const) {
  test(`a server that answers ${fault} fails open`, KIT, async ($, on) => {
    const { seen } = await boot($, on)
    seen.server = fault
    expect((await editAs($, 'a1', 'src/x.ts')).decision).toBe('allow')
    expect(fences(seen)).toEqual([])
  })
}

test('a server slower than 2 s fails open', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  seen.server = 'hang'
  const pending = editAs($, 'a1', 'src/x.ts')
  await clock.advance(2_000)
  expect((await pending).decision).toBe('allow')
})

test('a fenced-out edit takes no clash hold, and is refused by the fence, not the clash guard', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  seen.fences.a2 = { fenced: true, tasks: ['t2'], owns: ['src/**'], roots: ROOTS }
  // a1 is fenced out of a file nobody holds: refused, and no hold is left behind for a2 to clash with.
  expect((await editAs($, 'a1', 'src/x.ts')).decision).toBe('deny')
  expect((await editAs($, 'a2', 'src/x.ts')).decision).toBe('allow')
  // Now a2 holds src/x.ts. a1's edit of it is still the fence's refusal, so no clash is recorded.
  expect(await editAs($, 'a1', 'src/x.ts')).toEqual({ decision: 'deny', reason: REFUSED })
  await clock.settle()
  expect(seen.records.filter(r => r.type === 'clash.blocked')).toEqual([])
})

test('a subagent can not skip the gate; main can, and a subagent may update without it', KIT, async ($, on) => {
  await boot($, on)
  expect(await updateAs($, 'a1', { id: 't1', state: 'done', skipGate: true, note: 'flaky' }))
    .toEqual({ decision: 'deny', reason: 'Only main can skip the gate. Report the problem to main instead.' })
  expect((await updateAs($, undefined, { id: 't1', state: 'done', skipGate: true, note: 'flaky' })).decision).toBe('allow')
  expect((await updateAs($, 'a1', { id: 't1', state: 'done' })).decision).toBe('allow')
  expect((await updateAs($, 'a1', { id: 't1', state: 'done', skipGate: false })).decision).toBe('allow')
})

test('the skipGate refusal holds even with the fence off', { ...KIT, options: { scopeFence: 'off' } }, async ($, on) => {
  await boot($, on)
  expect((await updateAs($, 'a1', { id: 't1', state: 'done', skipGate: true, note: 'x' })).decision).toBe('deny')
})

const OWNS_REFUSED = 'Only main can change what a task owns. Ask main instead.'
const taskAs = ($: Engine, tool: string, agentId: string | undefined, input: Record<string, unknown>) =>
  $.tool.check({ tool, input, tool_use_id: `toolu_${++n}`, ...(agentId !== undefined && { agentId }) } as never)

test('a subagent can not change what a task owns, under any server alias; main can', KIT, async ($, on) => {
  await boot($, on)
  for (const tool of [TASK_UPDATE, 'mcp__omnis-swarm__omnis_task_update', 'mcp__plugin_other_omnis-swarm__omnis_task_update']) {
    for (const input of [{ owns: ['**'] }, { owns: [] }, { owns: null }, { assignee: 'coder-2' }, { worktree: '/w/wt1' }]) {
      expect(await taskAs($, tool, 'a1', { id: 't1', ...input })).toEqual({ decision: 'deny', reason: OWNS_REFUSED })
      expect((await taskAs($, tool, undefined, { id: 't1', ...input })).decision).toBe('allow')
    }
    expect((await taskAs($, tool, 'a1', { id: 't1', state: 'active', note: 'on it' })).decision).toBe('allow')
  }
  for (const tool of [TASK_CREATE, 'mcp__plugin_omnis-swarm_omnis-swarm__omnis_task_create']) {
    expect(await taskAs($, tool, 'a1', { title: 'x', assignee: 'coder-1', owns: ['**'] })).toEqual({ decision: 'deny', reason: OWNS_REFUSED })
    expect((await taskAs($, tool, 'a1', { title: 'x', owns: [] })).decision).toBe('allow')
    expect((await taskAs($, tool, 'a1', { title: 'x', assignee: 'coder-1' })).decision).toBe('allow')
    expect((await taskAs($, tool, undefined, { title: 'x', owns: ['**'] })).decision).toBe('allow')
  }
})

test('the owns refusal holds with the fence off', { ...KIT, options: { scopeFence: 'off' } }, async ($, on) => {
  await boot($, on)
  expect((await taskAs($, TASK_UPDATE, 'a1', { id: 't1', owns: ['**'] })).decision).toBe('deny')
  expect((await taskAs($, TASK_CREATE, 'a1', { title: 'x', owns: ['**'] })).decision).toBe('deny')
})

test('when the server fails, an agent that was fenced stays fenced on its last answer', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  expect((await editAs($, 'a1', 'src/x.ts')).decision).toBe('deny')
  await $.tool.call({ tool: TASK_UPDATE, tool_use_id: `toolu_${++n}`, id: 't1', state: 'active' } as never)
  await clock.advance(10_000)
  seen.server = 'throw'
  expect((await editAs($, 'a1', 'src/x.ts')).decision).toBe('deny')
  expect((await editAs($, 'a1', 'docs/x.md')).decision).toBe('allow')
  seen.server = 'hang'
  const pending = editAs($, 'a1', 'src/y.ts')
  await clock.advance(2_000)
  expect((await pending).decision).toBe('deny')
})

test('the session folder counts as the project root when the server only knows its real path', KIT, async ($, on) => {
  const { seen } = await boot($, on)
  seen.fences.a1 = { fenced: true, tasks: ['t1'], owns: ['docs/'], roots: ['/real/p'] }
  expect((await editAs($, 'a1', 'src/x.ts')).decision).toBe('deny')
  expect((await editAs($, 'a1', '/p/docs/x.md')).decision).toBe('allow')
  expect((await editAs($, 'a1', '/real/p/src/x.ts')).decision).toBe('deny')
})

test('a task tied to a worktree fences the agent to that worktree', KIT, async ($, on) => {
  const { seen } = await boot($, on)
  seen.fences.a1 = { fenced: true, tasks: ['t1'], owns: ['src/**'], roots: ['/p', '/w/wt1', '/w/wt2'], home: ['/w/wt1'] }
  expect((await editAs($, 'a1', '/w/wt1/src/x.ts')).decision).toBe('allow')
  expect((await editAs($, 'a1', '/w/wt2/src/x.ts')).decision).toBe('deny')
  expect((await editAs($, 'a1', 'src/x.ts')).decision).toBe('deny')
})

test('device-form and UNC spellings are refused for a fenced agent with the usual text', KIT, async ($, on) => {
  const { seen } = await boot($, on)
  seen.fences.a1 = { fenced: true, tasks: ['t1'], owns: ['**'], roots: ROOTS }
  for (const raw of ['//./p/src/x.ts', '//?/p/src/x.ts', '//localhost/share/p/src/x.ts']) {
    const got = await editAs($, 'a1', raw)
    expect(got.decision).toBe('deny')
    expect((got as { reason: string }).reason.endsWith('Ask main to widen the task, or leave it to the agent that owns it.')).toBe(true)
  }
  expect((await editAs($, 'a2', '//./p/src/x.ts')).decision).toBe('allow')
})
