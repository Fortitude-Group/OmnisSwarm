/** Naming swarms and making sure one is running. */
import { closeSync, lstatSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { makeEvent, parseLine, type Source } from './events.ts'
import { appendEvent, ensureLogDirs, isValidSwarmId, logPaths, readCurrent, swarmLogPath, writeCurrent } from './log.ts'

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
export function uniqueSwarmId(root: string, base: string): string {
  ensureLogDirs(root)
  const slug = slugify(base) || 'swarm'
  let id = slug
  if (!isValidSwarmId(id)) id = slugify(`swarm-${slug}`)
  if (!isValidSwarmId(id)) id = 'swarm'
  if (claim(root, id)) return id
  const suffixed = (n: number): string => `${id.slice(0, 63 - String(n).length).replace(/[.-]+$/, '')}-${n}`
  // One directory listing finds the highest number already used, so old swarms of one name don't slow us down.
  let highest = 1
  try {
    for (const file of readdirSync(logPaths(root).swarms)) {
      if (!file.endsWith('.jsonl')) continue
      const name = file.slice(0, -6)
      const m = /-(\d{1,5})$/.exec(name)
      if (m !== null && suffixed(Number(m[1])) === name) highest = Math.max(highest, Number(m[1]))
    }
  } catch {
    // fall back to counting up from 2
  }
  for (let n = highest + 1; n <= 10_001; n++) {
    const candidate = suffixed(n)
    if (isValidSwarmId(candidate) && claim(root, candidate)) return candidate
  }
  throw new Error('no free swarm id')
}

/** Appends the swarm.started event to a swarm whose id was claimed with uniqueSwarmId. */
export function announceSwarm(root: string, id: string, input: { src: Source; now?: Date }): void {
  appendEvent(root, makeEvent({
    type: 'swarm.started',
    swarm: id,
    src: input.src,
    data: { name: id, topology: 'hierarchical', implicit: true },
    ...(input.now !== undefined && { now: input.now }),
  }))
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

/** The current swarm id, starting an implicit hierarchical swarm named after `idHint` if none is running. */
export function ensureSwarm(root: string, input: { idHint: string; src: Source; now?: Date }): string {
  const current = readCurrent(root)
  if (current !== null) return current
  const id = uniqueSwarmId(root, input.idHint)
  announceSwarm(root, id, input)
  return publishCurrent(root, id)
}
