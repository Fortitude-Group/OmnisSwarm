import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BLOCK_DEDUPE_MS, HOLD_IDLE_MS, Holds, clashSettingFrom, normalisePath } from '../../src/mod/holds.ts'

test('paths resolve against the cwd, use / and fold case only under a drive letter', () => {
  assert.deepEqual(normalisePath('src\\x.ts', 'C:\\proj'), { key: 'c:/proj/src/x.ts', shown: 'src/x.ts' })
  assert.deepEqual(normalisePath('C:/Proj/SRC/x.ts', 'c:\\proj'), { key: 'c:/proj/src/x.ts', shown: 'SRC/x.ts' })
  assert.deepEqual(normalisePath('/home/me/p/src/X.ts', '/home/me/p'), { key: '/home/me/p/src/X.ts', shown: 'src/X.ts' })
  assert.deepEqual(normalisePath('./a/../b//c.ts', '/p'), { key: '/p/b/c.ts', shown: 'b/c.ts' })
  assert.deepEqual(normalisePath('/elsewhere/c.ts', '/p'), { key: '/elsewhere/c.ts', shown: '/elsewhere/c.ts' })
  assert.equal(normalisePath('', '/p'), null)
  assert.equal(normalisePath(42, '/p'), null)
})

test('a long shown path is cut from the left to 80', () => {
  const shown = normalisePath(`${'d/'.repeat(60)}file.ts`, '/p')!.shown
  assert.equal(shown.length, 80)
  assert.ok(shown.startsWith('…') && shown.endsWith('/file.ts'))
})

test('the setting reads block, warn or off, and anything else as block', () => {
  assert.equal(clashSettingFrom('warn'), 'warn')
  assert.equal(clashSettingFrom('off'), 'off')
  for (const x of ['block', undefined, 'WARN', 3]) assert.equal(clashSettingFrom(x), 'block')
})

test('the first subagent takes the hold, another clashes, the holder does not, the lead never holds', () => {
  const h = new Holds()
  assert.equal(h.clashWith('/p/x', 'a1', 0), null)
  h.take('/p/x', 'a1', 0)
  assert.equal(h.clashWith('/p/x', 'a2', 1), 'a1')
  assert.equal(h.clashWith('/p/x', null, 1), 'a1')
  assert.equal(h.clashWith('/p/x', 'a1', 1), null)
  h.take('/p/y', null, 0)
  assert.equal(h.clashWith('/p/y', 'a2', 1), null)
})

test('a hold ends when its holder finishes or goes idle for HOLD_IDLE_MS, and an edit keeps it alive', () => {
  const h = new Holds()
  h.take('/p/x', 'a1', 0)
  h.take('/p/x', 'a1', HOLD_IDLE_MS - 1)
  assert.equal(h.clashWith('/p/x', 'a2', 2 * HOLD_IDLE_MS - 2), 'a1')
  assert.equal(h.clashWith('/p/x', 'a2', 2 * HOLD_IDLE_MS - 1), null)
  h.take('/p/z', 'a1', 0)
  h.releaseAll('a1')
  assert.equal(h.clashWith('/p/z', 'a2', 1), null)
})

test('take never overwrites another live holder', () => {
  const h = new Holds()
  h.take('/p/x', 'a1', 0)
  h.take('/p/x', 'a2', 1)
  assert.equal(h.clashWith('/p/x', 'a2', 2), 'a1')
})

test('a refusal is recorded once per agent and path in BLOCK_DEDUPE_MS', () => {
  const h = new Holds()
  assert.equal(h.shouldRecord('a2', '/p/x', 0), true)
  assert.equal(h.shouldRecord('a2', '/p/x', BLOCK_DEDUPE_MS - 1), false)
  assert.equal(h.shouldRecord('a3', '/p/x', 1), true)
  assert.equal(h.shouldRecord('a2', '/p/x', BLOCK_DEDUPE_MS), true)
})

test('under a drive letter, a Git Bash /c/ path and a //?/ long path name the same file', () => {
  const want = { key: 'c:/proj/src/x.ts', shown: 'src/x.ts' }
  assert.deepEqual(normalisePath('/c/proj/src/x.ts', 'C:\\proj'), want)
  assert.deepEqual(normalisePath('\\\\?\\C:\\proj\\src\\x.ts', 'C:\\proj'), want)
  assert.deepEqual(normalisePath('//?/c:/proj/src/x.ts', 'C:\\proj'), want)
  assert.deepEqual(normalisePath('/c/proj/x', '/home/c'), { key: '/c/proj/x', shown: '/c/proj/x' })
})

test('reserve holds at once, and its undo restores what was there', () => {
  const h = new Holds()
  const undo = h.reserve('/p/x', 'a1', 0)
  assert.equal(h.clashWith('/p/x', 'a2', 1), 'a1')
  undo()
  assert.equal(h.clashWith('/p/x', 'a2', 1), null)
  h.take('/p/y', 'a1', 0)
  h.reserve('/p/y', 'a1', HOLD_IDLE_MS - 1)()
  assert.equal(h.clashWith('/p/y', 'a2', HOLD_IDLE_MS - 2), 'a1')
  assert.equal(h.clashWith('/p/y', 'a2', HOLD_IDLE_MS), null)
  assert.equal(h.reserve('/p/z', null, 0)(), undefined)
})
