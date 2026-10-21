/**
 * What the pane holds between pulls: the swarm it follows, the offset it has read to, its own fold of the state (from
 * the events the server hands it, never from the log), recent tool pulses and how late events arrive. Pure, mod-safe.
 */
import { TOOL_KINDS, isOneOf, type SwarmEvent } from '../core/events.ts'
import type { FeedReply } from '../core/feed-reply.ts'
import { LEAD, fold, type SwarmState } from '../core/fold.ts'
import type { Pulse } from '../render/types.ts'

export type PaneModel = { swarm: string | null; offset: number; state: SwarmState | null; pulses: Pulse[]; lagMs: number }

/** Pulses older than this have finished flickering. */
export const PULSE_KEEP_MS = 2_000
export const MAX_PULSES = 64
/** A newest event older than this on arrival is history (a fresh load), not lag. */
export const MAX_LAG_MS = 1_000

export const emptyModel = (): PaneModel => ({ swarm: null, offset: 0, state: null, pulses: [], lagMs: 0 })

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

export const prunePulses = (pulses: readonly Pulse[], now: number): Pulse[] =>
  pulses.filter(p => now - p.at <= PULSE_KEEP_MS).slice(-MAX_PULSES)

export type Applied = { model: PaneModel; changed: boolean; swarmChanged: boolean }

export function applyReply(m: PaneModel, reply: FeedReply, arrivedAt: number): Applied {
  if (reply.kind === 'none') return { model: m, changed: false, swarmChanged: false }
  if (reply.kind === 'state') {
    const swarmChanged = reply.swarm !== m.swarm
    return {
      model: { swarm: reply.swarm, offset: reply.offset, state: reply.state, pulses: swarmChanged ? [] : prunePulses(m.pulses, arrivedAt), lagMs: swarmChanged ? 0 : m.lagMs },
      changed: true,
      swarmChanged,
    }
  }
  if (reply.swarm !== m.swarm || m.state === null) return { model: emptyModel(), changed: false, swarmChanged: m.swarm !== null }
  // Events must continue from what is held: the offset moves forward, and never with events but no progress.
  // Anything else cannot be trusted to line up, so forget the state and pull a fresh one.
  if (reply.offset < m.offset || (reply.offset === m.offset && (reply.events.length > 0 || reply.bad > 0))) {
    return { model: emptyModel(), changed: false, swarmChanged: false }
  }
  const state = m.state
  let newest = Number.NEGATIVE_INFINITY
  for (const e of reply.events) {
    fold(state, e)
    const at = Date.parse(e.ts)
    if (at > newest) newest = at
  }
  state.gaps += reply.bad
  const sample = arrivedAt - newest
  const lagMs = Number.isFinite(sample) && sample >= 0 && sample <= MAX_LAG_MS ? Math.round(m.lagMs * 0.8 + sample * 0.2) : m.lagMs
  return {
    model: { swarm: m.swarm, offset: reply.offset, state, pulses: prunePulses([...m.pulses, ...pulsesFrom(reply.events)], arrivedAt), lagMs },
    changed: reply.events.length > 0 || reply.bad > 0,
    swarmChanged: false,
  }
}
