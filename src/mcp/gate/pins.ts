/**
 * The gate each task had when it was created, as the digest gateTarget gives it, so a task can't neuter its gate by
 * editing it (in the root, or in both the root and its worktree). Only tasks created while a gate existed are pinned.
 * Held in memory: a restarted server holds none, and its tasks skip the check.
 */
const MAX_PINS = 10_000

const pins = new Map<string, string>()
const keyOf = (root: string, swarm: string, id: string): string => `${root}\u0000${swarm}\u0000${id}`

export function pinGate(root: string, swarm: string, id: string, digest: string): void {
  const key = keyOf(root, swarm, id)
  pins.delete(key)
  while (pins.size >= MAX_PINS) pins.delete(pins.keys().next().value!)
  pins.set(key, digest)
}

/** The task's pinned digest, or undefined when it has none. */
export const pinnedGate = (root: string, swarm: string, id: string): string | undefined => pins.get(keyOf(root, swarm, id))
