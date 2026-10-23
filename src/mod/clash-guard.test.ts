import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { KIT } from './test-engine.ts'

const SID = 'abcdef12-3456-7890-abcd-ef1234567890'
const T0 = Date.parse('2026-10-23T10:00:00.000Z')
const REFUSED = 'coder-1 is editing src/x.ts. Message them, or wait until they finish.'
type Seen = { records: Array<{ type: string; agent?: string; data: Record<string, unknown> }>; readonly appends: string[]; beneath: 'allow' | 'deny' }

function engine(on: On): Seen {
  const session = mock.session(on)
  const seen: Seen = { records: [], beneath: 'allow', get appends() { return session.appended().map(row => JSON.stringify(row.message)) } }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SID }))
  on('session.cwd', () => ({ value: '/p' }))
  on('state.get', () => ({ value: { value: undefined, version: 0 } }))
  on('state.set', () => ({ value: { isSet: true as const, version: 1 } }))
  on('agent.list', () => ({ value: [{ id: 'a1', name: 'coder-1', description: '', type: 'coder' }, { id: 'a2', name: 'coder-2', description: '', type: 'coder' }] as never }))
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'plugin:omnis-swarm:omnis-swarm' } }))
  on('mcp.call', (_$, e) => {
    const a = e.args as { type: string; agent?: string; data: Record<string, unknown> }
    seen.records.push({ type: a.type, ...(a.agent !== undefined && { agent: a.agent }), data: a.data })
    return { value: { content: [{ type: 'text', text: 'ok s1' }], isError: false } }
  })
  on('tool.check', () => ({ decision: seen.beneath }))
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
const editAs = ($: Engine, agentId: string | undefined, file: string, tool = 'Edit') =>
  $.tool.check({ tool, input: tool === 'NotebookEdit' ? { notebook_path: file } : { file_path: file }, tool_use_id: `toolu_${++n}`, ...(agentId !== undefined && { agentId }) } as never)
const finish = ($: Engine, agentId: string) => $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: `t${++n}`, agentId, reason: 'answer' })
const clashes = (seen: Seen) => seen.records.filter(r => r.type === 'clash.blocked')

test('a second subagent editing a held file is refused with the holder named, and one event is recorded', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  expect((await editAs($, 'a1', 'src/x.ts')).decision).toBe('allow')
  const refused = await editAs($, 'a2', '/p/src/x.ts', 'Write')
  expect(refused).toEqual({ decision: 'deny', reason: REFUSED })
  await editAs($, 'a2', 'src/x.ts')
  await clock.settle()
  expect(clashes(seen)).toEqual([{ type: 'clash.blocked', agent: 'a2', data: { path: '/p/src/x.ts', holder: 'a1', mode: 'block' } }])
})

test('the holder keeps editing, the lead is refused but never holds, and a finished holder lets go', KIT, async ($, on) => {
  const { seen } = await boot($, on)
  await editAs($, 'a1', 'src/x.ts')
  expect((await editAs($, 'a1', 'src/x.ts')).decision).toBe('allow')
  expect((await editAs($, undefined, 'src/x.ts')).decision).toBe('deny')
  expect((await editAs($, undefined, 'src/lead.ts')).decision).toBe('allow')
  expect((await editAs($, 'a2', 'src/lead.ts')).decision).toBe('allow')
  await finish($, 'a1')
  expect((await editAs($, 'a2', 'src/x.ts')).decision).toBe('allow')
  expect(seen.records.filter(r => r.type === 'clash.blocked').length).toBe(1)
})

test('a hold lapses after 10 idle minutes', KIT, async ($, on) => {
  const { clock } = await boot($, on)
  await editAs($, 'a1', 'src/x.nb', 'NotebookEdit')
  await clock.advance(9 * 60_000)
  expect((await editAs($, 'a2', 'src/x.nb', 'NotebookEdit')).decision).toBe('deny')
  await clock.advance(60_000)
  expect((await editAs($, 'a2', 'src/x.nb', 'NotebookEdit')).decision).toBe('allow')
})

test('an edit the engine refuses takes no hold', KIT, async ($, on) => {
  const { seen } = await boot($, on)
  seen.beneath = 'deny'
  await editAs($, 'a1', 'src/x.ts')
  seen.beneath = 'allow'
  expect((await editAs($, 'a2', 'src/x.ts')).decision).toBe('allow')
})

test('warn lets the edit through and tells the lead', { ...KIT, options: { clashGuard: 'warn' } }, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await editAs($, 'a1', 'src/x.ts')
  expect((await editAs($, 'a2', 'src/x.ts')).decision).toBe('allow')
  await clock.settle()
  expect(seen.appends.some(a => a.includes('[OmnisSwarm clash guard] coder-2 edited src/x.ts while coder-1 holds it.'))).toBe(true)
  expect(clashes(seen).map(r => r.data.mode)).toEqual(['warn'])
})

test('off keeps no holds', { ...KIT, options: { clashGuard: 'off' } }, async ($, on) => {
  const { seen } = await boot($, on)
  await editAs($, 'a1', 'src/x.ts')
  expect((await editAs($, 'a2', 'src/x.ts')).decision).toBe('allow')
  expect(clashes(seen)).toEqual([])
})

test('other tools and a query without a call id are left alone', KIT, async ($, on) => {
  await boot($, on)
  await editAs($, 'a1', 'src/x.ts')
  expect((await $.tool.check({ tool: 'Read', input: { file_path: 'src/x.ts' }, tool_use_id: 'toolu_r', agentId: 'a2' } as never)).decision).toBe('allow')
  expect((await $.tool.check({ tool: 'Edit', input: { file_path: 'src/x.ts' } })).decision).toBe('allow')
})
