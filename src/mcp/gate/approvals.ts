/**
 * One-shot gate approvals, so the gate fails closed without the mod. The mod's gate guard approves a task's gate once
 * the user's Bash rules allow its command, or as it asks the user. omnis_task_update(done) runs a gate only when it can
 * take a matching approval, which it uses up. Held in memory: a restarted server holds none.
 */
export const APPROVAL_MS = 120_000
/** At most this many approvals are held; past it the oldest goes. */
const MAX_APPROVALS = 1000

export type Approval = { dir: string; command: string; digest: string }

const held = new Map<string, Approval & { at: number }>()
const keyOf = (root: string, swarm: string, id: string): string => `${root}\u0000${swarm}\u0000${id}`

export function approveGate(root: string, swarm: string, id: string, a: Approval, nowMs: number): void {
  const key = keyOf(root, swarm, id)
  held.delete(key) // set again below, so the map's order stays oldest first
  for (const [k, v] of held) if (nowMs - v.at > APPROVAL_MS) held.delete(k)
  while (held.size >= MAX_APPROVALS) held.delete(held.keys().next().value!)
  held.set(key, { dir: a.dir, command: a.command, digest: a.digest, at: nowMs })
}

/** The task's approval, used up; null when there is none or it is older than APPROVAL_MS. */
export function takeApproval(root: string, swarm: string, id: string, nowMs: number): Approval | null {
  const key = keyOf(root, swarm, id)
  const a = held.get(key)
  held.delete(key)
  if (a === undefined || nowMs - a.at > APPROVAL_MS || nowMs < a.at) return null
  return { dir: a.dir, command: a.command, digest: a.digest }
}
