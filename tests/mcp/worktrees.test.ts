import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { projectRoots, resolveWorktree } from '../../src/mcp/worktrees.ts'
import { InputError } from '../../src/mcp/validate.ts'
import { tmpRoot } from '../helpers.ts'

const real = (p: string): string => realpathSync.native(p)
const WHY = 'worktree is not this project or one of its git worktrees.'

/** A repo folder and a sibling worktree folder, wired up the way git does it, with no git process. */
function layout() {
  const base = tmpRoot()
  const root = join(base, 'repo')
  const wtA = join(base, 'wt-a')
  const outside = join(base, 'elsewhere')
  for (const d of [root, wtA, outside]) mkdirSync(d, { recursive: true })
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, '.git', 'worktrees', 'wt-a'), { recursive: true })
  writeFileSync(join(root, '.git', 'worktrees', 'wt-a', 'gitdir'), `${join(wtA, '.git').replace(/\\/g, '/')}\n`)
  writeFileSync(join(wtA, '.git'), `gitdir: ${join(root, '.git', 'worktrees', 'wt-a')}\n`)
  return { base, root, wtA, outside }
}

test('projectRoots is the project and each registered worktree that exists', () => {
  const { root, wtA, base } = layout()
  // A registered worktree whose folder is gone, a stray file, and an entry with no gitdir file are all skipped.
  mkdirSync(join(root, '.git', 'worktrees', 'gone'))
  writeFileSync(join(root, '.git', 'worktrees', 'gone', 'gitdir'), `${join(base, 'deleted', '.git')}\n`)
  mkdirSync(join(root, '.git', 'worktrees', 'empty'))
  writeFileSync(join(root, '.git', 'worktrees', 'stray.txt'), 'x')
  assert.deepEqual(projectRoots(root), [real(root), real(wtA)])
})

test('projectRoots with no .git, or a root that does not exist, still answers and never throws', () => {
  const base = tmpRoot()
  assert.deepEqual(projectRoots(base), [real(base)])
  const missing = join(base, 'nope')
  const got = projectRoots(missing)
  assert.equal(got.length, 1)
  assert.doesNotThrow(() => projectRoots(''))
})

test('projectRoots skips a gitdir that is garbage and lists a worktree once', () => {
  const { root, wtA } = layout()
  mkdirSync(join(root, '.git', 'worktrees', 'bad'))
  writeFileSync(join(root, '.git', 'worktrees', 'bad', 'gitdir'), '\u0000\u0000')
  mkdirSync(join(root, '.git', 'worktrees', 'dup'))
  writeFileSync(join(root, '.git', 'worktrees', 'dup', 'gitdir'), `${join(wtA, '.git')}\n`)
  assert.deepEqual(projectRoots(root), [real(root), real(wtA)])
})

test('resolveWorktree accepts the project root and a registered worktree, giving the resolved path', () => {
  const { root, wtA } = layout()
  assert.equal(resolveWorktree(root, root), real(root))
  assert.equal(resolveWorktree(root, wtA), real(wtA))
  assert.equal(resolveWorktree(root, `${wtA}${process.platform === 'win32' ? '\\' : '/'}`), real(wtA))
  assert.equal(resolveWorktree(root, '.'), real(root))
})

test('resolveWorktree refuses anything else with the one message', () => {
  const { root, outside, base } = layout()
  for (const bad of [outside, join(root, 'src'), join(base, 'nope'), base, '..', '', join(root, '.git')]) {
    assert.throws(() => resolveWorktree(root, bad), (e: unknown) => e instanceof InputError && e.message === WHY, JSON.stringify(bad))
  }
})

test('resolveWorktree follows a link before it decides', () => {
  const { root, wtA, outside } = layout()
  const toWorktree = join(root, 'link-ok')
  const toOutside = join(root, 'link-bad')
  try {
    symlinkSync(wtA, toWorktree, 'junction')
    symlinkSync(outside, toOutside, 'junction')
  } catch {
    return // this machine cannot make links; nothing to check
  }
  assert.equal(resolveWorktree(root, toWorktree), real(wtA))
  assert.throws(() => resolveWorktree(root, toOutside), InputError)
})
