/** Naming swarms and making sure one is running. */
import { closeSync, openSync } from 'node:fs'
import { makeEvent, type Source } from './events.ts'
import { appendEvent, ensureLogDirs, isValidSwarmId, readCurrent, swarmLogPath, writeCurrent } from './log.ts'

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
  for (let n = 2; n <= 10_001; n++) {
    const candidate = `${id.slice(0, 63 - String(n).length).replace(/[.-]+$/, '')}-${n}`
    if (isValidSwarmId(candidate) && claim(root, candidate)) return candidate
  }
  throw new Error('no free swarm id')
}

/** The current swarm id, starting an implicit hierarchical swarm named after `idHint` if none is running. */
export function ensureSwarm(root: string, input: { idHint: string; src: Source; now?: Date }): string {
  const current = readCurrent(root)
  if (current !== null) return current
  const id = uniqueSwarmId(root, input.idHint)
  appendEvent(root, makeEvent({
    type: 'swarm.started',
    swarm: id,
    src: input.src,
    data: { name: id, topology: 'hierarchical', implicit: true },
    ...(input.now !== undefined && { now: input.now }),
  }))
  writeCurrent(root, id)
  // If another writer started a swarm at the same moment, go with whichever name `current` ended up holding.
  return readCurrent(root) ?? id
}
