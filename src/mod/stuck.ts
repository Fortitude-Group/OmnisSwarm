/** The stuck guard's two patterns (spec section 3). Pure and mod-safe; node:test covers it. */
import type { StuckPattern, ToolKind } from '../core/events.ts'

export const STUCK_NUDGE_AFTER = 5
export const REPEAT_NUDGE_AFTER = 4
/** Re-reading, re-running, re-searching, re-fetching. Messages and other tools are not a loop. */
const REPEAT_KINDS: readonly ToolKind[] = ['read', 'bash', 'search', 'web']
/** At most this many agents are tracked; the oldest is dropped. */
const MAX_AGENTS = 500

/** again: the agent has been hit before in this run. handoff: this hit is the one that asks for the handoff note (the first again). */
export type StuckHit = { pattern: StuckPattern; count: number; tool: string; subject: string; again?: true; handoff?: true }

type Track = {
  failing: number; failFired: boolean; repeatKey: string | null; repeats: number; repeatFired: boolean
  /** Hits so far in this run, and whether the stuck-again handoff has been taken. */
  hits: number; handed: boolean
}

export class StuckWatch {
  #agents = new Map<string, Track>()

  #track(agent: string): Track {
    let t = this.#agents.get(agent)
    if (t === undefined) {
      if (this.#agents.size >= MAX_AGENTS) this.#agents.delete(this.#agents.keys().next().value!)
      t = { failing: 0, failFired: false, repeatKey: null, repeats: 0, repeatFired: false, hits: 0, handed: false }
      this.#agents.set(agent, t)
    }
    return t
  }

  /** Counts a hit. The second and later carry again; the second alone carries the handoff, so a run asks for it once. */
  #hit(t: Track, hit: StuckHit): StuckHit {
    const again = t.hits >= 1
    t.hits++
    if (!again) return hit
    const takes = !t.handed
    t.handed = true
    return { ...hit, again: true, ...(takes && { handoff: true as const }) }
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
    return this.#hit(t, { pattern: 'repeating', count: t.repeats, tool, subject })
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
    return this.#hit(t, { pattern: 'failing', count: t.failing, tool, subject })
  }

  /**
   * The pattern the agent is still stuck in, or null: one has fired and has not re-armed, and the stuck-again handoff has
   * not been taken in this run. A turn that ends while this holds asks for a handoff note. Read this before forget.
   */
  stillStuck(agent: string): StuckPattern | null {
    const t = this.#agents.get(agent)
    if (t === undefined || t.handed) return null
    return t.failFired ? 'failing' : t.repeatFired ? 'repeating' : null
  }

  forget(agent: string): void {
    this.#agents.delete(agent)
  }
}

/** What an agent already hit once in this run is told instead of the nudge (spec 3.2). */
export const STOP_TEXT = "You're still stuck. Stop here, and report to main what you tried and what's blocking you."

export const nudgeFor = (hit: StuckHit): string =>
  hit.again === true
    ? STOP_TEXT
    : hit.pattern === 'failing'
    ? `Your last ${STUCK_NUDGE_AFTER} tool calls failed. Step back and try another approach, or report to main what's blocking you.`
    : `You've run ${hit.tool} on ${hit.subject} ${REPEAT_NUDGE_AFTER} times with no change in between. Step back and try another approach, or report to main.`

export function stuckMainText(name: string, pattern: StuckPattern, delivered: boolean, reason?: string): string {
  const tail = delivered ? '' : ` The message was not delivered${reason === undefined || reason === '' ? '' : `: ${reason}`}.`
  return `[OmnisSwarm] ${name} looks stuck (${pattern}) and was asked to step back.${tail}`
}

/** The line to main once handoff notes are written (spec 3.3). `ids` are task ids; several notes use the plural wording. */
export function handoffMainText(name: string, ids: readonly string[], pattern: StuckPattern, why: 'stuck' | 'finished'): string {
  const list = ids.join(', ')
  const keys = ids.map(id => `handoff/${id}`).join(', ')
  const verb = why === 'stuck' ? 'is stuck on' : 'finished while stuck on'
  return ids.length === 1
    ? `[OmnisSwarm] ${name} ${verb} ${list} (${pattern}). Its handoff note is in memory: ${keys}. To hand it on, stop ${name}, then give ${list} a new assignee and tell it to read ${keys} first.`
    : `[OmnisSwarm] ${name} ${verb} ${list} (${pattern}). Its handoff notes are in memory: ${keys}. To hand them on, stop ${name}, then give each a new assignee and tell it to read its note first.`
}

export const noOpenTaskText = (name: string, pattern: StuckPattern): string => `[OmnisSwarm] ${name} is stuck (${pattern}) and has no open task to hand on.`

/** How long the mod waits for omnis_handoff before it gives up (spec 3.3). */
export const HANDOFF_ASK_MS = 2000
const NOTE_KEY = /^handoff\/(t[0-9]{1,6})$/

/** The task ids in omnis_handoff's reply, or null when it is not the expected shape. The server is trusted no further than that. */
export function parseNotes(text: string): string[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const notes = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as { notes?: unknown }).notes : undefined
  if (!Array.isArray(notes) || notes.length > 3) return null
  const ids: string[] = []
  for (const n of notes) {
    const m = typeof n === 'string' ? NOTE_KEY.exec(n) : null
    if (m === null) return null
    ids.push(m[1]!)
  }
  return new Set(ids).size === ids.length ? ids : null
}
