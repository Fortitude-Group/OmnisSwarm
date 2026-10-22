/**
 * What the pane holds between pulls: the swarm it follows, the offset it has read to, its own fold of the state (from
 * the events the server hands it, never from the log), recent tool pulses and how late events arrive. Pure, mod-safe.
 */
import { TOOL_KINDS, isOneOf, type SwarmEvent } from '../core/events.ts'
import type { FeedReply } from '../core/feed-reply.ts'
import { LEAD, fold, type SwarmState } from '../core/fold.ts'
import type { Pulse } from '../render/types.ts'

/** Why the last read failed, for the renderer to show; null when the last read was good. */
export type Degraded = 'too-large' | 'unreadable'
/** `hiddenFinished`: finished agents the server left out of a trimmed state, for a "+N finished" note. `degradedAgents`: the agent count a too-large reply reported (0 otherwise). */
export type PaneModel = { swarm: string | null; offset: number; state: SwarmState | null; pulses: Pulse[]; lastFlicker: Readonly<Record<string, number>>; lagMs: number; degraded: Degraded | null; degradedAgents: number; hiddenFinished: number }

/** Pulses older than this have finished flickering. */
export const PULSE_KEEP_MS = 2_000
export const MAX_PULSES = 64
/** A tool start less than this after its agent's last flicker is folded into it (not drawn). */
export const COALESCE_MS = 600
/** A newest event older than this on arrival is history (a fresh load), not lag. */
export const MAX_LAG_MS = 1_000

export const emptyModel = (): PaneModel => ({ swarm: null, offset: 0, state: null, pulses: [], lastFlicker: {}, lagMs: 0, degraded: null, degradedAgents: 0, hiddenFinished: 0 })

/**
 * The arguments of the next omnis_feed pull. No swarm is named on the first pull, so the server picks the session's own.
 */
export const feedArgs = (m: PaneModel): { since: number; swarm?: string } =>
  m.swarm === null || m.state === null ? { since: 0 } : { since: m.offset, swarm: m.swarm }

export function pulsesFrom(events: readonly SwarmEvent[]): Pulse[] {
  const out: Pulse[] = []
  for (const e of events) {
    if (e.type !== 'agent.tool') continue
    const at = Date.parse(e.ts)
    if (Number.isNaN(at)) continue
    const kind = isOneOf(TOOL_KINDS, e.data.kind) ? e.data.kind : 'other'
    const agent = e.agent ?? LEAD
    if (e.data.phase === 'start') out.push({ agent, kind, at, isError: false })
    else if (e.data.isError === true) out.push({ agent, kind, at, isError: true })
  }
  return out
}

/**
 * Decides each new pulse once, as it arrives, against the time its agent last flickered: a tool start under
 * COALESCE_MS after it is marked coalesced; an error is never skipped and restarts the clock. Doing it here, not at
 * draw time, keeps the choice stable as old pulses are pruned.
 */
export function markPulses(fresh: readonly Pulse[], last: Readonly<Record<string, number>>): { pulses: Pulse[]; lastFlicker: Record<string, number> } {
  // No prototype, so an agent id like '__proto__' or 'constructor' is an ordinary key.
  const lastFlicker: Record<string, number> = Object.assign(Object.create(null) as Record<string, number>, last)
  const pulses: Pulse[] = []
  for (const p of [...fresh].filter(p => Number.isFinite(p.at)).sort((a, b) => a.at - b.at)) {
    const prev = Object.hasOwn(lastFlicker, p.agent) ? lastFlicker[p.agent] : undefined
    if (!p.isError && prev !== undefined && p.at - prev < COALESCE_MS) {
      pulses.push({ ...p, coalesced: true })
      continue
    }
    lastFlicker[p.agent] = p.at
    pulses.push(p)
  }
  // An entry older than the newest start by COALESCE_MS or more cannot change any later decision.
  const newest = pulses.length > 0 ? pulses[pulses.length - 1]!.at : Number.NEGATIVE_INFINITY
  for (const id of Object.keys(lastFlicker)) if (lastFlicker[id]! < newest - COALESCE_MS) delete lastFlicker[id]
  return { pulses, lastFlicker }
}

export const prunePulses = (pulses: readonly Pulse[], now: number): Pulse[] =>
  pulses.filter(p => now - p.at <= PULSE_KEEP_MS).slice(-MAX_PULSES)

export type Applied = { model: PaneModel; changed: boolean; swarmChanged: boolean }

/** A failed read (a reply that would not parse, or one the server said was too large): keep the last good state and flag it. */
export function markDegraded(m: PaneModel, why: Degraded, agents = 0): Applied {
  return { model: { ...m, degraded: why, degradedAgents: agents }, changed: m.degraded !== why || m.degradedAgents !== agents, swarmChanged: false }
}

/** Applies one reply; a null `reply` is one that failed to parse. A good reply clears any degraded flag. */
export function applyReply(m: PaneModel, reply: FeedReply | null, arrivedAt: number): Applied {
  if (reply === null) return markDegraded(m, 'unreadable')
  if (reply.kind === 'too-large') return markDegraded(m, 'too-large', reply.agents)
  const out = applyGood(m, reply, arrivedAt)
  return m.degraded === null ? out : { ...out, model: { ...out.model, degraded: null, degradedAgents: 0 }, changed: true }
}

function applyGood(m: PaneModel, reply: Exclude<FeedReply, { kind: 'too-large' }>, arrivedAt: number): Applied {
  if (reply.kind === 'none') return { model: m, changed: false, swarmChanged: false }
  if (reply.kind === 'state') {
    const swarmChanged = reply.swarm !== m.swarm
    return {
      model: { swarm: reply.swarm, offset: reply.offset, state: reply.state, pulses: swarmChanged ? [] : prunePulses(m.pulses, arrivedAt), lastFlicker: swarmChanged ? {} : m.lastFlicker, lagMs: swarmChanged ? 0 : m.lagMs, degraded: null, degradedAgents: 0, hiddenFinished: reply.hiddenFinished ?? 0 },
      changed: true,
      swarmChanged,
    }
  }
  if (reply.swarm !== m.swarm || m.state === null) return { model: emptyModel(), changed: false, swarmChanged: m.swarm !== null }
  // Events must continue from what is held: the offset moves forward, and never with events but no progress.
  // Anything else cannot be trusted to line up: keep the last good frame and ask from 0 for a fresh state.
  if (reply.offset < m.offset || (reply.offset === m.offset && (reply.events.length > 0 || reply.bad > 0))) {
    return { model: { ...m, offset: 0 }, changed: false, swarmChanged: false }
  }
  const state = m.state
  const agents = Object.keys(state.agents).length
  let newest = Number.NEGATIVE_INFINITY
  for (const e of reply.events) {
    fold(state, e)
    const at = Date.parse(e.ts)
    if (at > newest) newest = at
  }
  state.gaps += reply.bad
  const sample = arrivedAt - newest
  const lagMs = Number.isFinite(sample) && sample >= 0 && sample <= MAX_LAG_MS ? Math.round(m.lagMs * 0.8 + sample * 0.2) : m.lagMs
  // An agent the state did not hold may be one the server left out of a trimmed state: the count is stale, so drop it.
  const hiddenFinished = Object.keys(state.agents).length > agents ? 0 : m.hiddenFinished
  const marked = markPulses(pulsesFrom(reply.events), m.lastFlicker)
  return {
    model: { swarm: m.swarm, offset: reply.offset, state, pulses: prunePulses([...m.pulses, ...marked.pulses], arrivedAt), lastFlicker: marked.lastFlicker, lagMs, degraded: null, degradedAgents: 0, hiddenFinished },
    changed: reply.events.length > 0 || reply.bad > 0,
    swarmChanged: false,
  }
}
