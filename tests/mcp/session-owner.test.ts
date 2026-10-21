import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendEvent, readCurrent, readEvents, swarmLogPath } from '../../src/core/log.ts'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { sessionKey, swarmOwner, uniqueSwarmId } from '../../src/core/swarm.ts'
import { Session } from '../../src/mcp/session.ts'
import { createTools } from '../../src/mcp/tools.ts'
import { ev, tmpRoot } from '../helpers.ts'

const NOW = new Date('2026-10-21T10:00:00.000Z')
const SID = 'abcdef12-3456-7890-abcd-ef1234567890'
const KEY = sessionKey(SID)
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
  assert.equal(id, `session-${KEY.slice(0, 8)}`)
  assert.equal(readCurrent(root), id)
  assert.equal(s.owned, true)
  const [started] = readEvents(swarmLogPath(root, id)).events
  assert.deepEqual(started?.data, { name: id, topology: 'hierarchical', implicit: true, session: sessionKey(SID) })
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

test("a session with a known id starts its own swarm rather than adopt another session's", () => {
  const root = tmpRoot()
  const theirs = new Session(root)
  theirs.noteSession(OTHER)
  const id = theirs.swarmOrCreate(NOW)

  const mine = new Session(root)
  mine.noteSession(SID)
  const own = mine.swarmOrCreate(NOW)
  assert.notEqual(own, id)
  assert.equal(mine.owned, true)
  assert.equal(readCurrent(root), id)
})

test('a session with no known id still adopts a live current, not owned', () => {
  const root = tmpRoot()
  const theirs = new Session(root)
  theirs.noteSession(OTHER)
  const id = theirs.swarmOrCreate(NOW)
  const mine = new Session(root)
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
  assert.deepEqual(started?.data, { name: 'Explicit', topology: 'star', implicit: false, session: KEY })
})

test('swarmOwner reads the first swarm.started only, and is null when there is none', () => {
  const root = tmpRoot()
  const id = uniqueSwarmId(root, 'owned')
  assert.equal(swarmOwner(root, id), null)
  appendEvent(root, ev('swarm.started', { name: 'owned', topology: 'mesh', implicit: false, session: KEY }, { swarm: id, src: 'mcp' }))
  appendEvent(root, ev('swarm.started', { name: 'renamed', topology: 'mesh', implicit: false, session: sessionKey(OTHER) }, { swarm: id, src: 'mcp', atSec: 1 }))
  assert.equal(swarmOwner(root, id), KEY)
  assert.equal(swarmOwner(root, 'missing'), null)
})

test('the raw session id never appears in the log', () => {
  const root = tmpRoot()
  const s = new Session(root)
  s.noteSession(SID)
  const id = s.swarmOrCreate(NOW)
  assert.ok(!readFileSync(swarmLogPath(root, id), 'utf8').includes(SID))
})

test('presenting the key read from the log does not grant ownership', () => {
  const root = tmpRoot()
  const first = new Session(root)
  first.noteSession(SID)
  const id = first.swarmOrCreate(NOW)
  const key = swarmOwner(root, id)!
  const attacker = new Session(root)
  attacker.noteSession(key.padEnd(36, '0').replace(/(.{8})(.{4})(.{4})(.{4})(.*)/, '$1-$2-$3-$4-$5'))
  attacker.mySwarm()
  assert.equal(attacker.owned, false)
})

test('a conflicting second session id switches log ownership off', () => {
  const root = tmpRoot()
  const first = new Session(root)
  first.noteSession(SID)
  first.swarmOrCreate(NOW)
  const restarted = new Session(root)
  restarted.noteSession(SID)
  const write = process.stderr.write
  let warned = 0
  process.stderr.write = (() => { warned++; return true }) as typeof process.stderr.write
  try {
    restarted.noteSession(OTHER)
    restarted.noteSession(OTHER)
  } finally {
    process.stderr.write = write
  }
  assert.equal(warned, 1)
  assert.equal(restarted.sessionKey, null)
  assert.equal(restarted.mySwarm(false), null)
  assert.equal(restarted.owned, false)
})

test('a swarm started before the session id was known is still owned after a restart', () => {
  const root = tmpRoot()
  const first = new Session(root)
  const id = first.swarmOrCreate(NOW)
  first.noteSession(SID)
  assert.equal(first.owned, true)

  const restarted = new Session(root)
  restarted.noteSession(SID)
  assert.equal(restarted.swarmOrCreate(NOW), id)
  assert.equal(restarted.owned, true)
  assert.match(toolsFor(root, restarted)('omnis_swarm_end').text, /ended/)
})

test('a failed re-announce writes one line to stderr', () => {
  const root = tmpRoot()
  const s = new Session(root)
  const id = s.swarmOrCreate(NOW)
  const file = swarmLogPath(root, id)
  s.state(id)
  rmSync(file)
  mkdirSync(file)
  const write = process.stderr.write
  const lines: string[] = []
  process.stderr.write = ((chunk: string) => { lines.push(String(chunk)); return true }) as typeof process.stderr.write
  try {
    s.noteSession(SID)
  } finally {
    process.stderr.write = write
  }
  assert.equal(lines.length, 1)
  assert.match(lines[0]!, /could not stamp the session on swarm session-/)
})

const THIRD = 'cccccccc-1111-2222-3333-444444444444'
/** Runs `fn` with stderr silenced: a second session id warns once. */
function quietly(fn: () => void): void {
  const write = process.stderr.write
  process.stderr.write = (() => true) as typeof process.stderr.write
  try {
    fn()
  } finally {
    process.stderr.write = write
  }
}

test("after a second session id the session never adopts another session's live current", () => {
  const root = tmpRoot()
  const theirs = new Session(root)
  theirs.noteSession(OTHER)
  const id = theirs.swarmOrCreate(NOW)

  // After /clear or a resume the process carries on under a new id, and a hot reload sends it.
  const mine = new Session(root)
  quietly(() => {
    mine.noteSession(SID)
    mine.noteSession(THIRD)
  })
  assert.equal(mine.mySwarm(), null)
  const own = mine.swarmOrCreate(NOW)
  assert.notEqual(own, id)
  assert.equal(own, `session-${sessionKey(THIRD).slice(0, 8)}`)
  assert.equal(mine.owned, true)
  assert.equal(readCurrent(root), id)
  // Log ownership stays off after a second id, so the new swarm carries no session key.
  assert.equal(swarmOwner(root, own), null)
})

test('after a second session id the swarm this process started stays its own', () => {
  const root = tmpRoot()
  const s = new Session(root)
  s.noteSession(SID)
  const own = s.swarmOrCreate(NOW)
  quietly(() => s.noteSession(THIRD))
  assert.equal(s.swarmOrCreate(NOW), own)
  assert.equal(s.owned, true)
})
