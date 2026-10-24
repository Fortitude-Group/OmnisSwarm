/** The task, gate and fence cases of the fold. Split from fold.ts to keep that file small; they share its helpers. */
import { FENCE_MODES, GATE_RESULTS, TASK_STATES, isOneOf, isSafeKey, type SwarmEvent } from './events.ts'
import { agentOf, feed, text, type SwarmState } from './fold.ts'

export const MAX_OWNS = 20
export const MAX_OWN_LEN = 200
export const MAX_WORKTREE = 400
/** How many gate results a task keeps, oldest first. */
export const GATE_HISTORY = 5

/** A pattern list as the fold accepts it: strings only, cleaned, at most MAX_OWNS. Null when it isn't a list. */
function ownsOf(x: unknown): string[] | null {
  if (!Array.isArray(x)) return null
  return x.map(p => text(p, MAX_OWN_LEN)).filter(p => p !== '').slice(0, MAX_OWNS)
}

/** What a failed gate looks like in the feed. The event holds the exit code, not the reason text. */
function whyFailed(result: string, exit: unknown): string {
  if (result === 'timeout') return 'timed out'
  if (result === 'error') return 'could not start'
  return typeof exit === 'number' && Number.isFinite(exit) ? `exit ${exit}` : 'failed'
}

export function foldTasks(state: SwarmState, e: SwarmEvent, at: number, who: string): void {
  switch (e.type) {
    case 'task.created': {
      const d = e.data
      const id = text(d.id, 32)
      if (!isSafeKey(id)) break
      state.tasks[id] = {
        id, title: text(d.title, 120), state: 'pending', assignee: text(d.assignee, 64) || null,
        dependsOn: Array.isArray(d.dependsOn)
          ? d.dependsOn.map(x => text(x, 32)).filter(x => x !== '' && isSafeKey(x)).slice(0, 20)
          : [],
        createdAt: at, updatedAt: at, note: null,
        owns: ownsOf(d.owns) ?? [], worktree: text(d.worktree, MAX_WORKTREE) || null, gate: null,
      }
      feed(state, { at, kind: 'task', agent: who, text: `task ${id} created: ${state.tasks[id]!.title}` })
      break
    }
    case 'task.updated': {
      const d = e.data
      const id = text(d.id, 32)
      const task = isSafeKey(id) && Object.hasOwn(state.tasks, id) ? state.tasks[id] : undefined
      if (task === undefined) break
      if (isOneOf(TASK_STATES, d.state)) task.state = d.state
      if (typeof d.assignee === 'string') task.assignee = text(d.assignee, 64) || null
      if (typeof d.note === 'string') task.note = text(d.note, 200)
      const owns = ownsOf(d.owns)
      if (owns !== null) task.owns = owns
      if (typeof d.worktree === 'string') task.worktree = text(d.worktree, MAX_WORKTREE) || null
      task.updatedAt = at
      feed(state, { at, kind: 'task', agent: who, text: `task ${id} → ${task.state}` })
      break
    }
    case 'gate.ran': {
      const d = e.data
      const id = text(d.task, 32)
      const task = isSafeKey(id) && Object.hasOwn(state.tasks, id) ? state.tasks[id] : undefined
      if (task === undefined || !isOneOf(GATE_RESULTS, d.result)) break
      const history = [...(task.gate?.history ?? []), d.result].slice(-GATE_HISTORY)
      task.gate = { result: d.result, at, runs: (task.gate?.runs ?? 0) + 1, history }
      const seconds = typeof d.ms === 'number' && Number.isFinite(d.ms) && d.ms > 0 ? Math.round(d.ms / 1000) : 0
      const line =
        d.result === 'passed' ? `gate ✓ ${seconds}s`
        : d.result === 'skipped' ? 'gate skipped'
        : d.result === 'none' ? 'no gate'
        : `gate ✕ ${whyFailed(d.result, d.exit)}`
      feed(state, { at, kind: 'task', agent: who, text: `task ${id} ${line}` })
      break
    }
    case 'fence.blocked': {
      const d = e.data
      const path = text(d.path, 80)
      if (path === '' || !isOneOf(FENCE_MODES, d.mode)) break
      const a = agentOf(state, who, at)
      a.fenceBlocks = (a.fenceBlocks ?? 0) + 1
      a.lastActivity = at
      feed(state, { at, kind: 'task', agent: a.id, text: `fence: ${a.name} ${d.mode === 'block' ? '✕' : '!'} ${path}` })
      break
    }
  }
}
