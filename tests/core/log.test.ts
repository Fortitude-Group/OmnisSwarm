import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { serialise, SCHEMA_VERSION } from '../../src/core/events.ts'
import {
  appendEvent, clearCurrent, ensureGitignore, isValidSwarmId, readCurrent, readEvents,
  sortEvents, swarmLogPath, writeCurrent,
} from '../../src/core/log.ts'
import { ev, tmpRoot } from '../helpers.ts'

const msg = (n: number, atSec = n) => ev('message.sent', { to: 'b', summary: `m${n}` }, { agent: 'a', atSec })

test('appendEvent writes one line per event and readEvents reads them back', () => {
  const root = tmpRoot()
  assert.equal(appendEvent(root, msg(1)), true)
  assert.equal(appendEvent(root, msg(2)), true)
  const file = swarmLogPath(root, 's1')
  const read = readEvents(file)
  assert.deepEqual(read.events, [msg(1), msg(2)])
  assert.equal(read.offset, readFileSync(file).length)
  assert.equal(read.bad, 0)
  assert.equal(read.reset, false)
})

test('readEvents resumes from an offset', () => {
  const root = tmpRoot()
  appendEvent(root, msg(1))
  const first = readEvents(swarmLogPath(root, 's1'))
  appendEvent(root, msg(2))
  const next = readEvents(swarmLogPath(root, 's1'), first.offset)
  assert.deepEqual(next.events, [msg(2)])
})

test('readEvents holds back a half-written last line until it is complete', () => {
  const root = tmpRoot()
  appendEvent(root, msg(1))
  const file = swarmLogPath(root, 's1')
  const line = serialise(msg(2))
  appendFileSync(file, line.slice(0, 10))
  const first = readEvents(file)
  assert.equal(first.events.length, 1)
  appendFileSync(file, line.slice(10))
  const second = readEvents(file, first.offset)
  assert.deepEqual(second.events, [msg(2)])
})

test('readEvents counts corrupt lines and skips newer versions', () => {
  const root = tmpRoot()
  appendEvent(root, msg(1))
  const file = swarmLogPath(root, 's1')
  appendFileSync(file, '{broken\n')
  appendFileSync(file, `${JSON.stringify({ ...msg(2), v: SCHEMA_VERSION + 1 })}\n`)
  appendEvent(root, msg(3))
  const read = readEvents(file)
  assert.deepEqual(read.events, [msg(1), msg(3)])
  assert.equal(read.bad, 1)
  assert.equal(read.skipped, 1)
})

test('readEvents starts over when the file shrinks', () => {
  const root = tmpRoot()
  appendEvent(root, msg(1))
  appendEvent(root, msg(2))
  const file = swarmLogPath(root, 's1')
  const before = readEvents(file)
  writeFileSync(file, serialise(msg(9)))
  const after = readEvents(file, before.offset)
  assert.equal(after.reset, true)
  assert.deepEqual(after.events, [msg(9)])
})

test('readEvents on a missing file returns nothing', () => {
  const read = readEvents(join(tmpRoot(), 'nope.jsonl'), 5)
  assert.deepEqual(read, { events: [], offset: 5, bad: 0, skipped: 0, reset: false })
})

test('swarm ids are checked so paths cannot escape the log folder', () => {
  for (const bad of ['', '..', '../x', 'a/b', 'a\b', '.hidden', 'x'.repeat(65)]) assert.equal(isValidSwarmId(bad), false, bad)
  for (const good of ['auth-refactor', 'session-20261021-100000', 'v1.2_x']) assert.equal(isValidSwarmId(good), true, good)
  assert.throws(() => swarmLogPath(tmpRoot(), '../x'))
})

test('the current swarm round-trips and clears', () => {
  const root = tmpRoot()
  assert.equal(readCurrent(root), null)
  writeCurrent(root, 'auth')
  assert.equal(readCurrent(root), 'auth')
  clearCurrent(root)
  assert.equal(readCurrent(root), null)
  assert.throws(() => writeCurrent(root, '../x'))
})

test('the log folder is added to .gitignore once', () => {
  const root = tmpRoot()
  writeFileSync(join(root, '.gitignore'), 'node_modules/')
  ensureGitignore(root)
  ensureGitignore(root)
  assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), 'node_modules/\n.omnis-swarm/\n')
})

test('sortEvents orders by time, then source, then file order', () => {
  const late = msg(1, 5)
  const mcp = ev('memory.put', { key: 'k', bytes: 1, preview: 'v' }, { atSec: 2, src: 'mcp' })
  const recorder = msg(2, 2)
  const recorder2 = msg(3, 2)
  assert.deepEqual(sortEvents([late, recorder, mcp, recorder2]), [mcp, recorder, recorder2, late])
})
