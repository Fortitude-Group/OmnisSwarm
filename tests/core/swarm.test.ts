import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendEvent, readCurrent, readEvents, swarmLogPath, writeCurrent } from '../../src/core/log.ts'
import { ensureSwarm, slugify, uniqueSwarmId } from '../../src/core/swarm.ts'
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
