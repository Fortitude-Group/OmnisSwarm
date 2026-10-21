/** The omnis_feed reply: what the MCP server sends the pane, and the pane's check of it. Pure and mod-safe. */
import { isValidSwarmId, parseLine, type SwarmEvent } from './events.ts'
import type { SwarmState } from './fold.ts'
import { isSwarmState } from './state-check.ts'

export const FEED_VERSION = 1
/** The most events one reply carries; further behind than this, the server answers a fresh state. */
export const FEED_MAX_EVENTS = 500

/** The most characters one serialised reply may hold. Claude Code caps MCP output near 50,000, so this leaves margin. */
export const FEED_REPLY_MAX = 40_000

export type FeedReply =
  | { v: 1; kind: 'none' }
  | { v: 1; kind: 'too-large'; agents: number }
  | { v: 1; kind: 'state'; swarm: string; offset: number; state: SwarmState; trimmed?: true }
  | { v: 1; kind: 'events'; swarm: string; offset: number; events: SwarmEvent[]; bad: number }

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const isCount = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0

/** Null unless `text` is a well-formed reply. Every event is checked again as a log line would be. */
export function parseFeedReply(text: string): FeedReply | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObj(raw) || raw.v !== FEED_VERSION) return null
  if (raw.kind === 'none') return { v: 1, kind: 'none' }
  if (raw.kind === 'too-large') return isCount(raw.agents) ? { v: 1, kind: 'too-large', agents: raw.agents } : null
  if (typeof raw.swarm !== 'string' || !isValidSwarmId(raw.swarm) || !isCount(raw.offset)) return null
  const swarm = raw.swarm
  if (raw.kind === 'state') {
    if (raw.trimmed !== undefined && raw.trimmed !== true) return null
    if (!isSwarmState(raw.state, swarm)) return null
    return { v: 1, kind: 'state', swarm, offset: raw.offset, state: raw.state, ...(raw.trimmed === true && { trimmed: true as const }) }
  }
  if (raw.kind !== 'events' || !Array.isArray(raw.events) || raw.events.length > FEED_MAX_EVENTS || !isCount(raw.bad)) return null
  const events: SwarmEvent[] = []
  for (const item of raw.events) {
    const parsed = parseLine(JSON.stringify(item))
    if (!parsed.ok || parsed.event.swarm !== swarm) return null
    events.push(parsed.event)
  }
  return { v: 1, kind: 'events', swarm, offset: raw.offset, events, bad: raw.bad }
}

/** Characters taken by a reply holding no events: `{"v":1,"kind":"events","swarm":"..","offset":..,"events":[],"bad":..}`. */
const EVENTS_OVERHEAD = 160

/**
 * How many of `events`, from the front, fit in one reply. The caller sets the reply's offset to just after the last of
 * them. At least one is kept when any exist; a single event over the budget cannot happen (a line is at most 2 KB).
 */
export function fitEvents(events: readonly SwarmEvent[], swarm: string): number {
  let used = EVENTS_OVERHEAD + swarm.length
  for (let i = 0; i < events.length; i++) {
    used += JSON.stringify(events[i]).length + 1
    if (used > FEED_REPLY_MAX) {
      if (i === 0) throw new Error('a single event is larger than the feed reply budget')
      return i
    }
  }
  return events.length
}

const last = <T>(xs: readonly T[], n: number): T[] => (n <= 0 ? [] : xs.slice(-n))

/** A copy of `state` with the stated lists cut; nothing in `state` itself changes. */
function cut(state: SwarmState, keep: { feed: number; files: number; samples: number; recent: number; edits: number }): SwarmState {
  const agents: SwarmState['agents'] = {}
  for (const [id, a] of Object.entries(state.agents)) {
    agents[id] = { ...a, files: last(a.files, keep.files), samples: last(a.samples, keep.samples) }
  }
  const links: SwarmState['links'] = {}
  for (const [k, l] of Object.entries(state.links)) links[k] = { ...l, recent: last(l.recent, keep.recent) }
  const edits: SwarmState['edits'] = {}
  for (const [k, v] of Object.entries(state.edits)) edits[k] = last(v, keep.edits)
  return { ...state, agents, links, edits, feed: last(state.feed, keep.feed) }
}

export type FreshReply = Extract<FeedReply, { kind: 'state' | 'too-large' }>

/**
 * A state reply that serialises under FEED_REPLY_MAX. Trims in a fixed order until it fits: oldest feed items, then each
 * agent's files (20) and samples (10), then each link's recent (1), then edits per path (2). Else `too-large`.
 */
export function freshReply(swarm: string, offset: number, state: SwarmState): FreshReply {
  const size = (s: SwarmState, trimmed: boolean): number =>
    JSON.stringify({ v: 1, kind: 'state', swarm, offset, state: s, ...(trimmed && { trimmed: true }) }).length
  if (size(state, false) <= FEED_REPLY_MAX) return { v: 1, kind: 'state', swarm, offset, state }
  const done = (s: SwarmState): FreshReply => ({ v: 1, kind: 'state', swarm, offset, state: s, trimmed: true })
  const full = { feed: state.feed.length, files: Infinity, samples: Infinity, recent: Infinity, edits: Infinity }
  // Stage 1: the most feed items that fit; a fit at 0 items means no later stage is needed.
  let lo = 0
  let hi = state.feed.length
  if (size(cut(state, { ...full, feed: 0 }), true) <= FEED_REPLY_MAX) {
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (size(cut(state, { ...full, feed: mid }), true) <= FEED_REPLY_MAX) lo = mid
      else hi = mid - 1
    }
    return done(cut(state, { ...full, feed: lo }))
  }
  const stages = [
    { feed: 0, files: 20, samples: 10, recent: Infinity, edits: Infinity },
    { feed: 0, files: 20, samples: 10, recent: 1, edits: Infinity },
    { feed: 0, files: 20, samples: 10, recent: 1, edits: 2 },
  ]
  for (const keep of stages) {
    const s = cut(state, keep)
    if (size(s, true) <= FEED_REPLY_MAX) return done(s)
  }
  return { v: 1, kind: 'too-large', agents: Object.keys(state.agents).length }
}
