import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { projectRoots, resolveWorktree, rootGroups } from '../../src/mcp/worktrees.ts'
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
  writeFileSync(join(root, '.git', 'worktrees', 'wt-a', 'HEAD'), 'ref: refs/heads/wt-a\n')
  return { base, root, wtA, outside }
}

/** Registers `folder` as worktree `name` of the repo at `root`, as git does, optionally with relative paths both ways. */
function addWorktree(root: string, name: string, folder: string, opts: { relativePaths?: boolean; head?: boolean; backTo?: string } = {}) {
  const entry = join(root, '.git', 'worktrees', name)
  mkdirSync(entry, { recursive: true })
  mkdirSync(folder, { recursive: true })
  const gitFile = join(folder, '.git')
  writeFileSync(join(entry, 'gitdir'), `${opts.relativePaths ? relative(entry, gitFile) : gitFile}\n`)
  const back = opts.backTo ?? entry
  writeFileSync(gitFile, `gitdir: ${opts.relativePaths ? relative(folder, back) : back}\n`)
  if (opts.head !== false) writeFileSync(join(entry, 'HEAD'), 'ref: refs/heads/x\n')
  return folder
}
const canLink = (target: string, link: string): boolean => {
  try {
    symlinkSync(target, link, 'junction')
    return true
  } catch {
    return false
  }
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

test('rootGroups gives each root as the real path and every spelling it was reached by', () => {
  const { root, wtA } = layout()
  assert.deepEqual(rootGroups(root).map(g => g[0]), [real(root), real(wtA)])
  assert.ok(rootGroups(root)[1]!.includes(wtA))
})

test('a project reached through a junction lists the link and the real folder', () => {
  const { base, root, wtA } = layout()
  const link = join(base, 'linked-repo')
  if (!canLink(root, link)) return // this machine cannot make links
  const groups = rootGroups(link)
  assert.equal(groups[0]![0], real(root))
  assert.ok(groups[0]!.includes(link), JSON.stringify(groups))
  assert.deepEqual(projectRoots(link), [real(root), real(wtA)])
})

test('relative gitdir entries resolve against their own folder, not the server cwd', () => {
  const { root, base, wtA } = layout()
  const wtB = addWorktree(root, 'wt-b', join(base, 'wt-b'), { relativePaths: true })
  assert.deepEqual(projectRoots(root), [real(root), real(wtA), real(wtB)])
  assert.equal(resolveWorktree(root, wtB), real(wtB))
})

test('a server started inside a linked worktree finds the main checkout and the siblings', () => {
  const { root, base, wtA } = layout()
  const wtB = addWorktree(root, 'wt-b', join(base, 'wt-b'), { relativePaths: true })
  assert.deepEqual(projectRoots(wtA), [real(wtA), real(root), real(wtB)])
  assert.equal(resolveWorktree(wtA, root), real(root))
})

test('a worktree entry counts only with a HEAD and a .git file that points back at it', () => {
  const { root, base, wtA } = layout()
  addWorktree(root, 'no-head', join(base, 'no-head'), { head: false })
  addWorktree(root, 'planted', join(base, 'planted'), { backTo: join(root, '.git', 'worktrees', 'wt-a') })
  mkdirSync(join(root, '.git', 'worktrees', 'no-file'))
  mkdirSync(join(base, 'bare-folder'))
  writeFileSync(join(root, '.git', 'worktrees', 'no-file', 'gitdir'), `${join(base, 'bare-folder', '.git')}\n`)
  writeFileSync(join(root, '.git', 'worktrees', 'no-file', 'HEAD'), 'x\n')
  assert.deepEqual(projectRoots(root), [real(root), real(wtA)])
  assert.throws(() => resolveWorktree(root, join(base, 'planted')), InputError)
})

test('a gitdir file over 4,096 bytes is skipped unread, and at most 256 entries are looked at', () => {
  const { root, base, wtA } = layout()
  const big = addWorktree(root, 'big', join(base, 'big'))
  writeFileSync(join(root, '.git', 'worktrees', 'big', 'gitdir'), `${join(big, '.git')}\n${'x'.repeat(5000)}`)
  assert.deepEqual(projectRoots(root), [real(root), real(wtA)])
  const many = layout()
  for (let i = 0; i < 300; i++) addWorktree(many.root, `m${String(i).padStart(3, '0')}`, join(many.base, `m${i}`))
  const got = projectRoots(many.root)
  assert.ok(got.length <= 257 && got.length > 200, String(got.length))

})
