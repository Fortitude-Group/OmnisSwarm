import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { sessionKey } from '../../src/core/swarm.ts'
import { readCurrent, readEvents, swarmLogPath } from '../../src/core/log.ts'
import { handleMessage } from '../../src/mcp/protocol.ts'
import { Session } from '../../src/mcp/session.ts'
import { createRecordTools } from '../../src/mcp/tools/record.ts'
import { createTools } from '../../src/mcp/tools.ts'
import { InputError } from '../../src/mcp/validate.ts'
import { tmpRoot } from '../helpers.ts'

const SID = 'abcdef12-3456-7890-abcd-ef1234567890'
const TS = '2026-10-21T10:00:01.234Z'
const TOOL = { phase: 'start', tool: 'Bash', kind: 'bash', subject: 'npm test', isError: false }

const setup = () => {
  const root = tmpRoot()
  const session = new Session(root)
  const [record] = createRecordTools({ root, session })
  const tools = createTools({ root, session, now: () => new Date('2026-10-21T10:00:05.000Z') })
  const call = (args: Record<string, unknown>) => record!.handler(args)
  const tool = (name: string, args: Record<string, unknown> = {}) => tools.find(t => t.name === name)!.handler(args)
  const events = (id: string) => readEvents(swarmLogPath(root, id)).events
  return { root, session, record: record!, call, tool, events }
}

test('offers exactly omnis_record, with an object schema', () => {
  const root = tmpRoot()
  const tools = createRecordTools({ root, session: new Session(root) })
  assert.deepEqual(tools.map(t => t.name), ['omnis_record'])
  assert.equal(tools[0]!.inputSchema.type, 'object')
  assert.match(tools[0]!.description, /Internal/)
})

test('the first event starts the session swarm, then lands in it as written by the recorder', () => {
  const { root, call, events } = setup()
  assert.deepEqual(call({ sessionId: SID, ts: TS, type: 'agent.tool', agent: 'lead', data: TOOL }), { text: 'ok' })
  assert.equal(readCurrent(root), 'session-abcdef12')
  const [started, tool] = events('session-abcdef12')
  assert.equal(started?.type, 'swarm.started')
  assert.deepEqual(started?.data, { name: 'session-abcdef12', topology: 'hierarchical', implicit: true, session: sessionKey(SID) })
  assert.equal(started?.ts, TS)
  assert.deepEqual(tool, { v: 1, ts: TS, swarm: 'session-abcdef12', src: 'recorder', type: 'agent.tool', agent: 'lead', data: TOOL })
})

test('later events reuse the swarm', () => {
  const { call, events } = setup()
  call({ sessionId: SID, ts: TS, type: 'agent.tool', agent: 'lead', data: TOOL })
  call({ sessionId: SID, ts: TS, type: 'agent.tool', agent: 'lead', data: { ...TOOL, phase: 'end' } })
  assert.equal(events('session-abcdef12').length, 3)
})

test('every recorder type is accepted with its own data', () => {
  const { call, events } = setup()
  const ok = (type: string, data: Record<string, unknown>, agent: string | null = 'a1') =>
    call({ sessionId: SID, ts: TS, type, ...(agent !== null && { agent }), data })
  ok('agent.started', { name: 'probe-worker', role: 'general-purpose', description: 'Find the docs', parent: 'lead' })
  ok('agent.started', { name: '', role: 'agent', description: '', parent: 'lead' }, 'a2')
  ok('agent.finished', { outcome: 'failed', reason: 'refusal' })
  ok('agent.finished', { outcome: 'answer' })
  ok('agent.usage', { model: 'claude-opus-5-5', input: 2, output: 210, cacheRead: 0, cacheWrite5m: 42374, cacheWrite1h: 0 })
  ok('agent.tool', TOOL)
  ok('message.sent', { to: 'coder [3fa9c1]', summary: '[shutdown_request]' })
  ok('session.measure', { contextWindow: 1000000, contextTokens: 54378, contextPercent: 5, costUsd: 0.5079974 }, null)
  ok('session.measure', { contextWindow: 200000 }, null)
  const written = events('session-abcdef12').slice(1)
  assert.equal(written.length, 9)
  assert.equal(written[7]!.agent, undefined)
  assert.deepEqual(written[3]!.data, { outcome: 'answer' })
})

test('unknown keys in data are not copied into the log', () => {
  const { call, events } = setup()
  call({ sessionId: SID, ts: TS, type: 'agent.tool', agent: 'lead', data: { ...TOOL, output: 'secret file contents' } })
  assert.deepEqual(events('session-abcdef12')[1]!.data, TOOL)
})

test('dropped rides in data and folds into gaps', () => {
  const { session, call, events } = setup()
  call({ sessionId: SID, ts: TS, type: 'agent.tool', agent: 'lead', data: TOOL, dropped: 3 })
  assert.equal((events('session-abcdef12')[1]!.data as { dropped?: number }).dropped, 3)
  assert.equal(session.state('session-abcdef12').state.gaps, 3)
})

test('bad calls are refused with an InputError and write nothing', () => {
  const { root, call } = setup()
  const good = { sessionId: SID, ts: TS, type: 'agent.tool', agent: 'lead', data: TOOL }
  const bad: Array<Record<string, unknown>> = [
    { ...good, type: 'memory.put' },
    { ...good, type: 'swarm.started' },
    { ...good, sessionId: '../../etc' },
    { ...good, ts: 'yesterday' },
    { ...good, ts: '2026-10-21T10:00:01Z' },
    { ...good, agent: 'bad id' },
    { ...good, data: 'nope' },
    { ...good, dropped: -1 },
    { ...good, data: { ...TOOL, kind: 'teleport' } },
    { ...good, data: { ...TOOL, phase: 'middle' } },
    { ...good, data: { ...TOOL, isError: 'no' } },
    { ...good, data: { ...TOOL, subject: 'x'.repeat(81) } },
    { ...good, data: { ...TOOL, subject: 'line\nbreak' } },
    { ...good, data: { ...TOOL, tool: '' } },
    { ...good, type: 'agent.usage', data: { model: 'm', input: -1, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } },
    { ...good, type: 'agent.usage', data: { model: 'm', input: 1.5, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } },
    { ...good, type: 'agent.finished', data: { outcome: 'exploded' } },
    { ...good, type: 'agent.started', data: { name: 'n', role: 'r', description: 'd', parent: 'not valid' } },
    { ...good, type: 'message.sent', data: { to: '', summary: 'x' } },
    { ...good, type: 'message.sent', data: { to: 'main', summary: 'y'.repeat(201) } },
    { ...good, type: 'session.measure', data: { contextWindow: 1, contextPercent: 101 } },
    { ...good, type: 'session.measure', data: { contextWindow: 1, costUsd: Number.POSITIVE_INFINITY } },
  ]
  for (const args of bad) assert.throws(() => call(args), InputError, JSON.stringify(args).slice(0, 120))
  assert.equal(existsSync(join(root, '.omnis-swarm')), false)
})

test('omnis_swarm_init after recorder events names the implicit session swarm', () => {
  const { root, call, tool } = setup()
  call({ sessionId: SID, ts: TS, type: 'agent.tool', agent: 'lead', data: TOOL })
  assert.match(tool('omnis_swarm_init', { name: 'Auth refactor', topology: 'mesh' }).text, /now names the running session swarm session-abcdef12/)
  assert.equal(readCurrent(root), 'session-abcdef12')
})

test('after a restart the recorder keeps writing to its own swarm, which the session still owns', () => {
  const { root, call } = setup()
  call({ sessionId: SID, ts: TS, type: 'agent.tool', agent: 'lead', data: TOOL })
  const session = new Session(root)
  const [record] = createRecordTools({ root, session })
  record!.handler({ sessionId: SID, ts: TS, type: 'agent.tool', agent: 'lead', data: { ...TOOL, phase: 'end' } })
  assert.equal(readCurrent(root), 'session-abcdef12')
  assert.equal(session.owned, true)
})

test('through the protocol, a refused call comes back as an error result', () => {
  const { record } = setup()
  const reply = handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'omnis_record', arguments: { sessionId: SID, ts: TS, type: 'task.created', data: {} } } },
    [record],
    { name: 'omnis-swarm', version: '0.1.0' },
  )
  assert.equal((reply?.result as { isError: boolean }).isError, true)
})

test('the raw session id never reaches the log, only its key', () => {
  const { root, call } = setup()
  call({ sessionId: SID, ts: TS, type: 'agent.tool', agent: 'lead', data: TOOL })
  const raw = readFileSync(swarmLogPath(root, 'session-abcdef12'), 'utf8')
  assert.equal(raw.includes(SID), false)
  assert.equal(raw.includes(sessionKey(SID)), true)
})

test('swarm.started and other non-recorder types are refused and the server stamps v, swarm and src itself', () => {
  const { call, events } = setup()
  for (const type of ['swarm.started', 'swarm.ended', 'task.created', 'memory.put']) {
    assert.throws(() => call({ sessionId: SID, ts: TS, type, data: { name: 'x', topology: 'mesh', session: 'forged' } }), InputError)
  }
  call({ sessionId: SID, ts: TS, type: 'agent.tool', agent: 'lead', data: TOOL, v: 9, swarm: 'other', src: 'mcp' })
  const e = events('session-abcdef12')[1]!
  assert.equal(e.v, 1)
  assert.equal(e.swarm, 'session-abcdef12')
  assert.equal(e.src, 'recorder')
})

test('omnis_record is the only caller of noteSession', () => {
  const dir = join(import.meta.dirname, '../../src/mcp')
  const files = ['tools.ts', 'server.ts', 'registry.ts', 'tools/record.ts']
  const callers = files.filter(f => existsSync(join(dir, f)) && /\.noteSession\(/.test(readFileSync(join(dir, f), 'utf8')))
  assert.deepEqual(callers, ['tools/record.ts'])
})

test('a second, different session id switches ownership off but still records', () => {
  const { session, call, events } = setup()
  call({ sessionId: SID, ts: TS, type: 'agent.tool', agent: 'lead', data: TOOL })
  call({ sessionId: 'ffffffff-0000-0000-0000-000000000000', ts: TS, type: 'agent.tool', agent: 'lead', data: TOOL })
  assert.equal(session.sessionKey, null)
  assert.equal(events('session-abcdef12').length, 3)
})
