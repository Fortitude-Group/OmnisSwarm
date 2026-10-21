/**
 * The swarm pane's pulls: omnis_feed at most 4 times a second while the pane is shown, once every 1.5 s while the
 * swarm is quiet, backing off while replies are unreadable; a look at $.ui.panes() about once a second while it is
 * hidden, connect retries that back off, and a pull that never settles flagged and then given up on. Each pull runs
 * the user's PreToolUse command hooks, so an idle pane must not pull 4 times a second. It works on the narrow
 * PullState the pane hands it and tells the pane what changed through PaneHooks.
 */
import type { EngineInterface, Timer } from 'claude-code'
import { parseFeedReply } from '../core/feed-reply.ts'
import { FEED_TOOL } from '../core/recording.ts'
import { PULL_MS } from '../render/tokens.ts'
import { applyReply, feedArgs, markDegraded, type PaneModel } from './pane-model.ts'

export const PANE_ID = 'omnis-swarm'
/** While the pane is hidden it only looks at $.ui.panes(), this often. */
const HIDDEN_PULL_MS = 1_000
/** After this many replies in a row with no news, a shown pane pulls every IDLE_PULL_MS until news or a wake. */
const IDLE_AFTER = 8
const IDLE_PULL_MS = 1_500
/** While replies are unreadable the period doubles from PULL_MS up to this; a readable reply resets it. */
const UNREADABLE_MAX_MS = 5_000
/** After a failed connect, the wait before the next try: from the first, doubling to the last; reset by a success. */
const CONNECT_RETRY_MS = 5_000
const CONNECT_RETRY_MAX_MS = 60_000
/** A pull still unsettled after STALL_MS marks the pane degraded; after STALL_GIVE_UP_MS a new pull may start. */
const STALL_MS = 5_000
const STALL_GIVE_UP_MS = 30_000

export type CallResult = Awaited<ReturnType<EngineInterface['mcp']['call']>>
export type PaneInfo = { id: string; isPlaced: boolean; isShown: boolean }

/** What the pulls need from the engine. */
export type PullHost = {
  every: (ms: number, fn: () => void) => Timer
  after: (ms: number, fn: () => void) => Timer
  invalidate: () => void
  panes: () => Promise<readonly PaneInfo[]>
  connect: () => Promise<string | null>
  call: (server: string, tool: string, args: Record<string, unknown>) => Promise<CallResult>
}

/** The part of the pane's state the pulls read and write. */
export type PullState = {
  open: boolean
  /** Whether the last look at $.ui.panes() found the pane placed and shown; the frame loop runs only while it is. */
  shown: boolean
  server: string | null
  model: PaneModel
  pulling: boolean
  /** Bumped by each pull and by giving up on one; a pull whose number is stale drops its answer. */
  pullSeq: number
  /** How long the pull in flight has run, counted in pull-timer periods; and whether that has marked the pane degraded. */
  stalledMs: number; stallMarked: boolean
  pullTimer: Timer | null; pullMs: number
  /** Connect retries: no try while a backoff wait runs; the next wait doubles after each failure. */
  connectWait: Timer | null; connectBackoffMs: number
  /** Replies in a row that brought no news; and the backed-off period while replies are unreadable (0 when they are not). */
  quiet: number; unreadableMs: number
}

/** How the pulls reach the rest of the pane, whose host may carry more than the pulls use. */
export type PaneHooks<H extends PullHost = PullHost> = {
  /** The pane's state now, read at each call: a hot reload replaces it. */
  state: () => PullState
  /** The host session.start bound last; a resume from an older one stops. */
  host: () => H | null
  /** The pane is no longer in the layout. */
  closed: () => void
  /** The pane is placed but hidden: stop the frame loop. */
  hidden: () => void
  /** Draw what arrived (or the degraded note) at `now`. */
  show: (host: H, now: number) => void
  /** A different swarm arrived: forget the spotlight, the glide and the last frame. */
  swarmChanged: () => void
}

/** A failed read: keep the last good state, flag it, and show the note. */
export function degrade<H extends PullHost>(pane: PaneHooks<H>, host: H): void {
  const s = pane.state()
  const now = Date.now()
  const applied = applyReply(s.model, null, now)
  s.model = applied.model
  if (applied.changed) pane.show(host, now)
}

/** No server: wait CONNECT_RETRY_MS before the next try, doubling each time up to CONNECT_RETRY_MAX_MS. */
export function connectFailed<H extends PullHost>(pane: PaneHooks<H>, host: H): void {
  const s = pane.state()
  s.connectBackoffMs = s.connectBackoffMs === 0 ? CONNECT_RETRY_MS : Math.min(CONNECT_RETRY_MAX_MS, s.connectBackoffMs * 2)
  s.connectWait?.cancel()
  s.connectWait = host.after(s.connectBackoffMs, () => {
    pane.state().connectWait = null
  })
}

/** The period while the pane is shown: backed off while replies are unreadable, slower once the swarm is quiet. */
export const shownPullMs = (s: PullState): number => (s.unreadableMs > 0 ? s.unreadableMs : s.quiet >= IDLE_AFTER ? IDLE_PULL_MS : PULL_MS)

/**
 * A timer period threw: stop that timer with `stop` so whatever starts it can start it again, keep the last good state
 * flagged, and ask for a redraw, which restarts the loops (ui.render calls startPulling and animate).
 */
export function periodFailed(s: PullState, host: PullHost, stop: () => void): void {
  try {
    stop()
    s.model = markDegraded(s.model, 'unreadable').model
    host.invalidate()
  } catch {
    // Nothing more to do: the next ui.render starts over.
  }
}

/** Something other than a reply happened (a re-render, a resize, a pin press): pull at full speed again. */
export function wake<H extends PullHost>(pane: PaneHooks<H>, host: H): void {
  const s = pane.state()
  s.quiet = 0
  if (s.pullTimer !== null && s.shown) pullEvery(pane, host, shownPullMs(s))
}

/** Pull every `ms`; the timer is replaced only when the period changes. */
export function pullEvery<H extends PullHost>(pane: PaneHooks<H>, host: H, ms: number): void {
  const s = pane.state()
  if (s.pullTimer !== null && s.pullMs === ms) return
  s.pullTimer?.cancel()
  s.pullMs = ms
  s.pullTimer = host.every(ms, () => pullTick(pane, host))
}

/**
 * One pull-timer period: a new pull, or, while one is in flight, the count towards marking it stalled and giving up
 * on it. Giving up also drops the server and backs off before connecting again, so a hung server never has another
 * call stacked on it every STALL_GIVE_UP_MS.
 */
export function pullTick<H extends PullHost>(pane: PaneHooks<H>, host: H): void {
  const s = pane.state()
  try {
    if (!s.pulling) {
      void pull(pane, host)
      return
    }
    s.stalledMs += s.pullMs
    if (s.stalledMs >= STALL_GIVE_UP_MS) {
      s.pulling = false
      s.pullSeq++
      s.server = null
      connectFailed(pane, host)
    } else if (s.stalledMs >= STALL_MS && !s.stallMarked) {
      s.stallMarked = true
      degrade(pane, host)
    }
  } catch {
    periodFailed(s, host, () => {
      s.pullTimer?.cancel()
      s.pullTimer = null
      s.pullMs = 0
    })
  }
}

export async function pull<H extends PullHost>(pane: PaneHooks<H>, host: H): Promise<void> {
  const s = pane.state()
  if (s.pulling || !s.open) return
  s.pulling = true
  s.stalledMs = 0
  s.stallMarked = false
  const seq = ++s.pullSeq
  const current = (): boolean => seq === pane.state().pullSeq && pane.state().open
  try {
    const me = (await host.panes()).find(p => p.id === PANE_ID)
    if (!current()) return
    if (me === undefined) {
      pane.closed()
      return
    }
    if (!me.isPlaced || !me.isShown) {
      // Hidden: no frames, no server calls, and a look at the panes about once a second.
      pane.state().shown = false
      pane.hidden()
      pullEvery(pane, host, HIDDEN_PULL_MS)
      return
    }
    // Shown again after being hidden: pull at full speed and redraw, which restarts the frame loop from ui.render.
    if (!pane.state().shown) {
      pane.state().shown = true
      pane.state().quiet = 0
      host.invalidate()
    }
    pullEvery(pane, host, shownPullMs(pane.state()))
    if (pane.state().server === null) {
      if (pane.state().connectWait !== null) return
      const server = await host.connect().catch(() => null)
      if (!current()) return
      if (server === null) {
        connectFailed(pane, host)
        degrade(pane, host)
        return
      }
      pane.state().server = server
      pane.state().connectBackoffMs = 0
    }
    let result: CallResult
    try {
      result = await host.call(pane.state().server!, FEED_TOOL, feedArgs(pane.state().model))
    } catch {
      // The call failed outright (the server may have gone): flag it, and connect again on the next pull.
      if (!current()) return
      pane.state().server = null
      degrade(pane, host)
      return
    }
    if (!current()) return
    const block = result.content[0]
    // An error, or text that will not parse (such as the notice that a reply too big for the MCP output cap went to a
    // file), is a failed read: applyReply(null) keeps the last good state and flags it.
    const reply = !result.isError && block !== undefined && block.type === 'text' && typeof block.text === 'string' ? parseFeedReply(block.text) : null
    const now = Date.now()
    const st = pane.state()
    const applied = applyReply(st.model, reply, now)
    st.model = applied.model
    // The period for the next pull: back off while unreadable, slow down once quiet, full speed on news.
    st.unreadableMs = reply === null ? Math.min(UNREADABLE_MAX_MS, Math.max(PULL_MS, st.unreadableMs) * 2) : 0
    st.quiet = applied.changed || applied.swarmChanged ? 0 : st.quiet + 1
    pullEvery(pane, host, shownPullMs(st))
    if (applied.swarmChanged) pane.swarmChanged()
    if (applied.changed || applied.swarmChanged) pane.show(host, now)
  } catch {
    // A failed pull shows less and changes nothing else; the next tick tries again.
  } finally {
    if (seq === pane.state().pullSeq) pane.state().pulling = false
  }
}

export function startPulling<H extends PullHost>(pane: PaneHooks<H>, host: H): void {
  if (pane.state().pullTimer !== null) return
  pullEvery(pane, host, PULL_MS)
  void pull(pane, host)
}

/** After a hot reload the pane is still open: keep it pulling (unless a later session.start has rebound the host). */
export async function resume<H extends PullHost>(pane: PaneHooks<H>, host: H): Promise<void> {
  if ((await host.panes()).some(p => p.id === PANE_ID) && host === pane.host()) {
    pane.state().open = true
    startPulling(pane, host)
  }
}
