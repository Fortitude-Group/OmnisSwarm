/** Naming swarms and making sure one is running. */
import { existsSync } from 'node:fs'
import { makeEvent, type Source } from './events.ts'
import { appendEvent, isValidSwarmId, readCurrent, swarmLogPath, writeCurrent } from './log.ts'

/** Lower-case letters, digits, dots and dashes; no leading or trailing punctuation; at most 64 characters. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64)
    .replace(/[-.]+$/g, '')
}

export function uniqueSwarmId(root: string, base: string): string {
  const slug = slugify(base) || 'swarm'
  const id = isValidSwarmId(slug) ? slug : slugify(`swarm-${slug}`.slice(0, 64)) || 'swarm'
  if (!existsSync(swarmLogPath(root, id))) return id
  for (let n = 2; ; n++) {
    const candidate = `${id.slice(0, 60)}-${n}`
    if (!existsSync(swarmLogPath(root, candidate))) return candidate
  }
}

/** The current swarm id, starting an implicit hierarchical swarm named after `idHint` if none is running. */
export function ensureSwarm(root: string, input: { idHint: string; src: Source; now?: Date }): string {
  const current = readCurrent(root)
  if (current !== null) return current
  const id = uniqueSwarmId(root, input.idHint)
  writeCurrent(root, id)
  appendEvent(root, makeEvent({
    type: 'swarm.started',
    swarm: id,
    src: input.src,
    data: { name: id, topology: 'hierarchical', implicit: true },
    ...(input.now !== undefined && { now: input.now }),
  }))
  return id
}
