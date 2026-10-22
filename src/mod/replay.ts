/**
 * /omnis replay (spec section 3): loads a recorded swarm through omnis_replay, re-times it onto the replay clock and
 * plays it into the pane's own model, so the unchanged renderer animates it as it does live. Mod-safe.
 */
import type { SwarmEvent } from '../core/events.ts'
import { emptyState, fold } from '../core/fold.ts'
import { REPLAY_TOOL } from '../core/recording.ts'
import { logTimeAt, retime } from '../core/replay-clock.ts'
import { parseReplayReply, REPLAY_MAX_EVENTS } from '../core/replay-reply.ts'
import { emptyModel, markPulses, prunePulses, pulsesFrom } from './pane-model.ts'
import { closed, pauseLive, show, startLive, stopFrames } from './pane-draw.ts'
import { HIDDEN_PULL_MS, IDLE_PULL_MS, PANE_ID, type CallResult } from './pane-pull.ts'
import { rt, type Host, type ReplayRun } from './pane-runtime.ts'
import { PULL_MS } from '../render/tokens.ts'

export const REPLAY_TICK_MS = 100
/** Spec point 8: 40 pages of at most 500 events is the 20,000-event cap. */
const MAX_PAGES = 40
/** A page not answered in this long fails the command rather than leaving it hanging on a stuck server. */
export const REPLAY_CALL_MS = 15_000
const TOO_LONG = 'That swarm is too long to replay in the pane; try /omnis export gif.'

/** One omnis_replay call, raced against REPLAY_CALL_MS: the result, 'timeout', or 'failed' when the call rejected. */
function callPage(host: Host, server: string, args: Record<string, unknown>): Promise<CallResult | 'timeout' | 'failed'> {
  return new Promise(resolve => {
    const timer = host.after(REPLAY_CALL_MS, () => resolve('timeout'))
    host.call(server, REPLAY_TOOL, args).then(
      result => { timer.cancel(); resolve(result) },
      () => { timer.cancel(); resolve('failed') },
    )
  })
}

export async function loadReplay(host: Host, swarm: string | null): Promise<{ ok: true; swarm: string; events: SwarmEvent[] } | { ok: false; text: string }> {
  const server = rt.server ?? (await host.connect().catch(() => null))
  if (server === null) return { ok: false, text: 'The swarm server is not connected yet; try again in a moment.' }
  const events: SwarmEvent[] = []
  let since = 0
  let id = swarm
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await callPage(host, server, { since, ...(id !== null && { swarm: id }) })
    if (result === 'timeout') return { ok: false, text: 'The swarm server did not answer in time; try again in a moment.' }
    if (result === 'failed') return { ok: false, text: 'The swarm log could not be read for a replay.' }
    const block = result.content[0]
    const reply = !result.isError && block !== undefined && block.type === 'text' && typeof block.text === 'string' ? parseReplayReply(block.text) : null
    if (reply === null) return { ok: false, text: 'The swarm log could not be read for a replay.' }
    if (reply.kind === 'none') return { ok: false, text: reply.recent.length === 0 ? 'No recorded swarm here yet.' : `No swarm ${swarm ?? ''} here. Recent: ${reply.recent.join(', ')}.` }
    id = reply.swarm
    events.push(...reply.events)
    if (events.length > REPLAY_MAX_EVENTS) return { ok: false, text: TOO_LONG }
    if (reply.done) return { ok: true, swarm: reply.swarm, events }
    since = reply.offset
  }
  return { ok: false, text: TOO_LONG }
}

/** Stops the run on screen, if any, and forgets what was drawn from it. */
function endRun(): void {
  rt.replay?.timer?.cancel()
  rt.replay = null
  rt.spot = null
  rt.tween = null
  rt.last = null
  stopFrames()
}

export function startReplay(host: Host, swarm: string, events: readonly SwarmEvent[], speed: number): void {
  endRun()
  // The live pulls stop while the replay plays: their news would only be thrown away.
  pauseLive()
  const startMs = Date.now()
  const timed = retime(events, speed, startMs)
  rt.replay = {
    swarm, speed, events: timed.events, logTs: timed.logTs, offsets: timed.offsets, startMs, cursor: 0,
    model: { ...emptyModel(), swarm, state: emptyState(swarm) }, timer: host.every(REPLAY_TICK_MS, () => replayTick(host)), ended: false,
    looking: false, sinceLook: 0, lookMs: 0, drawnSecond: -1,
  }
  host.invalidate()
}

/**
 * With the live pulls paused, the replay looks at $.ui.panes() as they would: as often as a shown pane pulls, about
 * once a second while hidden. Gone ends the replay (the pane closed); hidden stops the drawing; shown again redraws.
 */
async function look(host: Host, run: ReplayRun): Promise<void> {
  try {
    const me = (await host.panes()).find(p => p.id === PANE_ID)
    if (rt.replay !== run) return
    if (me === undefined) closed(false)
    else if (!me.isPlaced || !me.isShown) {
      rt.shown = false
      stopFrames()
    } else if (!rt.shown) {
      rt.shown = true
      host.invalidate()
    }
    if (run.ended) lookEvery(host, run)
  } catch {
    // A failed look changes nothing; the next tick looks again.
  } finally {
    run.looking = false
  }
}

function startLook(host: Host, run: ReplayRun): void {
  if (run.looking) return
  run.looking = true
  run.sinceLook = 0
  void look(host, run)
}

/**
 * Once the replay has ended the tick is replaced by a look-only timer, as slow as an idle live pane's pulls while
 * shown and a hidden one's while hidden; it is re-armed only when that period changes.
 */
function lookEvery(host: Host, run: ReplayRun): void {
  const ms = rt.shown ? IDLE_PULL_MS : HIDDEN_PULL_MS
  if (run.lookMs === ms && run.timer !== null) return
  run.timer?.cancel()
  run.lookMs = ms
  run.timer = host.every(ms, () => {
    if (rt.replay === run) startLook(host, run)
  })
}

/**
 * Folds every event now due into the replay model. Draws while the pane is shown, and only when events landed, the
 * clock's second changed or the replay ended. At the end the final state stays and a look-only timer takes over.
 */
export function replayTick(host: Host): void {
  const run = rt.replay
  if (run === null || run.ended) return
  try {
    const now = Date.now()
    run.sinceLook += REPLAY_TICK_MS
    if (run.sinceLook >= (rt.shown ? PULL_MS : HIDDEN_PULL_MS)) startLook(host, run)
    const due: SwarmEvent[] = []
    while (run.cursor < run.events.length && Date.parse(run.events[run.cursor]!.ts) <= now) due.push(run.events[run.cursor++]!)
    if (due.length > 0) {
      const state = run.model.state!
      for (const e of due) fold(state, e)
      const marked = markPulses(pulsesFrom(due), run.model.lastFlicker)
      run.model = { ...run.model, pulses: prunePulses([...run.model.pulses, ...marked.pulses], now), lastFlicker: marked.lastFlicker }
    }
    const ending = run.cursor >= run.events.length
    if (ending) run.ended = true
    const second = Math.floor(replayClockMs(now) / 1000)
    if (rt.shown && (due.length > 0 || ending || second !== run.drawnSecond)) {
      run.drawnSecond = second
      show(host, now)
    }
    if (ending) {
      run.timer?.cancel()
      run.timer = null
      lookEvery(host, run)
    }
  } catch {
    stopReplay(host)
  }
}

/** The log clock the header shows: log time since the swarm's first event. */
export const replayClockMs = (now: number): number => {
  const run = rt.replay
  if (run === null || run.logTs.length === 0) return 0
  return logTimeAt(run.logTs, run.offsets, now - run.startMs) - run.logTs[0]!
}

/** The swarm's own length in log time (no gap cutting); 0 with no events. */
export const replayTotalMs = (): number => {
  const run = rt.replay
  if (run === null || run.logTs.length === 0) return 0
  return run.logTs.at(-1)! - run.logTs[0]!
}

/** Back to the live swarm: the run stops, the live pulls start again while the pane is open, and the pane redraws. */
export function stopReplay(host: Host): void {
  endRun()
  if (rt.open) startLive(host)
  host.invalidate()
}
