import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendEvent, readCurrent, readEvents, swarmLogPath } from '../../src/core/log.ts'
import { swarmOwner, uniqueSwarmId } from '../../src/core/swarm.ts'
import { Session } from '../../src/mcp/session.ts'
import { createTools } from '../../src/mcp/tools.ts'
import { ev, tmpRoot } from '../helpers.ts'

const NOW = new Date('2026-10-21T10:00:00.000Z')
const SID = 'abcdef12-3456-7890-abcd-ef1234567890'
const OTHER = '99999999-0000-0000-0000-000000000000'

const toolsFor = (root: string, session: Session) => {
  const tools = createTools({ root, now: () => NOW, session })
  return (name: string, args: Record<string, unknown> = {}) => tools.find(t => t.name === name)!.handler(args)
}

test('noteSession keeps the first valid id', () => {
  const s = new Session(tmpRoot())
  assert.equal(s.sessionId, null)
  s.noteSession('not a session id')
  assert.equal(s.sessionId, null)
  s.noteSession(SID)
  s.noteSession(OTHER)
  assert.equal(s.sessionId, SID)
})

test('the implicit swarm is named after the session and its swarm.started carries the id', () => {
  const root = tmpRoot()
  const s = new Session(root)
  s.noteSession(SID)
  const id = s.swarmOrCreate(NOW)
  assert.equal(id, 'session-abcdef12')
  assert.equal(readCurrent(root), id)
  assert.equal(s.owned, true)
  const [started] = readEvents(swarmLogPath(root, id)).events
  assert.deepEqual(started?.data, { name: id, topology: 'hierarchical', implicit: true, session: SID })
})

test('without a session id the implicit swarm is named by time and carries no id', () => {
  const root = tmpRoot()
  const id = new Session(root).swarmOrCreate(NOW)
  assert.equal(id, 'session-20261021-100000')
  const [started] = readEvents(swarmLogPath(root, id)).events
  assert.deepEqual(started?.data, { name: id, topology: 'hierarchical', implicit: true })
})

test('a restarted server owns the swarm its session started', () => {
  const root = tmpRoot()
  const first = new Session(root)
  first.noteSession(SID)
  const id = first.swarmOrCreate(NOW)

  const restarted = new Session(root)
  restarted.noteSession(SID)
  assert.equal(restarted.swarmOrCreate(NOW), id)
  assert.equal(restarted.owned, true)
  assert.match(toolsFor(root, restarted)('omnis_swarm_end').text, /ended/)
})

test('a swarm another session started is adopted but not owned', () => {
  const root = tmpRoot()
  const theirs = new Session(root)
  theirs.noteSession(OTHER)
  const id = theirs.swarmOrCreate(NOW)

  const mine = new Session(root)
  mine.noteSession(SID)
  assert.equal(mine.swarmOrCreate(NOW), id)
  assert.equal(mine.owned, false)
})

test('ownership is worked out once the session id arrives', () => {
  const root = tmpRoot()
  const first = new Session(root)
  first.noteSession(SID)
  const id = first.swarmOrCreate(NOW)

  const restarted = new Session(root)
  assert.equal(restarted.mySwarm(), id)
  assert.equal(restarted.owned, false)
  restarted.noteSession(SID)
  assert.equal(restarted.owned, true)
})

test('mySwarm(false) adopts current only when the log says it is ours', () => {
  const root = tmpRoot()
  const first = new Session(root)
  first.noteSession(SID)
  const id = first.swarmOrCreate(NOW)

  const stranger = new Session(root)
  stranger.noteSession(OTHER)
  assert.equal(stranger.mySwarm(false), null)

  const restarted = new Session(root)
  restarted.noteSession(SID)
  assert.equal(restarted.mySwarm(false), id)
  assert.equal(restarted.owned, true)
})

test('after a restart, omnis_swarm_init renames our implicit swarm instead of starting another', () => {
  const root = tmpRoot()
  const first = new Session(root)
  first.noteSession(SID)
  const id = first.swarmOrCreate(NOW)

  const restarted = new Session(root)
  restarted.noteSession(SID)
  assert.match(toolsFor(root, restarted)('omnis_swarm_init', { name: 'Auth', topology: 'mesh' }).text, /now names the running session swarm/)
  assert.equal(readCurrent(root), id)
})

test('omnis_swarm_init stamps the session id on a new swarm when it is known', () => {
  const root = tmpRoot()
  const s = new Session(root)
  s.noteSession(SID)
  toolsFor(root, s)('omnis_swarm_init', { name: 'Explicit', topology: 'star' })
  const [started] = readEvents(swarmLogPath(root, 'explicit')).events
  assert.deepEqual(started?.data, { name: 'Explicit', topology: 'star', implicit: false, session: SID })
})

test('swarmOwner reads the first swarm.started only, and is null when there is none', () => {
  const root = tmpRoot()
  const id = uniqueSwarmId(root, 'owned')
  assert.equal(swarmOwner(root, id), null)
  appendEvent(root, ev('swarm.started', { name: 'owned', topology: 'mesh', implicit: false, session: SID }, { swarm: id, src: 'mcp' }))
  appendEvent(root, ev('swarm.started', { name: 'renamed', topology: 'mesh', implicit: false, session: OTHER }, { swarm: id, src: 'mcp', atSec: 1 }))
  assert.equal(swarmOwner(root, id), SID)
  assert.equal(swarmOwner(root, 'missing'), null)
})
