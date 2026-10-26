import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldAll } from '../../src/core/fold.ts'
import { readEvents, swarmLogPath } from '../../src/core/log.ts'
import { sessionKey } from '../../src/core/swarm.ts'
import { Session } from '../../src/mcp/session.ts'
import { createRecordTools } from '../../src/mcp/tools/record.ts'
import { createTools } from '../../src/mcp/tools.ts'
import { tmpRoot } from '../helpers.ts'
import { syncResult } from './sync.ts'

const SID = 'abcdef12-3456-7890-abcd-ef1234567890'
const FIRST = `session-${sessionKey(SID).slice(0, 8)}`
const TS = '2026-10-21T10:00:01.234Z'
const NOW = () => new Date('2026-10-21T10:00:05.000Z')
const TOOL = { phase: 'start', tool: 'Bash', kind: 'bash', subject: 'npm test', isError: false }
const START = { name: 'quakes', role: 'teammate', description: 'Quake cron', parent: 'lead' }

/** One server process: its own Session and tools over `root`. A second one over the same root is a restart. */
const server = (root: string) => {
  const session = new Session(root)
  const [record] = createRecordTools({ root, session, now: NOW })
  const tools = createTools({ root, session, now: NOW })
  return {
    session,
    rec: (type: string, data: Record<string, unknown>, agent?: string) =>
      syncResult(record!.handler({ sessionId: SID, ts: TS, type, data, ...(agent !== undefined && { agent }) })),
    end: () => syncResult(tools.find(t => t.name === 'omnis_swarm_end')!.handler({})),
  }
}
const events = (root: string, id: string) => readEvents(swarmLogPath(root, id)).events
const swarmOf = (reply: { text: string }) => reply.text.replace(/^ok /, '')

/** quakes starts, works and finishes in the first swarm, which then ends. */
const firstRun = (s: ReturnType<typeof server>) => {
  s.rec('agent.started', START, 'aq1')
  s.rec('agent.tool', TOOL, 'aq1')
  s.rec('agent.finished', { outcome: 'answer' }, 'aq1')
  s.end()
}

test('a message to a resumed agent re-announces it in the new swarm, so no placeholder appears', () => {
  const root = tmpRoot()
  const s = server(root)
  firstRun(s)
  const next = swarmOf(s.rec('message.sent', { to: 'quakes', summary: 'one more thing' }, 'lead'))
  assert.notEqual(next, FIRST)
  s.rec('agent.tool', TOOL, 'aq1')
  const log = events(root, next)
  const starts = log.filter(e => e.type === 'agent.started')
  assert.equal(starts.length, 1)
  assert.deepEqual(starts[0]!.data, START)
  assert.equal(starts[0]!.agent, 'aq1')
  assert.ok(log.indexOf(starts[0]!) < log.findIndex(e => e.type === 'message.sent'))
  const state = foldAll(next, log)
  assert.equal(Object.hasOwn(state.agents, '?quakes'), false)
  assert.equal(state.agents.aq1!.name, 'quakes')
  assert.equal(state.agents.aq1!.role, 'teammate')
  assert.equal(state.links['lead->aq1']!.count, 1)
})

test('a resumed agent that speaks first is re-announced once, before its event', () => {
  const root = tmpRoot()
  const s = server(root)
  firstRun(s)
  const next = swarmOf(s.rec('agent.tool', TOOL, 'aq1'))
  s.rec('agent.tool', { ...TOOL, phase: 'end' }, 'aq1')
  const log = events(root, next)
  assert.deepEqual(log.filter(e => e.agent === 'aq1').map(e => e.type), ['agent.started', 'agent.tool', 'agent.tool'])
})

test('after a restart the server still knows the agents of the swarm it let go', () => {
  const root = tmpRoot()
  const before = server(root)
  before.rec('agent.started', START, 'aq1')
  const after = server(root) // the old process knew the start; this one only finds it in the swarm's log
  after.rec('agent.finished', { outcome: 'answer' }, 'aq1')
  after.end()
  const next = swarmOf(after.rec('message.sent', { to: 'quakes', summary: 'back again' }, 'lead'))
  const state = foldAll(next, events(root, next))
  assert.equal(state.agents.aq1!.name, 'quakes')
  assert.equal(Object.hasOwn(state.agents, '?quakes'), false)
})

test('an agent the session never saw start is not given a made-up start', () => {
  const root = tmpRoot()
  const s = server(root)
  const id = swarmOf(s.rec('agent.tool', TOOL, 'stranger'))
  s.rec('message.sent', { to: 'nobody', summary: 'hi' }, 'lead')
  assert.equal(events(root, id).filter(e => e.type === 'agent.started').length, 0)
})
