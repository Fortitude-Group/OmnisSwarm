/** Reading and writing the per-swarm event log under `.omnis-swarm/`. */
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseLine, serialise, type Source, type SwarmEvent } from './events.ts'

export const LOG_DIR = '.omnis-swarm'

const SWARM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Swarm ids become file names, so only safe characters and never `..`. */
export const isValidSwarmId = (id: string): boolean => SWARM_ID.test(id) && !id.includes('..')

export function logPaths(root: string): { dir: string; current: string; swarms: string; memory: string } {
  const dir = join(root, LOG_DIR)
  return { dir, current: join(dir, 'current'), swarms: join(dir, 'swarms'), memory: join(dir, 'memory') }
}

export function swarmLogPath(root: string, id: string): string {
  if (!isValidSwarmId(id)) throw new Error(`invalid swarm id: ${JSON.stringify(id)}`)
  return join(logPaths(root).swarms, `${id}.jsonl`)
}

/** Adds `.omnis-swarm/` to the project's .gitignore unless it is already there. */
export function ensureGitignore(root: string): void {
  const file = join(root, '.gitignore')
  const entry = `${LOG_DIR}/`
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (text.split(/\r?\n/).some(line => line.trim() === entry || line.trim() === LOG_DIR)) return
  const sep = text === '' || text.endsWith('\n') ? '' : '\n'
  writeFileSync(file, `${text}${sep}${entry}\n`)
}

const ready = new Set<string>()

export function ensureLogDirs(root: string): void {
  if (ready.has(root) && existsSync(logPaths(root).swarms)) return
  const paths = logPaths(root)
  mkdirSync(paths.swarms, { recursive: true })
  mkdirSync(paths.memory, { recursive: true })
  ensureGitignore(root)
  ready.add(root)
}

/** One append of one line. Retries once, and returns false rather than throwing. */
export function appendEvent(root: string, event: SwarmEvent): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const line = serialise(event)
      ensureLogDirs(root)
      appendFileSync(swarmLogPath(root, event.swarm), line)
      return true
    } catch {
      // A locked file or full disk: try once more, then let the caller show a gap.
    }
  }
  return false
}

export type ReadResult = { events: SwarmEvent[]; offset: number; bad: number; skipped: number; reset: boolean }

/**
 * Reads complete lines from `offset` on. A trailing line with no newline yet is left for next time.
 * If the file is now shorter than `offset`, it was replaced, so reading starts again from 0 and `reset` is true.
 */
export function readEvents(file: string, offset = 0): ReadResult {
  let fd: number
  try {
    fd = openSync(file, 'r')
  } catch {
    return { events: [], offset, bad: 0, skipped: 0, reset: false }
  }
  try {
    const size = fstatSync(fd).size
    const reset = size < offset
    const start = reset ? 0 : offset
    const result: ReadResult = { events: [], offset: start, bad: 0, skipped: 0, reset }
    if (size === start) return result
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    const end = buf.lastIndexOf(0x0a)
    if (end === -1) return result
    for (const line of buf.subarray(0, end + 1).toString('utf8').split('\n')) {
      if (line.trim() === '') continue
      const parsed = parseLine(line)
      if (parsed.ok) result.events.push(parsed.event)
      else if (parsed.reason === 'version') result.skipped++
      else result.bad++
    }
    result.offset = start + end + 1
    return result
  } finally {
    closeSync(fd)
  }
}

export function readCurrent(root: string): string | null {
  try {
    const id = readFileSync(logPaths(root).current, 'utf8').trim()
    return isValidSwarmId(id) ? id : null
  } catch {
    return null
  }
}

export function writeCurrent(root: string, id: string): void {
  if (!isValidSwarmId(id)) throw new Error(`invalid swarm id: ${JSON.stringify(id)}`)
  ensureLogDirs(root)
  writeFileSync(logPaths(root).current, `${id}\n`)
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
