/**
 * Which tasks can start (spec section 2.1). Pure and mod-safe: no I/O. Every walk stops after MAX_TASKS steps, so a forged
 * log line with a looping or oversized dependsOn can't hang a reader. A dependency that names no task is ignored: it can
 * never finish, and holding the task for it would strand it with no word of why.
 */
import type { TaskState } from './events.ts'
import type { SwarmState, TaskEntry } from './fold.ts'

/** The most tasks a swarm holds, and the most steps any walk here takes. */
export const MAX_TASKS = 500

type Tasks = SwarmState['tasks']

const find = (tasks: Tasks, id: string): TaskEntry | undefined => (Object.hasOwn(tasks, id) ? tasks[id] : undefined)

/** t2 before t10: by the number in the id, then by the text. */
const byId = (a: TaskEntry, b: TaskEntry): number => {
  const x = Number(a.id.replace(/\D+/g, ''))
  const y = Number(b.id.replace(/\D+/g, ''))
  return x !== y && !Number.isNaN(x) && !Number.isNaN(y) ? x - y : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** The task's dependencies that exist and are not done, in the order the task lists them. */
function unfinished(tasks: Tasks, task: TaskEntry): TaskEntry[] {
  const out: TaskEntry[] = []
  for (const dep of task.dependsOn.slice(0, MAX_TASKS)) {
    const found = find(tasks, dep)
    if (found !== undefined && found.state !== 'done' && !out.includes(found)) out.push(found)
  }
  return out
}

const isReady = (tasks: Tasks, task: TaskEntry): boolean => task.state === 'pending' && unfinished(tasks, task).length === 0

/** Pending tasks whose dependencies are all done, in id order. */
export function readyTasks(state: SwarmState): TaskEntry[] {
  return Object.values(state.tasks).slice(0, MAX_TASKS).filter(t => isReady(state.tasks, t)).sort(byId)
}

/** Tasks that are ready in `after` and were not ready in `before`, in id order. */
export function newlyReady(before: Tasks, after: Tasks): TaskEntry[] {
  return Object.values(after).slice(0, MAX_TASKS).filter(t => {
    if (!isReady(after, t)) return false
    const was = find(before, t.id)
    return was === undefined || !isReady(before, was)
  }).sort(byId)
}

/** The task's dependencies that are not done yet, with their state. Empty when the task is unknown. */
export function waitsOn(state: SwarmState, id: string): { id: string; state: TaskState }[] {
  const task = find(state.tasks, id)
  return task === undefined ? [] : unfinished(state.tasks, task).map(t => ({ id: t.id, state: t.state }))
}

/** The failed dependencies of a pending task: the ones that mean it can never start. Empty otherwise. */
export function strandedBy(state: SwarmState, id: string): string[] {
  const task = find(state.tasks, id)
  if (task === undefined || task.state !== 'pending') return []
  return unfinished(state.tasks, task).filter(t => t.state === 'failed').map(t => t.id)
}

/**
 * The loop that giving task `id` the dependencies `deps` would close, as `[id, dep, …, id]`, or null when there is none.
 * The task's current dependencies are being replaced, so they are not followed.
 */
export function cyclePath(tasks: Tasks, id: string, deps: readonly string[]): string[] | null {
  let steps = 0
  const seen = new Set<string>()
  // Depth-first from each new dependency, looking for a way back to `id`.
  const walk = (at: string, path: string[]): string[] | null => {
    if (at === id) return [id, ...path]
    if (seen.has(at) || ++steps > MAX_TASKS) return null
    seen.add(at)
    const task = find(tasks, at)
    if (task === undefined) return null
    for (const next of task.dependsOn.slice(0, MAX_TASKS)) {
      const found = walk(next, [...path, next])
      if (found !== null) return found
    }
    return null
  }
  for (const dep of deps) {
    const found = walk(dep, [dep])
    if (found !== null) return found
    if (steps > MAX_TASKS) return null
  }
  return null
}

export const wouldCycle = (tasks: Tasks, id: string, deps: readonly string[]): boolean => cyclePath(tasks, id, deps) !== null
