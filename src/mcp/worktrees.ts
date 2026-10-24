/**
 * The folders the gate may run in and the fence measures against: the project root and the git worktrees registered
 * with it (spec section 2.2). Read from `<common git dir>/worktrees/*`; no git process is started.
 *
 * An entry counts only as git itself would: it has a HEAD, and the folder its `gitdir` names has a `.git` file pointing
 * back at the entry. Relative paths (git's worktree.useRelativePaths) resolve against the file's own folder. When the
 * project root is itself a linked worktree, its `.git` file leads to the common dir, so the main checkout and the
 * siblings are found too. Reads are bounded: files over MAX_GITDIR are skipped unread, and at most MAX_ENTRIES are looked at.
 */
import { closeSync, openSync, opendirSync, readSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { InputError } from './validate.ts'

const NOT_HERE = 'worktree is not this project or one of its git worktrees.'
const MAX_GITDIR = 4096
const MAX_ENTRIES = 256

const realpath = (p: string): string => realpathSync.native(p)
/** Windows paths compare without regard to case; `realpath` doesn't always settle it. */
const same = (a: string, b: string): boolean => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)
let warnedCap = false

/** The first line of a small file, trimmed, or null when it is missing, too big, empty or holds a NUL. */
function firstLine(file: string): string | null {
  try {
    const st = statSync(file)
    if (!st.isFile() || st.size > MAX_GITDIR) return null
    const buf = Buffer.alloc(st.size)
    const fd = openSync(file, 'r')
    try {
      readSync(fd, buf, 0, st.size, 0)
    } finally {
      closeSync(fd)
    }
    const line = buf.toString('utf8').split(/\r?\n/, 1)[0]!.trim()
    return line === '' || line.includes('\u0000') ? null : line
  } catch {
    return null
  }
}

/** The folder a `.git` file's `gitdir:` line names, resolved against the file's folder, or null. */
function gitdirOf(gitFile: string): string | null {
  const line = firstLine(gitFile)
  const m = line === null ? null : /^gitdir:\s*(.+)$/.exec(line)
  return m === null ? null : resolve(dirname(gitFile), m[1]!)
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/** The repo's common git dir and the main checkout (null for a bare repo), seen from `top`. */
function commonOf(top: string): { common: string; main: string | null } | null {
  const dotGit = join(top, '.git')
  if (isDir(dotGit)) return { common: dotGit, main: top }
  const own = gitdirOf(dotGit)
  if (own === null) return null
  const rel = firstLine(join(own, 'commondir'))
  const common = rel === null ? resolve(own, '..', '..') : resolve(own, rel)
  return { common, main: same(basename(common), '.git') ? dirname(common) : null }
}

/** The names of at most MAX_ENTRIES entries under `dir`, sorted. */
function entriesOf(dir: string): string[] {
  const names: string[] = []
  let d
  try {
    d = opendirSync(dir)
  } catch {
    return names
  }
  try {
    for (let e = d.readSync(); e !== null; e = d.readSync()) {
      if (names.length === MAX_ENTRIES) {
        if (!warnedCap) process.stderr.write(`omnis: more than ${MAX_ENTRIES} git worktrees; only ${MAX_ENTRIES} are looked at\n`)
        warnedCap = true
        break
      }
      names.push(e.name)
    }
  } catch {
    // What was read so far stands.
  } finally {
    d.closeSync()
  }
  return names.sort()
}

/** The folder registered worktree `entry` lives in, as git wrote it, when it passes git's two-way check. */
function worktreeOf(entry: string): string | null {
  if (!isFile(join(entry, 'HEAD'))) return null
  const named = firstLine(join(entry, 'gitdir'))
  if (named === null) return null
  const gitFile = resolve(entry, named)
  const back = gitdirOf(gitFile)
  if (back === null) return null
  try {
    return same(realpath(back), realpath(entry)) ? dirname(gitFile) : null
  } catch {
    return null
  }
}

/**
 * Every root, each as `[real path, ...other spellings]`: the project first, then the main checkout when the project is a
 * linked worktree, then the registered worktrees. A link or junction to a root is a spelling of it. Never throws.
 */
export function rootGroups(root: string): string[][] {
  const groups: string[][] = []
  const add = (folder: string): void => {
    const lexical = resolve(folder)
    let real: string
    try {
      real = realpath(lexical)
    } catch {
      return
    }
    const group = groups.find(g => same(g[0]!, real))
    if (group === undefined) groups.push(same(lexical, real) ? [real] : [real, lexical])
    else if (!group.some(f => same(f, lexical))) group.push(lexical)
  }
  const top = resolve(root)
  add(top)
  if (groups.length === 0) groups.push([top])
  const repo = commonOf(top)
  if (repo === null) return groups
  if (repo.main !== null) add(repo.main)
  const dir = join(repo.common, 'worktrees')
  for (const name of entriesOf(dir)) {
    const folder = worktreeOf(join(dir, name))
    if (folder !== null) add(folder)
  }
  return groups
}

/** The real path of the project root, then of each other root. Never throws. */
export function projectRoots(root: string): string[] {
  return rootGroups(root).map(g => g[0]!)
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
