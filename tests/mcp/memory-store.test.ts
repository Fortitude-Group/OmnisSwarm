import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureLogDirs, logPaths } from '../../src/core/log.ts'
import { MAX_KEYS, MAX_VALUE_BYTES, putMemory, readMemory, releaseLock, takeLock, takeOverStale } from '../../src/mcp/memory-store.ts'
import { tmpRoot } from '../helpers.ts'

const now = new Date('2026-10-21T10:00:00.000Z')

test('values round-trip and later writes replace earlier ones', () => {
  const root = tmpRoot()
  putMemory(root, 's1', 'design/auth', 'v1', 'a1', now)
  putMemory(root, 's1', 'design/auth', 'v2', 'a2', now)
  putMemory(root, 's1', 'other', 'x', 'lead', now)
  const all = readMemory(root, 's1')
  assert.deepEqual({ ...all['design/auth'] }, { value: 'v2', writer: 'a2', at: now.toISOString() })
  assert.deepEqual(Object.keys(all).sort(), ['design/auth', 'other'])
})

test('a missing or corrupt file reads as empty', () => {
  const root = tmpRoot()
  assert.deepEqual(Object.keys(readMemory(root, 's1')), [])
  putMemory(root, 's1', 'k', 'v', 'lead', now)
  writeFileSync(join(logPaths(root).memory, 's1.json'), '{nope')
  assert.deepEqual(Object.keys(readMemory(root, 's1')), [])
})

test('an invalid swarm id is refused', () => {
  assert.throws(() => readMemory(tmpRoot(), '../x'))
  assert.throws(() => putMemory(tmpRoot(), '../x', 'k', 'v', 'lead'))
})

test('a symlinked memory file is refused', t => {
  const root = tmpRoot()
  putMemory(root, 's1', 'k', 'v', 'lead', now)
  const real = join(logPaths(root).memory, 's1.json')
  const target = join(root, 'elsewhere.json')
  writeFileSync(target, JSON.stringify({ k: { value: 'v', writer: 'w', at: 'a' } }))
  try {
    rmSync(real)
    symlinkSync(target, real, 'file')
  } catch {
    t.skip('cannot create a symlink here')
    return
  }
  assert.deepEqual(Object.keys(readMemory(root, 's1')), [])
})

test('a malformed entry is dropped and the good ones kept', () => {
  const root = tmpRoot()
  putMemory(root, 's1', 'seed', 'v', 'lead', now)
  const good = { value: 'v', writer: 'w', at: 'a' }
  writeFileSync(join(logPaths(root).memory, 's1.json'), `{"good":${JSON.stringify(good)},"bad1":{"value":1,"writer":"w","at":"a"},"bad2":"str","bad3":null,"bad4":{"value":"v"},"__proto__":${JSON.stringify(good)},"constructor":${JSON.stringify(good)},"prototype":${JSON.stringify(good)}}`)
  assert.deepEqual(Object.keys(readMemory(root, 's1')), ['good'])
})

test('an oversize file reads as empty', () => {
  const root = tmpRoot()
  putMemory(root, 's1', 'k', 'v', 'lead', now)
  const big = JSON.stringify({ k: { value: 'x'.repeat(4 * 1024 * 1024 + 10), writer: 'w', at: 'a' } })
  writeFileSync(join(logPaths(root).memory, 's1.json'), big)
  assert.deepEqual(Object.keys(readMemory(root, 's1')), [])
})

const good = { k: { value: 'v', writer: 'w', at: 'a' } }

test('fix 1: an oversized value is refused and earlier values survive', () => {
  const root = tmpRoot()
  putMemory(root, 's1', 'k', 'v', 'lead', now)
  assert.throws(() => putMemory(root, 's1', 'big', 'x'.repeat(5 * 1024 * 1024), 'lead', now))
  assert.throws(() => putMemory(root, 's1', 'big', 'x'.repeat(MAX_VALUE_BYTES + 1), 'lead', now))
  assert.deepEqual(Object.keys(readMemory(root, 's1')), ['k'])
})

test('fix 1: bad keys and writers are refused', () => {
  const root = tmpRoot()
  for (const key of ['__proto__', 'constructor', 'prototype', '', 'a b', 'x'.repeat(129)]) {
    assert.throws(() => putMemory(root, 's1', key, 'v', 'lead', now), /invalid memory key/)
  }
  assert.throws(() => putMemory(root, 's1', 'k', 'v', '', now), /writer/)
  assert.throws(() => putMemory(root, 's1', 'k', 'v', 'bad name', now), /writer/)
})

test('fix 1: key 513 is refused, replacing an existing key is not', () => {
  const root = tmpRoot()
  for (let i = 0; i < MAX_KEYS; i++) putMemory(root, 's1', `k${i}`, 'v', 'lead', now)
  assert.throws(() => putMemory(root, 's1', 'one-more', 'v', 'lead', now), /full/)
  putMemory(root, 's1', 'k0', 'new', 'lead', now)
  assert.equal(readMemory(root, 's1')['k0']?.value, 'new')
  assert.equal(Object.keys(readMemory(root, 's1')).length, MAX_KEYS)
})

test('fix 1: a corrupt, oversize or directory store makes put throw and stays unchanged', () => {
  const root = tmpRoot()
  putMemory(root, 's1', 'k', 'v', 'lead', now)
  const file = join(logPaths(root).memory, 's1.json')
  writeFileSync(file, '{nope')
  assert.throws(() => putMemory(root, 's1', 'k2', 'v', 'lead', now), /unusable/)
  assert.equal(readFileSync(file, 'utf8'), '{nope')
  const big = ' '.repeat(4 * 1024 * 1024 + 10)
  writeFileSync(file, big)
  assert.throws(() => putMemory(root, 's1', 'k2', 'v', 'lead', now), /unusable/)
  assert.equal(statSync(file).size, big.length)
  rmSync(file)
  mkdirSync(file)
  assert.deepEqual(Object.keys(readMemory(root, 's1')), [])
  assert.throws(() => putMemory(root, 's1', 'k2', 'v', 'lead', now), /unusable/)
  assert.equal(statSync(file).isDirectory(), true)
})

test('fix 2: no lock or temp files are left behind, and a stale lock is cleared', () => {
  const root = tmpRoot()
  putMemory(root, 's1', 'k', 'v', 'lead', now)
  const dir = logPaths(root).memory
  const lock = join(dir, 's1.json.lock')
  writeFileSync(lock, '999999')
  const old = new Date(Date.now() - 60_000)
  utimesSync(lock, old, old)
  putMemory(root, 's1', 'k2', 'v', 'lead', now)
  assert.deepEqual(readdirSync(dir), ['s1.json'])
})

test('fix 2: a fresh lock held by someone else makes put give up', { timeout: 10_000 }, () => {
  const root = tmpRoot()
  putMemory(root, 's1', 'k', 'v', 'lead', now)
  writeFileSync(join(logPaths(root).memory, 's1.json.lock'), '1')
  assert.throws(() => putMemory(root, 's1', 'k2', 'v', 'lead', now), /busy/)
  assert.deepEqual(Object.keys(readMemory(root, 's1')), ['k'])
})

test('fix 2: two processes writing at once lose nothing', { timeout: 60_000 }, async () => {
  const root = tmpRoot()
  const script = fileURLToPath(new URL('./fixtures/put-many.ts', import.meta.url))
  const run = (prefix: string) => new Promise<{ code: number | null; err: string }>(resolve => {
    const child = spawn(process.execPath, [script, root, prefix], { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', d => { err += String(d) })
    child.on('close', code => resolve({ code, err }))
  })
  const results = await Promise.all([run('a'), run('b')])
  assert.deepEqual(results, [{ code: 0, err: '' }, { code: 0, err: '' }])
  assert.equal(Object.keys(readMemory(root, 's1')).length, 200)
})

test('several processes making the first write to a fresh project all succeed', { timeout: 120_000 }, async () => {
  const script = fileURLToPath(new URL('./fixtures/first-put.ts', import.meta.url))
  const run = (root: string, prefix: string, startAt: number) => new Promise<{ code: number | null; err: string }>(resolve => {
    const child = spawn(process.execPath, [script, root, prefix, String(startAt)], { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', d => { err += String(d) })
    child.on('close', code => resolve({ code, err }))
  })
  const writers = ['a', 'b', 'c', 'd', 'e', 'f']
  for (let round = 0; round < 4; round++) {
    const root = tmpRoot()
    const startAt = Date.now() + 1500
    const results = await Promise.all(writers.map(w => run(root, w, startAt)))
    assert.deepEqual(results, writers.map(() => ({ code: 0, err: '' })), `round ${round}`)
    assert.equal(Object.keys(readMemory(root, 's1')).length, writers.length)
  }
})

test('fix 3: reads refuse a linked memory folder', t => {
  const root = tmpRoot()
  const outside = tmpRoot()
  writeFileSync(join(outside, 's1.json'), JSON.stringify(good))
  ensureLogDirs(root)
  const memory = logPaths(root).memory
  rmSync(memory, { recursive: true })
  try {
    symlinkSync(outside, memory, 'junction')
  } catch {
    t.skip('cannot create a junction here')
    return
  }
  assert.deepEqual(Object.keys(readMemory(root, 's1')), [])
})

test('fix 3: reads refuse a linked .omnis-swarm folder', t => {
  const root = tmpRoot()
  const outside = tmpRoot()
  mkdirSync(join(outside, 'memory'))
  writeFileSync(join(outside, 'memory', 's1.json'), JSON.stringify(good))
  try {
    symlinkSync(outside, logPaths(root).dir, 'junction')
  } catch {
    t.skip('cannot create a junction here')
    return
  }
  assert.deepEqual(Object.keys(readMemory(root, 's1')), [])
})

test('fix 4: an ensureLogDirs error propagates from put', () => {
  const root = tmpRoot()
  mkdirSync(join(root, '.omnis-swarm'))
  writeFileSync(join(root, '.omnis-swarm', 'memory'), 'not a folder')
  assert.throws(() => putMemory(root, 's1', 'k', 'v', 'lead', now), /plain directory/)
})

test('round 2 A: of two takeovers of a stale lock, only one succeeds', () => {
  const root = tmpRoot()
  ensureLogDirs(root)
  const lock = join(logPaths(root).memory, 's1.json.lock')
  writeFileSync(lock, 'old')
  assert.equal(takeOverStale(lock), true)
  assert.equal(takeOverStale(lock), false)
  assert.deepEqual(readdirSync(logPaths(root).memory), [])
})

test('round 2 B: release only removes our own lock', () => {
  const root = tmpRoot()
  ensureLogDirs(root)
  const lock = join(logPaths(root).memory, 's1.json.lock')
  const token = takeLock(lock)
  writeFileSync(lock, 'someone-else')
  releaseLock(lock, token)
  assert.equal(readFileSync(lock, 'utf8'), 'someone-else')
  writeFileSync(lock, token)
  releaseLock(lock, token)
  assert.deepEqual(readdirSync(logPaths(root).memory), [])
})

test('round 2 C: reads drop entries with a bad key, writer or oversize value', () => {
  const root = tmpRoot()
  putMemory(root, 's1', 'seed', 'v', 'lead', now)
  const ok = { value: 'v', writer: 'w', at: 'a' }
  writeFileSync(join(logPaths(root).memory, 's1.json'), JSON.stringify({
    good: ok,
    '\u001b[2J': ok,
    longwriter: { ...ok, writer: 'w'.repeat(65) },
    oddwriter: { ...ok, writer: 'a b' },
    fat: { ...ok, value: 'x'.repeat(MAX_VALUE_BYTES + 1) },
  }))
  assert.deepEqual(Object.keys(readMemory(root, 's1')), ['good'])
})
