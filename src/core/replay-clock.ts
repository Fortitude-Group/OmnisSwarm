/** The replay clock (spec sections 3 and 4): gaps divided by the speed, quiet ones cut, events re-timed onto it. Pure, mod-safe. */
import type { SwarmEvent } from './events.ts'

export const MAX_GAP_MS = 2_000
export const MIN_SPEED = 1
export const MAX_SPEED = 60
/** A speed that is not a positive finite number would stall or poison the clock; it falls back to the slowest. */
const usable = (speed: number, fallback: number): number => (Number.isFinite(speed) && speed > 0 ? speed : fallback)
const SOURCE_ORDER: Record<string, number> = { mcp: 0, recorder: 1, transcripts: 2 }

/** Replay milliseconds from the first event for each log time (sorted ascending): each gap / speed, at most maxGapMs. */
export function replayOffsets(ts: readonly number[], speed: number, maxGapMs = MAX_GAP_MS): number[] {
  const s = usable(speed, MIN_SPEED)
  const out: number[] = []
  let r = 0
  for (let i = 0; i < ts.length; i++) {
    if (i > 0) r += Math.min(Math.max(0, ts[i]! - ts[i - 1]!) / s, maxGapMs)
    out.push(r)
  }
  return out
}

/** Sorted as the log reader sorts (time, then source, then file order), each ts moved to startMs + its replay offset. */
export function retime(events: readonly SwarmEvent[], speed: number, startMs: number, maxGapMs = MAX_GAP_MS): { events: SwarmEvent[]; offsets: number[]; logTs: number[] } {
  const sorted = events
    .map((event, index) => ({ event, index, time: Date.parse(event.ts) }))
    .filter(x => !Number.isNaN(x.time))
    .sort((a, b) => a.time - b.time || (SOURCE_ORDER[a.event.src] ?? 9) - (SOURCE_ORDER[b.event.src] ?? 9) || a.index - b.index)
  const start = Number.isFinite(startMs) ? startMs : 0
  const logTs = sorted.map(x => x.time)
  const offsets = replayOffsets(logTs, speed, maxGapMs)
  return { events: sorted.map((x, i) => ({ ...x.event, ts: new Date(start + offsets[i]!).toISOString() }) as SwarmEvent), offsets, logTs }
}

/** The log time a replay offset stands for: interpolated between events, so a cut gap runs its log time faster. */
export function logTimeAt(logTs: readonly number[], offsets: readonly number[], r: number): number {
  if (logTs.length === 0) return 0
  if (r <= offsets[0]!) return logTs[0]!
  let lo = 0
  let hi = offsets.length - 1
  if (r >= offsets[hi]!) return logTs[hi]!
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (offsets[mid]! <= r) lo = mid
    else hi = mid
  }
  const span = offsets[hi]! - offsets[lo]!
  return span <= 0 ? logTs[hi]! : logTs[lo]! + ((r - offsets[lo]!) / span) * (logTs[hi]! - logTs[lo]!)
}

/** The slowest speed, not below minSpeed, at which the replay lasts at most targetMs. Duration falls as speed rises. */
export function fitSpeed(ts: readonly number[], targetMs: number, minSpeed: number, maxGapMs = MAX_GAP_MS): number {
  const floor = usable(minSpeed, MIN_SPEED)
  const end = (s: number) => replayOffsets(ts, s, maxGapMs).at(-1) ?? 0
  if (end(floor) <= targetMs) return floor
  let lo = floor
  let hi = floor
  while (end(hi) > targetMs && hi < 1e9) hi *= 2
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2
    if (end(mid) <= targetMs) hi = mid
    else lo = mid
  }
  return hi
}
