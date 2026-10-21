import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { logPaths } from '../../src/core/log.ts'
import { putMemory, readMemory } from '../../src/mcp/memory-store.ts'
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
    symlinkSync(target, real)
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
