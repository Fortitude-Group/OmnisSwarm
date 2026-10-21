import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendEvent, isValidSwarmId, readCurrent, readEvents, swarmLogPath, writeCurrent } from '../../src/core/log.ts'
import { announceSwarm, ensureSwarm, publishCurrent, slugify, uniqueSwarmId } from '../../src/core/swarm.ts'
import { ev, tmpRoot } from '../helpers.ts'

test('slugify makes a safe id from a human name', () => {
  assert.equal(slugify('Auth Refactor!'), 'auth-refactor')
  assert.equal(slugify('  --weird__name--  '), 'weird-name')
  assert.equal(slugify('!!!'), '')
  assert.equal(slugify('x'.repeat(100)).length, 64)
})

test('uniqueSwarmId adds a number when the id is taken', () => {
  const root = tmpRoot()
  assert.equal(uniqueSwarmId(root, 'Auth'), 'auth')
  appendEvent(root, ev('swarm.ended', {}, { swarm: 'auth', src: 'mcp' }))
  assert.equal(uniqueSwarmId(root, 'Auth'), 'auth-2')
  assert.equal(uniqueSwarmId(root, '???'), 'swarm')
})

test('ensureSwarm returns the current swarm when there is one', () => {
  const root = tmpRoot()
  writeCurrent(root, 'auth')
  assert.equal(ensureSwarm(root, { idHint: 'session-x', src: 'mcp' }), 'auth')
})

test('ensureSwarm starts an implicit swarm when there is none', () => {
  const root = tmpRoot()
  const now = new Date('2026-10-21T10:00:00.000Z')
  const id = ensureSwarm(root, { idHint: 'session-20261021-100000', src: 'mcp', now })
  assert.equal(id, 'session-20261021-100000')
  assert.equal(readCurrent(root), id)
  const [started] = readEvents(swarmLogPath(root, id)).events
  assert.deepEqual(started, {
    v: 1, ts: now.toISOString(), swarm: id, src: 'mcp', type: 'swarm.started',
    data: { name: id, topology: 'hierarchical', implicit: true },
  })
})

test('uniqueSwarmId prefixes slugs that are not valid ids', () => {
  const root = tmpRoot()
  assert.equal(uniqueSwarmId(root, 'NUL'), 'swarm-nul')
  assert.ok(uniqueSwarmId(root, 'con.txt').startsWith('swarm-'))
})

test('slugify collapses dot runs so ids stay valid', () => {
  for (const name of ['a..b', 'Release v1..2']) assert.ok(isValidSwarmId(uniqueSwarmId(tmpRoot(), name)), name)
  assert.equal(slugify('a..b'), 'a.b')
})

test('collision suffixes keep the id valid and within 64 characters', () => {
  const root = tmpRoot()
  const base = 'a'.repeat(64)
  assert.equal(uniqueSwarmId(root, base), base)
  for (let n = 2; n < 1000; n++) {
    const taken = swarmLogPath(root, `${base.slice(0, 63 - String(n).length)}-${n}`)
    writeFileSync(taken, '')
  }
  const next = uniqueSwarmId(root, base)
  assert.ok(isValidSwarmId(next) && next.length <= 64 && next.endsWith('-1000'))
})

test('uniqueSwarmId claims the id, so the same name is never handed out twice', () => {
  const root = tmpRoot()
  assert.equal(uniqueSwarmId(root, 'Auth'), 'auth')
  assert.equal(uniqueSwarmId(root, 'Auth'), 'auth-2')
})

test('two ensureSwarm calls with different hints agree with current', () => {
  const root = tmpRoot()
  const a = ensureSwarm(root, { idHint: 'one', src: 'mcp' })
  const b = ensureSwarm(root, { idHint: 'two', src: 'recorder' })
  assert.ok(isValidSwarmId(a) && isValidSwarmId(b))
  assert.equal(readCurrent(root), a)
  assert.equal(b, a)
})

test('ensureSwarm propagates a failure to set up the log folder', () => {
  const root = tmpRoot()
  writeFileSync(join(root, '.omnis-swarm'), 'not a folder')
  assert.throws(() => ensureSwarm(root, { idHint: 'x', src: 'mcp' }))
})

test('two writers starting together end up in the same swarm (A1, B1, A2, B2)', () => {
  const root = tmpRoot()
  const a = uniqueSwarmId(root, 'session-1')
  const b = uniqueSwarmId(root, 'session-1')
  assert.notEqual(a, b)
  announceSwarm(root, a, { src: 'mcp' })
  const wonA = publishCurrent(root, a)
  announceSwarm(root, b, { src: 'recorder' })
  const wonB = publishCurrent(root, b)
  assert.equal(wonA, a)
  assert.equal(wonB, a)
  assert.equal(readCurrent(root), a)
  assert.ok(!existsSync(swarmLogPath(root, b)), 'the loser drops its own empty swarm')
  assert.ok(existsSync(swarmLogPath(root, a)))
})

test('a loser keeps its log if it holds more than its own start line', () => {
  const root = tmpRoot()
  const a = uniqueSwarmId(root, 'x')
  const b = uniqueSwarmId(root, 'x')
  announceSwarm(root, b, { src: 'mcp' })
  appendEvent(root, ev('swarm.ended', {}, { swarm: b, src: 'mcp' }))
  publishCurrent(root, a)
  assert.equal(publishCurrent(root, b), a)
  assert.ok(existsSync(swarmLogPath(root, b)))
})

test('a current marker holding junk is overwritten', () => {
  const root = tmpRoot()
  const id = uniqueSwarmId(root, 'x')
  writeFileSync(join(root, '.omnis-swarm', 'current'), 'not a valid id!!' + '\n')
  assert.equal(publishCurrent(root, id), id)
  assert.equal(readCurrent(root), id)
})
