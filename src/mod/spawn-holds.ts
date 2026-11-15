/**
 * The spawn hold's state (docs/superpowers/specs/2026-11-15-spawn-hold-design.md). Agents are grouped by type and model:
 * the first of a group leads, the rest wait until it starts answering, and nothing waits past HOLD_MAX_MS. Pure and
 * mod-safe; node:test covers it. Times are the caller's clock, in milliseconds.
 */

/** The longest a group's siblings are held, so they still start inside the 5-minute cache. */
export const HOLD_MAX_MS = 240_000
/** How long after its latest step a group counts as warm: same-type spawns then go straight away. */
export const WARM_MS = 300_000

export const HOLD_SETTINGS = ['on', 'off'] as const
export type HoldSetting = (typeof HOLD_SETTINGS)[number]
export const holdSettingFrom = (x: unknown): HoldSetting => (x === 'off' ? 'off' : 'on')

/** Why a hold ended: the leader started answering, its run ended first, or the time ran out. */
export const HOLD_WHY = ['answered', 'timeout', 'failed'] as const
export type HoldWhy = (typeof HOLD_WHY)[number]
/** What a held spawn is told: go as the group's new leader, or go because the hold ended. */
export type HoldOutcome = 'lead' | HoldWhy
export type HoldEnd = { role: string; count: number; ms: number; why: HoldWhy }

export type Ticket = { kind: 'hold'; first: boolean; done: Promise<HoldOutcome>; cancel: () => void }
export type Turn = { kind: 'lead' } | { kind: 'pass' } | Ticket

type Waiter = { go: (o: HoldOutcome) => void }
type Group = {
  role: string
  /** starting: the leader hasn't answered, so siblings wait. open: they go straight away. */
  phase: 'starting' | 'open'
  /** The leader's agent id once its spawn answered; null while it is starting. */
  leader: string | null
  leaderSince: number
  /** When the group opened, or one of its agents last stepped, whichever is later. */
  warmAt: number
  waiters: Waiter[]
  /** When this round's first sibling was held, and how many have been. */
  heldSince: number | null
  held: number
}

export class SpawnHolds {
  #groups = new Map<string, Group>()
  /** Each live agent's group key. */
  #agents = new Map<string, string>()

  #lead(key: string, role: string, now: number): Turn {
    this.#groups.set(key, { role, phase: 'starting', leader: null, leaderSince: now, warmAt: now, waiters: [], heldSince: null, held: 0 })
    return { kind: 'lead' }
  }

  /** Lets every waiter go and opens the group; the round's end, when anything was held. */
  #open(g: Group, why: HoldWhy, now: number): HoldEnd | null {
    const end = g.held > 0 && g.heldSince !== null ? { role: g.role, count: g.held, ms: Math.max(0, now - g.heldSince), why } : null
    const waiters = g.waiters
    g.waiters = []
    g.held = 0
    g.heldSince = null
    g.phase = 'open'
    g.warmAt = now
    for (const w of waiters) w.go(why)
    return end
  }

  /** A spawn of group `key` is about to start: lead, pass, or hold. `ends` collects a round a stale leader ended. */
  arrive(key: string, role: string, now: number, ends: HoldEnd[] = []): Turn {
    const g = this.#groups.get(key)
    if (g === undefined) return this.#lead(key, role, now)
    if (g.phase === 'starting') {
      const timedOut = g.heldSince !== null ? now - g.heldSince >= HOLD_MAX_MS : now - g.leaderSince >= HOLD_MAX_MS
      if (!timedOut) return this.#hold(g, now)
      const end = this.#open(g, 'timeout', now)
      if (end !== null) ends.push(end)
      // A leader that never reported back holds nothing more: this spawn leads afresh.
      if (end === null) return this.#lead(key, role, now)
    }
    return now - g.warmAt < WARM_MS ? { kind: 'pass' } : this.#lead(key, role, now)
  }

  #hold(g: Group, now: number): Ticket {
    const first = g.held === 0
    if (first) g.heldSince = now
    g.held++
    let go: (o: HoldOutcome) => void = () => undefined
    const done = new Promise<HoldOutcome>(resolve => {
      go = resolve
    })
    const w: Waiter = { go }
    g.waiters.push(w)
    return {
      kind: 'hold', first, done,
      cancel: () => {
        const i = g.waiters.indexOf(w)
        if (i >= 0) g.waiters.splice(i, 1)
      },
    }
  }

  /** The leader's spawn answered: its agent id, or null when it was refused or threw (the longest-held sibling leads then). */
  started(key: string, agentId: string | null, now: number): void {
    const g = this.#groups.get(key)
    if (g === undefined) return
    if (agentId !== null) this.#agents.set(agentId, key)
    if (g.phase !== 'starting' || g.leader !== null) return
    if (agentId !== null) {
      g.leader = agentId
      return
    }
    const next = g.waiters.shift()
    if (next === undefined) {
      this.#groups.delete(key)
      return
    }
    g.leaderSince = now
    next.go('lead')
  }

  /** A spawn that went without leading started as `agentId`. */
  track(key: string, agentId: string): void {
    if (this.#groups.has(key)) this.#agents.set(agentId, key)
  }

  /** True for an agent the hold knows: one whose spawn it saw start. */
  tracks(agentId: string): boolean {
    return this.#agents.has(agentId)
  }

  /** True when `agentId`'s first chunk would end a hold: its group is waiting on an answer. */
  awaited(agentId: string): boolean {
    const key = this.#agents.get(agentId)
    return key !== undefined && this.#groups.get(key)?.phase === 'starting'
  }

  /** `agentId` sent a model request: an open group stays warm. */
  stepped(agentId: string, now: number): void {
    const key = this.#agents.get(agentId)
    const g = key === undefined ? undefined : this.#groups.get(key)
    if (g !== undefined && g.phase === 'open') g.warmAt = now
  }

  /** `agentId`'s response started: a group waiting on an answer lets its siblings go. */
  answered(agentId: string, now: number): HoldEnd | null {
    const key = this.#agents.get(agentId)
    const g = key === undefined ? undefined : this.#groups.get(key)
    if (g === undefined) return null
    if (g.phase === 'open') {
      g.warmAt = now
      return null
    }
    return this.#open(g, 'answered', now)
  }

  /** `agentId`'s run ended. A leader that never answered lets its siblings go. */
  finished(agentId: string, now: number): HoldEnd | null {
    const key = this.#agents.get(agentId)
    if (key === undefined) return null
    this.#agents.delete(agentId)
    const g = this.#groups.get(key)
    if (g === undefined || g.phase !== 'starting' || g.leader !== agentId) return null
    return this.#open(g, 'failed', now)
  }

  /** Ends every round held HOLD_MAX_MS or longer. */
  expire(now: number): HoldEnd[] {
    const ends: HoldEnd[] = []
    for (const g of this.#groups.values()) {
      if (g.phase !== 'starting' || g.heldSince === null || now - g.heldSince < HOLD_MAX_MS) continue
      const end = this.#open(g, 'timeout', now)
      if (end !== null) ends.push(end)
    }
    return ends
  }
}
