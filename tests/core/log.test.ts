import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { serialise, SCHEMA_VERSION } from '../../src/core/events.ts'
import {
  appendEvent, clearCurrent, ensureGitignore, ensureLogDirs, isValidSwarmId, logPaths, MAX_READ_BYTES, readCurrent, readEvents,
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
  for (const bad of ['', '..', '../x', 'a/b', 'a\\b', '.hidden', 'x'.repeat(65)]) assert.equal(isValidSwarmId(bad), false, bad)
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

// Fix round 1

test('a line of 100,000 characters counts as bad without being parsed', () => {
  const root = tmpRoot()
  appendEvent(root, msg(1))
  const file = swarmLogPath(root, 's1')
  appendFileSync(file, `${'x'.repeat(100_000)}\n`)
  appendEvent(root, msg(2))
  const read = readEvents(file)
  assert.deepEqual(read.events, [msg(1), msg(2)])
  assert.equal(read.bad, 1)
  assert.equal(read.offset, readFileSync(file).length)
})

test('a 3 MB file is read completely over several bounded calls', () => {
  const root = tmpRoot()
  const file = swarmLogPath(root, 's1')
  ensureLogDirs(root)
  const lines: string[] = []
  let n = 0
  let bytes = 0
  while (bytes < 3 * 1024 * 1024) {
    const line = serialise(msg(n++, n % 1000))
    lines.push(line)
    bytes += line.length
  }
  writeFileSync(file, lines.join(''))
  let offset = 0
  let calls = 0
  const seen: unknown[] = []
  while (offset < bytes) {
    const read = readEvents(file, offset)
    assert.ok(read.offset - offset <= MAX_READ_BYTES)
    assert.ok(read.offset > offset)
    seen.push(...read.events)
    offset = read.offset
    calls++
  }
  assert.ok(calls >= 3)
  assert.equal(offset, bytes)
  assert.equal(seen.length, n)
  assert.deepEqual(seen[n - 1], msg(n - 1, (n - 1 + 1) % 1000))
})

test('a long tail with no newline does not block later good lines', () => {
  const root = tmpRoot()
  appendEvent(root, msg(1))
  const file = swarmLogPath(root, 's1')
  appendFileSync(file, 'y'.repeat(5000))
  const first = readEvents(file)
  assert.deepEqual(first.events, [msg(1)])
  assert.equal(first.bad, 1)
  assert.equal(first.offset, readFileSync(file).length)
  appendFileSync(file, '\n')
  appendEvent(root, msg(2))
  const second = readEvents(file, first.offset)
  assert.deepEqual(second.events, [msg(2)])
})

test('a junction in place of the log folder is never written through', t => {
  const root = tmpRoot()
  const outside = tmpRoot()
  try {
    symlinkSync(outside, logPaths(root).dir, 'junction')
  } catch {
    t.skip('cannot create a junction here')
    return
  }
  assert.equal(appendEvent(root, msg(1)), false)
  assert.throws(() => writeCurrent(root, 'auth'))
  assert.deepEqual(readdirSync(outside), [])
})

test('a junction in place of the swarms folder is refused', t => {
  const root = tmpRoot()
  const outside = tmpRoot()
  mkdirSync(logPaths(root).dir)
  try {
    symlinkSync(outside, logPaths(root).swarms, 'junction')
  } catch {
    t.skip('cannot create a junction here')
    return
  }
  assert.equal(appendEvent(root, msg(1)), false)
  assert.deepEqual(readdirSync(outside), [])
})

test('a symlinked current file and a symlinked .gitignore are not written through', t => {
  const root = tmpRoot()
  const outside = join(tmpRoot(), 'target')
  writeFileSync(outside, 'keep')
  ensureLogDirs(root)
  try {
    symlinkSync(outside, logPaths(root).current, 'file')
    symlinkSync(outside, join(root, 'link-ignore'), 'file')
  } catch {
    t.skip('cannot create file symlinks here')
    return
  }
  assert.throws(() => writeCurrent(root, 'auth'))
  const root2 = tmpRoot()
  symlinkSync(outside, join(root2, '.gitignore'), 'file')
  ensureGitignore(root2)
  assert.equal(readFileSync(outside, 'utf8'), 'keep')
})

test('ids are lowercase only, so case cannot make two names for one file', () => {
  assert.equal(isValidSwarmId('Auth'), false)
  assert.equal(isValidSwarmId('auth'), true)
})

test('Windows reserved names and trailing dots are not valid ids', () => {
  for (const bad of ['nul', 'com1', 'aux.log', 'x.', 'lpt9', 'con']) assert.equal(isValidSwarmId(bad), false, bad)
  assert.equal(isValidSwarmId('console'), true)
})

test('readCurrent reads only the first 128 bytes', () => {
  const root = tmpRoot()
  ensureLogDirs(root)
  writeFileSync(logPaths(root).current, `${'a'.repeat(1_000_000)}\n`)
  assert.equal(readCurrent(root), null)
})

test('error messages embed at most 80 characters of a bad id', () => {
  const err = assert.throws(() => swarmLogPath(tmpRoot(), 'Z'.repeat(5000)), (e: Error) => e.message.length < 200)
  assert.equal(err, undefined)
})

// Fix round 2

test('readers refuse a symlinked log file and a symlinked current file', t => {
  const root = tmpRoot()
  appendEvent(root, msg(1))
  const real = swarmLogPath(root, 's1')
  const link = swarmLogPath(root, 's2')
  const curLink = logPaths(root).current
  const target = join(logPaths(root).dir, 'real-current')
  writeFileSync(target, 'auth\n')
  try {
    symlinkSync(real, link, 'file')
    symlinkSync(target, curLink, 'file')
  } catch {
    t.skip('cannot create file symlinks here')
    return
  }
  assert.deepEqual(readEvents(link), { events: [], offset: 0, bad: 0, skipped: 0, reset: false })
  assert.equal(readCurrent(root), null)
  assert.equal(readEvents(real).events.length, 1)
})

test('readers refuse a directory where a file should be', () => {
  const root = tmpRoot()
  ensureLogDirs(root)
  mkdirSync(logPaths(root).current)
  assert.equal(readCurrent(root), null)
  const dirAsLog = join(logPaths(root).swarms, 'd.jsonl')
  mkdirSync(dirAsLog)
  assert.deepEqual(readEvents(dirAsLog), { events: [], offset: 0, bad: 0, skipped: 0, reset: false })
})

test('a .gitignore that is a directory does not stop logging', () => {
  const root = tmpRoot()
  mkdirSync(join(root, '.gitignore'))
  assert.equal(appendEvent(root, msg(1)), true)
  assert.equal(readEvents(swarmLogPath(root, 's1')).events.length, 1)
})

test('readEvents treats a bad offset as 0 and reports a reset', () => {
  const root = tmpRoot()
  appendEvent(root, msg(1))
  const file = swarmLogPath(root, 's1')
  for (const bad of [-5, Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
    const read = readEvents(file, bad)
    assert.equal(read.reset, true, String(bad))
    assert.deepEqual(read.events, [msg(1)], String(bad))
  }
})
