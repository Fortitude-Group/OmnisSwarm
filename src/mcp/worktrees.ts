/**
 * The folders the gate may run in and the fence measures against: the project root and the git worktrees registered
 * with it (spec section 2.2). Read from `<root>/.git/worktrees/*\/gitdir`; no git process is started.
 */
import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { InputError } from './validate.ts'

const NOT_HERE = 'worktree is not this project or one of its git worktrees.'
const MAX_GITDIR = 4096

const realpath = (p: string): string => realpathSync.native(p)
/** Windows paths compare without regard to case; `realpath` doesn't always settle it. */
const same = (a: string, b: string): boolean => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)

/** The real path of the project root, then of each registered worktree whose folder still exists. Never throws. */
export function projectRoots(root: string): string[] {
  let top: string
  try {
    top = realpath(root)
  } catch {
    top = resolve(root)
  }
  const roots = [top]
  let entries: string[]
  try {
    entries = readdirSync(join(root, '.git', 'worktrees'))
  } catch {
    return roots
  }
  for (const entry of entries) {
    try {
      const text = readFileSync(join(root, '.git', 'worktrees', entry, 'gitdir'), 'utf8')
      if (text.length > MAX_GITDIR) continue
      const gitFile = text.split(/\r?\n/, 1)[0]!.trim()
      if (gitFile === '' || gitFile.includes('\u0000')) continue
      const folder = realpath(dirname(gitFile))
      if (!roots.some(r => same(r, folder))) roots.push(folder)
    } catch {
      // An unreadable or dangling entry is skipped.
    }
  }
  return roots
}

/** The matching root or worktree as a real path, or an InputError. A link is followed before the check. */
export function resolveWorktree(root: string, value: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new InputError(NOT_HERE)
  let folder: string
  try {
    folder = realpath(resolve(root, value))
  } catch {
    throw new InputError(NOT_HERE)
  }
  const found = projectRoots(root).find(r => same(r, folder))
  if (found === undefined) throw new InputError(NOT_HERE)
  return found
}
