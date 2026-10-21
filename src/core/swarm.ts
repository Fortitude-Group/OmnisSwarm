/** Naming swarms and making sure one is running. */
import { createHash } from 'node:crypto'
import { closeSync, lstatSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { makeEvent, parseLine, type Source } from './events.ts'
import { appendEvent, ensureLogDirs, isValidSwarmId, logPaths, readCurrent, readEvents, swarmLogPath, writeCurrent } from './log.ts'

/** Lower-case letters, digits, dots and dashes; no leading or trailing punctuation; no dot runs; at most 64 characters. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64)
    .replace(/[-.]+$/g, '')
}

/** Creates the empty log file so two writers cannot both take the same id. False if it already exists. */
function claim(root: string, id: string): boolean {
  try {
    closeSync(openSync(swarmLogPath(root, id), 'wx'))
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}

/** A valid swarm id not yet in use, claimed by creating its (empty) log file. */
export function uniqueSwarmId(root: string, base: string, onAttempt?: () => void): string {
  const tryClaim = (id: string): boolean => {
    onAttempt?.()
    return claim(root, id)
  }
  ensureLogDirs(root)
  const slug = slugify(base) || 'swarm'
  let id = slug
  if (!isValidSwarmId(id)) id = slugify(`swarm-${slug}`)
  if (!isValidSwarmId(id)) id = 'swarm'
  if (tryClaim(id)) return id
  const suffixed = (n: number): string => `${id.slice(0, 63 - String(n).length).replace(/[.-]+$/, '')}-${n}`
  // One directory listing gives the numbers in use; we take the lowest free one and only move on if the claim loses a race.
  const used = new Set<number>()
  try {
    for (const file of readdirSync(logPaths(root).swarms)) {
      if (!file.endsWith('.jsonl')) continue
      const name = file.slice(0, -6)
      const m = /-(\d{1,5})$/.exec(name)
      if (m !== null && suffixed(Number(m[1])) === name) used.add(Number(m[1]))
    }
  } catch {
    // no listing: the claims below still say what is taken
  }
  for (let n = 2; n <= 10_001; n++) {
    if (used.has(n)) continue
    const candidate = suffixed(n)
    if (isValidSwarmId(candidate) && tryClaim(candidate)) return candidate
  }
  throw new Error('no free swarm id')
}

/** Appends the swarm.started event to a swarm whose id was claimed with uniqueSwarmId. `session` is the Claude Code session that started it. */
export function announceSwarm(root: string, id: string, input: { src: Source; now?: Date; session?: string }): void {
  appendEvent(root, makeEvent({
    type: 'swarm.started',
    swarm: id,
    src: input.src,
    data: { name: id, topology: 'hierarchical', implicit: true, ...(input.session !== undefined && { session: input.session }) },
    ...(input.now !== undefined && { now: input.now }),
  }))
}

/** What the log stores in place of a Claude Code session id: the first 16 hex of its sha256. The raw id never reaches a log. */
export function sessionKey(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 16)
}

/**
 * The session key (see sessionKey) of the session that started swarm `id`: the `session` of its first
 * swarm.started that carries one, or null. Renames after that don't change it. The log is a display
 * record, so this only decides whether this server may end or rename the swarm. It is safe only while
 * non-owners can't append swarm.started: init renames only swarms it owns, and the recorder can't
 * write that type.
 */
export function swarmOwner(root: string, id: string): string | null {
  try {
    for (const e of readEvents(swarmLogPath(root, id)).events) {
      if (e.type === 'swarm.started' && typeof e.data.session === 'string') return e.data.session
    }
    return null
  } catch {
    return null
  }
}

/** True if the swarm's log holds nothing but its own swarm.started line. */
function onlyStarted(root: string, id: string): boolean {
  try {
    const lines = readFileSync(swarmLogPath(root, id), 'utf8').split(/\r?\n/).filter(l => l.trim() !== '')
    if (lines.length !== 1) return false
    const parsed = parseLine(lines[0]!)
    return parsed.ok && parsed.event.type === 'swarm.started' && parsed.event.swarm === id
  } catch {
    return false
  }
}

/**
 * Makes `id` the current swarm, but only if nobody else got there first: `current` is created with `wx`.
 * A loser drops its own empty swarm and returns the winner's id. A `current` holding junk is overwritten.
 */
export function publishCurrent(root: string, id: string): string {
  ensureLogDirs(root)
  const { current } = logPaths(root)
  if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink() === true) throw new Error(`refusing to write through a link: ${current}`)
  try {
    writeFileSync(current, id + '\n', { flag: 'wx' })
    return id
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const winner = readCurrent(root)
  if (winner === null) {
    writeCurrent(root, id)
    return id
  }
  if (winner !== id && onlyStarted(root, id)) rmSync(swarmLogPath(root, id), { force: true })
  return winner
}
