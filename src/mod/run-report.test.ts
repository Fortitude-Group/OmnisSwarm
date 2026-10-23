import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { KIT, RUN } from './test-engine.ts'

const SID = 'abcdef12-3456-7890-abcd-ef1234567890'
const POINTER = 'Swarm report: .omnis-swarm/reports/s1-20261023-1000.md · 1 agent · 3 min · ≈$0.40.'
type Seen = { reports: number; readonly appends: string[]; reply: { text: string; isError: boolean } }

function engine(on: On): Seen {
  const session = mock.session(on)
  const seen: Seen = { reports: 0, reply: { text: POINTER, isError: false }, get appends() { return session.appended().map(row => JSON.stringify(row.message)) } }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SID }))
  on('state.get', () => ({ value: { value: undefined, version: 0 } }))
  on('state.set', () => ({ value: { isSet: true as const, version: 1 } }))
  on('agent.list', () => ({ value: [] }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'plugin:omnis-swarm:omnis-swarm' } }))
  on('mcp.call', (_$, e) => {
    if (e.tool !== 'omnis_report') return { value: { content: [{ type: 'text', text: 'ok s1' }], isError: false } }
    seen.reports++
    return { value: { content: [{ type: 'text', text: seen.reply.text }], isError: seen.reply.isError } }
  })
  let id = 0
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: `a${++id}` }))
  on('turn.complete', () => ({ text: '' }))
  return seen
}

async function boot($: Engine, on: On) {
  const clock = mock.clock(on, { now: Date.parse('2026-10-23T10:00:00.000Z') })
  const seen = engine(on)
  await $.session.start({ cwd: '/p', surface: null, isInteractive: false })
  await clock.settle()
  return { clock, seen }
}

const spawn = ($: Engine, n: number) => $.agent.spawn({
  tool_use_id: `toolu_${n}`, name: `coder-${n}`, subagentType: 'coder', description: 'x', prompt: 'p',
  provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false,
})
const finish = ($: Engine, agentId: string) => $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: `t-${agentId}`, agentId, reason: 'answer' })
const pointers = (seen: Seen) => seen.appends.filter(a => a.includes('Swarm report: '))

test('when the last subagent finishes and 30 s pass quietly, one report is written and the lead is told', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await spawn($, 1)
  await finish($, 'a1')
  await clock.advance(29_000)
  expect(seen.reports).toBe(0)
  await clock.advance(1_000)
  await clock.settle()
  expect(seen.reports).toBe(1)
  expect(pointers(seen).length).toBe(1)
  expect(seen.appends.map(a => JSON.parse(a).content)).toEqual([[{ type: 'text', text: POINTER }]])
  await finish($, 'a1')
  await clock.advance(60_000)
  await clock.settle()
  expect(seen.reports).toBe(1)
})

test('a subagent starting inside the quiet window puts the report off until it finishes too', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await spawn($, 1)
  await finish($, 'a1')
  await clock.advance(10_000)
  await spawn($, 2)
  await clock.advance(60_000)
  expect(seen.reports).toBe(0)
  await finish($, 'a2')
  await clock.advance(30_000)
  await clock.settle()
  expect(seen.reports).toBe(1)
})

test('the lead finishing a turn is not a run going quiet', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await $.turn.complete({ answer: 'x', durationMs: 1, isAborted: false, turnId: 'lead', reason: 'answer' })
  await clock.advance(60_000)
  await clock.settle()
  expect(seen.reports).toBe(0)
})

test('/omnis report answers the pointer, or the server\'s error', KIT, async ($, on) => {
  const { seen } = await boot($, on)
  expect(await $.command.run({ command: 'omnis', args: 'report', ...RUN })).toMatchObject({ text: POINTER })
  seen.reply = { text: 'No swarm is running.', isError: true }
  expect(await $.command.run({ command: 'omnis', args: 'report', ...RUN })).toMatchObject({ text: 'No report was written: No swarm is running.' })
  expect(await $.command.run({ command: 'omnis', args: 'report now', ...RUN })).toMatchObject({ text: 'Usage: /omnis report writes a report of the current swarm.' })
})

test('a spawn inside the window restarts the quiet: a full 30 s after the last finish', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await spawn($, 1)
  await finish($, 'a1')
  await clock.advance(10_000)
  await spawn($, 2)
  await clock.advance(10_000)
  await finish($, 'a2')
  await clock.advance(19_000)
  await clock.settle()
  expect(seen.reports).toBe(0)
  await clock.advance(11_000)
  await clock.settle()
  expect(seen.reports).toBe(1)
})

test('/omnis report inside the quiet window means the quiet report is skipped', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await spawn($, 1)
  await finish($, 'a1')
  await clock.advance(10_000)
  await $.command.run({ command: 'omnis', args: 'report', ...RUN })
  expect(seen.reports).toBe(1)
  await clock.advance(60_000)
  await clock.settle()
  expect(seen.reports).toBe(1)
  expect(seen.appends).toEqual([])
})

test('an error reply on the quiet path appends nothing, and the next quiet tries again', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  seen.reply = { text: 'No swarm is running.', isError: true }
  await spawn($, 1)
  await finish($, 'a1')
  await clock.advance(30_000)
  await clock.settle()
  expect(seen.reports).toBe(1)
  expect(seen.appends).toEqual([])
  seen.reply = { text: POINTER, isError: false }
  await spawn($, 2)
  await finish($, 'a2')
  await clock.advance(30_000)
  await clock.settle()
  expect(seen.reports).toBe(2)
  expect(pointers(seen).length).toBe(1)
})
