/** The omnis_feed reply: what the MCP server sends the pane, and the pane's check of it. Pure and mod-safe. */
import { isValidSwarmId, parseLine, type SwarmEvent } from './events.ts'
import { LEAD, type SwarmState } from './fold.ts'
import { isSwarmState } from './state-check.ts'
import { BURN_WINDOW_MS } from './stats.ts'

export const FEED_VERSION = 1
/** The most events one reply carries; further behind than this, the server answers a fresh state. */
export const FEED_MAX_EVENTS = 500

/** The most bytes (UTF-8) one serialised reply may hold. Claude Code caps MCP output near 50,000, so this leaves margin. */
export const FEED_REPLY_MAX = 40_000

/** The UTF-8 size of `text` in bytes, counted over code points (plain string work, so it is mod-safe). */
export function utf8Bytes(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

/** No running agent's record, with its name entry, is smaller than this; used to give up early on huge swarms. */
const MIN_AGENT_BYTES = 500

export type FeedReply =
  | { v: 1; kind: 'none' }
  | { v: 1; kind: 'too-large'; agents: number }
  | { v: 1; kind: 'state'; swarm: string; offset: number; state: SwarmState; trimmed?: true; hiddenFinished?: number }
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
    if (raw.hiddenFinished !== undefined && !isCount(raw.hiddenFinished)) return null
    if (!isSwarmState(raw.state, swarm)) return null
    return { v: 1, kind: 'state', swarm, offset: raw.offset, state: raw.state, ...(raw.trimmed === true && { trimmed: true as const }), ...(raw.hiddenFinished !== undefined && { hiddenFinished: raw.hiddenFinished }) }
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
    used += utf8Bytes(JSON.stringify(events[i])) + 1
    if (used > FEED_REPLY_MAX) {
      if (i === 0) throw new Error('a single event is larger than the feed reply budget')
      return i
    }
  }
  return events.length
}

/** Width of the buckets a trimmed reply merges per-call spend into. */
export const SPEND_BUCKET_MS = 10_000

/**
 * The per-call spend list as a trimmed reply sends it: only the burn window before the latest entry (all the pane
 * reads), merged into SPEND_BUCKET_MS buckets stamped at their earliest call, so the burn can only read a little low.
 */
export function compactSpend(spend: SwarmState['spend']): SwarmState['spend'] {
  if (spend.length === 0) return []
  let latest = -Infinity
  for (const s of spend) if (s.at > latest) latest = s.at
  const buckets = new Map<number, { at: number; usd: number }>()
  for (const s of spend) {
    if (s.at < latest - BURN_WINDOW_MS) continue
    const key = Math.floor(s.at / SPEND_BUCKET_MS)
    const b = buckets.get(key)
    if (b === undefined) buckets.set(key, { at: s.at, usd: s.usd })
    else {
      b.at = Math.min(b.at, s.at)
      b.usd += s.usd
    }
  }
  return [...buckets.values()].sort((a, b) => a.at - b.at)
}

const last = <T>(xs: readonly T[], n: number): T[] => (n <= 0 ? [] : xs.slice(-n))

/** A copy of `state` with the stated lists cut; nothing in `state` itself changes. */
function cut(
  state: SwarmState,
  keep: { feed: number; files: number; samples: number; recent: number; edits: number },
  drop: ReadonlySet<string> = new Set(),
): SwarmState {
  const agents: SwarmState['agents'] = {}
  for (const [id, a] of Object.entries(state.agents)) {
    if (!drop.has(id)) agents[id] = { ...a, files: last(a.files, keep.files), samples: last(a.samples, keep.samples) }
  }
  const byName: SwarmState['byName'] = {}
  for (const [name, id] of Object.entries(state.byName)) if (!drop.has(id)) byName[name] = id
  const links: SwarmState['links'] = {}
  for (const [k, l] of Object.entries(state.links)) {
    if (!drop.has(l.from) && !drop.has(l.to)) links[k] = { ...l, recent: last(l.recent, keep.recent) }
  }
  const edits: SwarmState['edits'] = {}
  for (const [k, v] of Object.entries(state.edits)) {
    const kept = last(v.filter(e => !drop.has(e.agent)), keep.edits)
    if (kept.length > 0 || v.length === 0) edits[k] = kept
  }
  return { ...state, agents, byName, links, edits, feed: last(state.feed, keep.feed), spend: compactSpend(state.spend) }
}

/** Finished agents kept in full when the state is too big; older finished ones are left out. */
export const KEEP_FINISHED = 20

export type FreshReply = Extract<FeedReply, { kind: 'state' | 'too-large' }>

/**
 * A state reply that serialises under FEED_REPLY_MAX. Every trimming stage also compacts the per-call spend list
 * (compactSpend). Trims in a fixed order until it fits: oldest feed items, then each
 * agent's files (20) and samples (10), then each link's recent (1), then edits per path (2). Else `too-large`.
 */
export function freshReply(swarm: string, offset: number, state: SwarmState): FreshReply {
  const done = (s: SwarmState, hidden = 0): FreshReply => ({
    v: 1, kind: 'state', swarm, offset, state: s, trimmed: true, ...(hidden > 0 && { hiddenFinished: hidden }),
  })
  /** The size of the exact reply that would be sent for `s`. */
  const size = (s: SwarmState, hidden = 0): number => utf8Bytes(JSON.stringify(done(s, hidden)))
  if (utf8Bytes(JSON.stringify({ v: 1, kind: 'state', swarm, offset, state })) <= FEED_REPLY_MAX) return { v: 1, kind: 'state', swarm, offset, state }
  const tooLarge: FreshReply = { v: 1, kind: 'too-large', agents: Object.keys(state.agents).length }
  // Running agents are never left out, so this many cannot fit however much else is trimmed.
  if (Object.values(state.agents).filter(a => a.finishedAt === null).length * MIN_AGENT_BYTES > FEED_REPLY_MAX) return tooLarge
  const full = { feed: state.feed.length, files: Infinity, samples: Infinity, recent: Infinity, edits: Infinity }
  // Stage 1: the most feed items that fit; a fit at 0 items means no later stage is needed.
  let lo = 0
  let hi = state.feed.length
  if (size(cut(state, { ...full, feed: 0 })) <= FEED_REPLY_MAX) {
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (size(cut(state, { ...full, feed: mid })) <= FEED_REPLY_MAX) lo = mid
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
    if (size(s) <= FEED_REPLY_MAX) return done(s)
  }
  // Stage 5: leave out all but the most recently finished agents; running and waiting ones are never left out.
  const finished = Object.values(state.agents).filter(a => a.finishedAt !== null && a.id !== LEAD)
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0) || (a.id < b.id ? -1 : 1))
  const dropped = new Set(finished.slice(KEEP_FINISHED).map(a => a.id))
  const lean = stages[2]!
  if (dropped.size > 0) {
    const s = cut(state, lean, dropped)
    if (size(s, dropped.size) <= FEED_REPLY_MAX) return done(s, dropped.size)
  }
  // Stage 6: empty every kept agent's files and samples.
  const s = cut(state, { ...lean, files: 0, samples: 0 }, dropped)
  if (size(s, dropped.size) <= FEED_REPLY_MAX) return done(s, dropped.size)
  return tooLarge
}
