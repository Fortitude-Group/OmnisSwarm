/** The omnis_replay reply and the mod's check of it. Pure and mod-safe. */
import { isValidSwarmId, parseLine, type SwarmEvent } from './events.ts'
import { FEED_MAX_EVENTS } from './feed-reply.ts'

/** The most events the pane loads for one replay. */
export const REPLAY_MAX_EVENTS = 20_000

export type ReplayReply =
  | { v: 1; kind: 'replay'; swarm: string; offset: number; done: boolean; events: SwarmEvent[]; bad: number }
  | { v: 1; kind: 'none'; recent: string[] }

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const isCount = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0

export function parseReplayReply(text: string): ReplayReply | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObj(raw) || raw.v !== 1) return null
  if (raw.kind === 'none') {
    if (!Array.isArray(raw.recent) || raw.recent.length > 5 || !raw.recent.every(r => typeof r === 'string' && isValidSwarmId(r))) return null
    return { v: 1, kind: 'none', recent: raw.recent as string[] }
  }
  if (raw.kind !== 'replay' || typeof raw.swarm !== 'string' || !isValidSwarmId(raw.swarm) || !isCount(raw.offset) || typeof raw.done !== 'boolean' || !isCount(raw.bad)) return null
  if (!Array.isArray(raw.events) || raw.events.length > FEED_MAX_EVENTS) return null
  const events: SwarmEvent[] = []
  for (const item of raw.events) {
    const parsed = parseLine(JSON.stringify(item))
    if (!parsed.ok || parsed.event.swarm !== raw.swarm) return null
    events.push(parsed.event)
  }
  return { v: 1, kind: 'replay', swarm: raw.swarm, offset: raw.offset, done: raw.done, events, bad: raw.bad }
}
