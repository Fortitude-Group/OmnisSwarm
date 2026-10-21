import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendEvent, isValidSwarmId, readCurrent, readEvents, swarmLogPath, writeCurrent } from '../../src/core/log.ts'
import { announceSwarm, publishCurrent, slugify, uniqueSwarmId } from '../../src/core/swarm.ts'
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

test('300 same-name claims are numbered in order and each takes at most one attempt', () => {
  const root = tmpRoot()
  let last = ''
  for (let i = 0; i < 300; i++) {
    let attempts = 0
    last = uniqueSwarmId(root, 'Busy', () => attempts++)
    assert.ok(attempts <= 2, `init ${i} took ${attempts} attempts`)
  }
  assert.equal(last, 'busy-300')
})

test('a name whose numbered id hit the cap still finds a free gap', () => {
  const root = tmpRoot()
  assert.equal(uniqueSwarmId(root, 'auth'), 'auth')
  writeFileSync(swarmLogPath(root, 'auth-10001'), '')
  assert.equal(uniqueSwarmId(root, 'auth'), 'auth-2')
})

test('one poisoned number does not slow later claims', () => {
  const root = tmpRoot()
  assert.equal(uniqueSwarmId(root, 'auth'), 'auth')
  writeFileSync(swarmLogPath(root, 'auth-10001'), '')
  const ids: string[] = []
  for (let i = 0; i < 50; i++) {
    let attempts = 0
    ids.push(uniqueSwarmId(root, 'auth', () => attempts++))
    assert.equal(attempts, 2, `init ${i}: the bare name, then the lowest free number`)
  }
  assert.deepEqual(ids, Array.from({ length: 50 }, (_, i) => `auth-${i + 2}`))
})
