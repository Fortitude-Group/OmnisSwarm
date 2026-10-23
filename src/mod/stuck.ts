/** The stuck guard's two patterns (spec section 3). Pure and mod-safe; node:test covers it. */
import type { StuckPattern, ToolKind } from '../core/events.ts'

export const STUCK_NUDGE_AFTER = 5
export const REPEAT_NUDGE_AFTER = 4
/** Re-reading, re-running, re-searching, re-fetching. Messages and other tools are not a loop. */
const REPEAT_KINDS: readonly ToolKind[] = ['read', 'bash', 'search', 'web']
/** At most this many agents are tracked; the oldest is dropped. */
const MAX_AGENTS = 500

export type StuckHit = { pattern: StuckPattern; count: number; tool: string; subject: string }

type Track = { failing: number; failFired: boolean; repeatKey: string | null; repeats: number; repeatFired: boolean }

export class StuckWatch {
  #agents = new Map<string, Track>()

  #track(agent: string): Track {
    let t = this.#agents.get(agent)
    if (t === undefined) {
      if (this.#agents.size >= MAX_AGENTS) this.#agents.delete(this.#agents.keys().next().value!)
      t = { failing: 0, failFired: false, repeatKey: null, repeats: 0, repeatFired: false }
      this.#agents.set(agent, t)
    }
    return t
  }

  /**
   * A tool call started. The same tool on the same subject again may be a repeating hit. An edit start leaves both
   * patterns alone: the edit may be refused, and only one that goes ahead (its end) re-arms them.
   */
  start(agent: string, tool: string, kind: ToolKind, subject: string): StuckHit | null {
    const t = this.#track(agent)
    if (kind === 'edit') return null
    const key = REPEAT_KINDS.includes(kind) && subject !== '' ? `${tool}\n${subject}` : null
    if (key === null || key !== t.repeatKey) {
      Object.assign(t, { repeatKey: key, repeats: key === null ? 0 : 1, repeatFired: false })
      return null
    }
    t.repeats++
    if (t.repeats < REPEAT_NUDGE_AFTER || t.repeatFired) return null
    t.repeatFired = true
    return { pattern: 'repeating', count: t.repeats, tool, subject }
  }

  /**
   * A tool call ended. A success re-arms failing, and an edit that went ahead re-arms both. The fifth failure in a row,
   * refused edits included, is a failing hit.
   */
  end(agent: string, tool: string, kind: ToolKind, subject: string, isError: boolean): StuckHit | null {
    const t = this.#track(agent)
    if (!isError) {
      t.failing = 0
      t.failFired = false
      if (kind === 'edit') Object.assign(t, { repeatKey: null, repeats: 0, repeatFired: false })
      return null
    }
    t.failing++
    if (t.failing < STUCK_NUDGE_AFTER || t.failFired) return null
    t.failFired = true
    return { pattern: 'failing', count: t.failing, tool, subject }
  }

  forget(agent: string): void {
    this.#agents.delete(agent)
  }
}

export const nudgeFor = (hit: StuckHit): string =>
  hit.pattern === 'failing'
    ? `Your last ${STUCK_NUDGE_AFTER} tool calls failed. Step back and try another approach, or report to main what's blocking you.`
    : `You've run ${hit.tool} on ${hit.subject} ${REPEAT_NUDGE_AFTER} times with no change in between. Step back and try another approach, or report to main.`

export function stuckMainText(name: string, pattern: StuckPattern, delivered: boolean, reason?: string): string {
  const tail = delivered ? '' : ` The message was not delivered${reason === undefined || reason === '' ? '' : `: ${reason}`}.`
  return `[OmnisSwarm] ${name} looks stuck (${pattern}) and was asked to step back.${tail}`
}
