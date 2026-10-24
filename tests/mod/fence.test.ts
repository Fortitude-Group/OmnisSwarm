import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FENCE_ASK_MS, FENCE_CACHE_MS, FenceCache, FenceTold, SKIP_GATE_REFUSAL, fenceAllows, fenceRefusal, fenceSettingFrom, fenceWarn, parseFence,
  type Fence,
} from '../../src/mod/fence.ts'
import { normalisePath } from '../../src/mod/holds.ts'

const fenced = (owns: string[], roots: string[], tasks = ['t1']): Fence => ({ fenced: true, tasks, owns, roots })
const key = (raw: string, cwd: string) => normalisePath(raw, cwd)!.key

test('the setting is block unless it says warn or off', () => {
  assert.equal(fenceSettingFrom('warn'), 'warn')
  assert.equal(fenceSettingFrom('off'), 'off')
  for (const x of ['block', undefined, '', 'WARN', 1, null]) assert.equal(fenceSettingFrom(x), 'block')
})

test('the limits are 10 s for the cache and 2 s for the server', () => {
  assert.equal(FENCE_CACHE_MS, 10_000)
  assert.equal(FENCE_ASK_MS, 2_000)
})

test('the exact texts, patterns comma-separated and clipped to 120', () => {
  assert.equal(
    fenceRefusal('src/b.ts', ['t1', 't2'], ['src/a/**', 'docs/']),
    'src/b.ts is outside the files your task owns (t1, t2: src/a/**, docs/). Ask main to widen the task, or leave it to the agent that owns it.',
  )
  const long = Array.from({ length: 20 }, (_, i) => `src/folder-${i}/**`)
  const text = fenceRefusal('x.ts', ['t1'], long)
  const patterns = text.slice(text.indexOf('t1: ') + 4, text.indexOf('). Ask'))
  assert.equal(patterns.length, 120)
  assert.ok(patterns.startsWith('src/folder-0/**, src/folder-1/**') && patterns.endsWith('…'))
  assert.equal(fenceWarn('coder-1', 'src/b.ts', ['t1', 't2']), "[OmnisSwarm scope fence] coder-1 edited src/b.ts, outside t1, t2's files.")
  assert.equal(SKIP_GATE_REFUSAL, 'Only main can skip the gate. Report the problem to main instead.')
})

test('a path is matched relative to the longest root it sits under', () => {
  const f = fenced(['src/**'], ['/repo', '/repo/.worktrees/wt1'])
  assert.equal(fenceAllows(f, key('/repo/src/a.ts', '/repo')), true)
  assert.equal(fenceAllows(f, key('/repo/docs/a.md', '/repo')), false)
  // Under the worktree, the path is relative to the worktree, not to /repo.
  assert.equal(fenceAllows(f, key('/repo/.worktrees/wt1/src/a.ts', '/repo')), true)
  assert.equal(fenceAllows(f, key('/repo/.worktrees/wt1/lib/a.ts', '/repo')), false)
})

test('a path under no root passes, and a sibling folder sharing a prefix is not under the root', () => {
  const f = fenced(['src/**'], ['/repo'])
  assert.equal(fenceAllows(f, key('/tmp/scratch.txt', '/repo')), true)
  assert.equal(fenceAllows(f, key('/repo-two/x.ts', '/repo')), true)
  assert.equal(fenceAllows(f, key('/repo', '/repo')), false)
})

test('Windows roots fold case and take back slashes; a POSIX root does not fold', () => {
  const f = fenced(['src/**'], ['C:\\Projects\\Repo', 'C:\\Temp\\wt\\gf3'])
  assert.equal(fenceAllows(f, key('c:\\projects\\repo\\SRC\\A.ts', 'C:\\Projects\\Repo')), true)
  assert.equal(fenceAllows(f, key('C:/Temp/WT/gf3/src/x.ts', 'C:\\Projects\\Repo')), true)
  assert.equal(fenceAllows(f, key('/c/temp/wt/gf3/docs/x.md', 'C:\\Projects\\Repo')), false)
  assert.equal(fenceAllows(f, key('D:\\other\\x.ts', 'C:\\Projects\\Repo')), true)
  const posix = fenced(['src/**'], ['/repo'])
  assert.equal(fenceAllows(posix, key('/repo/SRC/a.ts', '/repo')), false)
})

test('an unfenced answer allows everything', () => {
  assert.equal(fenceAllows({ fenced: false }, '/repo/anything'), true)
})

test('parseFence takes only the shapes the server sends', () => {
  assert.deepEqual(parseFence('{"fenced":false}'), { fenced: false })
  assert.deepEqual(parseFence('{"fenced":true,"tasks":["t1"],"owns":["src/**"],"roots":["/r"]}'), fenced(['src/**'], ['/r']))
  for (const bad of ['', 'ok s1', 'null', '[]', '{"fenced":"yes"}', '{"fenced":true,"tasks":["t1"],"owns":[1],"roots":["/r"]}',
    '{"fenced":true,"tasks":"t1","owns":["src/**"],"roots":["/r"]}', '{"fenced":true,"tasks":["t1"],"owns":["src/**"]}']) {
    assert.equal(parseFence(bad), null, bad)
  }
})

test('the cache keeps an answer 10 s, clears wholesale, and drops an answer asked for before a clear', () => {
  const cache = new FenceCache()
  const gen = cache.generation
  cache.set('a1', { fenced: false }, 1_000, gen)
  assert.deepEqual(cache.get('a1', 1_000 + FENCE_CACHE_MS - 1), { fenced: false })
  assert.equal(cache.get('a1', 1_000 + FENCE_CACHE_MS), undefined)
  cache.set('a1', { fenced: false }, 2_000, cache.generation)
  cache.set('a2', { fenced: false }, 2_000, cache.generation)
  const before = cache.generation
  cache.clear()
  assert.equal(cache.get('a1', 2_001), undefined)
  assert.equal(cache.get('a2', 2_001), undefined)
  cache.set('a1', fenced(['x'], ['/r']), 2_002, before)
  assert.equal(cache.get('a1', 2_003), undefined)
})

test('a refusal or warning is recorded once a minute per agent and path', () => {
  const told = new FenceTold()
  assert.equal(told.should('a1', '/r/x', 0), true)
  assert.equal(told.should('a1', '/r/x', 59_999), false)
  assert.equal(told.should('a2', '/r/x', 1), true)
  assert.equal(told.should('a1', '/r/y', 1), true)
  assert.equal(told.should('a1', '/r/x', 60_000), true)
})
