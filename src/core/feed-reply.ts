/** The omnis_feed reply: what the MCP server sends the pane, and the pane's check of it. Pure and mod-safe. */
import { isValidSwarmId, parseLine, type SwarmEvent } from './events.ts'
import type { SwarmState } from './fold.ts'
import { isSwarmState } from './state-check.ts'

export const FEED_VERSION = 1
/** The most events one reply carries; further behind than this, the server answers a fresh state. */
export const FEED_MAX_EVENTS = 500

export type FeedReply =
  | { v: 1; kind: 'none' }
  | { v: 1; kind: 'state'; swarm: string; offset: number; state: SwarmState }
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
  if (typeof raw.swarm !== 'string' || !isValidSwarmId(raw.swarm) || !isCount(raw.offset)) return null
  const swarm = raw.swarm
  if (raw.kind === 'state') {
    return isSwarmState(raw.state, swarm) ? { v: 1, kind: 'state', swarm, offset: raw.offset, state: raw.state } : null
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
