/** Reading and writing the per-swarm event log under `.omnis-swarm/`. */
import {
  appendFileSync, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync,
  realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { isValidSwarmId, LIMITS, parseLine, serialise, type Source, type SwarmEvent } from './events.ts'

export { isValidSwarmId }

export const LOG_DIR = '.omnis-swarm'

/** The most bytes one readEvents call takes from a file. */
export const MAX_READ_BYTES = 1_048_576

const badId = (id: string): Error => new Error(`invalid swarm id: ${JSON.stringify(id.slice(0, 80))}`)

export function logPaths(root: string): { dir: string; current: string; swarms: string; memory: string } {
  const dir = join(root, LOG_DIR)
  return { dir, current: join(dir, 'current'), swarms: join(dir, 'swarms'), memory: join(dir, 'memory') }
}

export function swarmLogPath(root: string, id: string): string {
  if (!isValidSwarmId(id)) throw badId(id)
  return join(logPaths(root).swarms, `${id}.jsonl`)
}

const isLink = (path: string): boolean => lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() === true

/** Throws if `path` exists and is a symbolic link (Node reports Windows junctions as links too). */
function refuseLink(path: string): void {
  if (isLink(path)) throw new Error(`refusing to write through a link: ${path}`)
}

/** Adds `.omnis-swarm/` to the project's .gitignore unless it is already there. Best effort: only a regular file is edited and any failure is swallowed. */
export function ensureGitignore(root: string): void {
  try {
    const file = join(root, '.gitignore')
    const stat = lstatSync(file, { throwIfNoEntry: false })
    if (stat !== undefined && !stat.isFile()) return
    const entry = `${LOG_DIR}/`
    const text = stat === undefined ? '' : readFileSync(file, 'utf8')
    if (text.split(/\r?\n/).some(line => line.trim() === entry || line.trim() === LOG_DIR)) return
    const sep = text === '' || text.endsWith('\n') ? '' : '\n'
    writeFileSync(file, `${text}${sep}${entry}\n`)
  } catch {
    // An odd .gitignore must never stop logging.
  }
}

/** Creates `dir` if missing, then insists it is a real directory inside the project. */
function checkedDir(root: string, dir: string): void {
  let stat = lstatSync(dir, { throwIfNoEntry: false })
  if (stat === undefined) {
    mkdirSync(dir)
    stat = lstatSync(dir)
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`log folder is not a plain directory: ${dir}`)
  const rel = relative(realpathSync(root), realpathSync(dir))
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`log folder resolves outside the project: ${dir}`)
}

/** Creates the log folders, refusing any that is a link or leads outside the project. Checked on every call. */
export function ensureLogDirs(root: string): void {
  const paths = logPaths(root)
  for (const dir of [paths.dir, paths.swarms, paths.memory]) checkedDir(root, dir)
  ensureGitignore(root)
}

/** One append of one line. Retries once, and returns false rather than throwing. */
export function appendEvent(root: string, event: SwarmEvent): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const line = serialise(event)
      ensureLogDirs(root)
      const file = swarmLogPath(root, event.swarm)
      refuseLink(file)
      appendFileSync(file, line)
      return true
    } catch {
      // A locked file, a link or a full disk: try once more, then let the caller show a gap.
    }
  }
  return false
}

export type ReadResult = { events: SwarmEvent[]; offset: number; bad: number; skipped: number; reset: boolean }

/**
 * Reads complete lines from `offset` on, at most MAX_READ_BYTES per call; call again from the returned offset.
 * A short trailing line with no newline yet is left for next time; one longer than a line can be is counted bad and skipped.
 * An offset that is not a safe non-negative integer counts as 0, with `reset` true.
 * If the file is now shorter than `offset`, it was replaced, so reading starts again from 0 and `reset` is true.
 */
export function readEvents(file: string, offset = 0): ReadResult {
  const validOffset = Number.isSafeInteger(offset) && offset >= 0
  const given = validOffset ? offset : 0
  let fd: number
  try {
    if (isLink(file)) throw new Error('refusing a link')
    fd = openSync(file, 'r')
  } catch {
    return { events: [], offset: given, bad: 0, skipped: 0, reset: false }
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) return { events: [], offset: given, bad: 0, skipped: 0, reset: false }
    const size = stat.size
    const reset = !validOffset || size < given
    const start = reset ? 0 : given
    const result: ReadResult = { events: [], offset: start, bad: 0, skipped: 0, reset }
    if (size === start) return result
    const buf = Buffer.alloc(Math.min(size - start, MAX_READ_BYTES))
    const got = readSync(fd, buf, 0, buf.length, start)
    const data = buf.subarray(0, got)
    let from = 0
    for (let nl = data.indexOf(0x0a, from); nl !== -1; nl = data.indexOf(0x0a, from)) {
      const raw = data.subarray(from, nl)
      from = nl + 1
      if (raw.length > LIMITS.line) {
        result.bad++
        continue
      }
      const line = raw.toString('utf8')
      if (line.trim() === '') continue
      const parsed = parseLine(line)
      if (parsed.ok) result.events.push(parsed.event)
      else if (parsed.reason === 'version') result.skipped++
      else result.bad++
    }
    if (data.length - from > LIMITS.line) {
      result.bad++
      from = data.length
    }
    result.offset = start + from
    return result
  } finally {
    closeSync(fd)
  }
}

export function readCurrent(root: string): string | null {
  let fd: number | undefined
  try {
    const file = logPaths(root).current
    if (isLink(file)) return null
    fd = openSync(file, 'r')
    if (!fstatSync(fd).isFile()) return null
    const buf = Buffer.alloc(128)
    const got = readSync(fd, buf, 0, buf.length, 0)
    const id = buf.subarray(0, got).toString('utf8').trim()
    return isValidSwarmId(id) ? id : null
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export function writeCurrent(root: string, id: string): void {
  if (!isValidSwarmId(id)) throw badId(id)
  ensureLogDirs(root)
  const { current } = logPaths(root)
  refuseLink(current)
  const temp = `${current}.${process.pid}.tmp`
  rmSync(temp, { force: true })
  writeFileSync(temp, `${id}\n`, { flag: 'wx' })
  renameSync(temp, current)
}

export function clearCurrent(root: string): void {
  rmSync(logPaths(root).current, { force: true })
}

const SOURCE_ORDER: Record<Source, number> = { mcp: 0, recorder: 1, transcripts: 2 }

/** Orders by timestamp, then source, keeping file order for exact ties. Writers never coordinate. */
export function sortEvents(events: readonly SwarmEvent[]): SwarmEvent[] {
  return events
    .map((event, index) => ({ event, index, time: Date.parse(event.ts) }))
    .sort((a, b) => a.time - b.time || SOURCE_ORDER[a.event.src] - SOURCE_ORDER[b.event.src] || a.index - b.index)
    .map(item => item.event)
}
