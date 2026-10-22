/** Drawing the pane: the frame, its blits, the frame loop and the redraw budget, and opening the pane. */
import type { EngineInterface } from 'claude-code'
import type { SwarmState } from '../core/fold.ts'
import { budgetFps, frameInterval, render, smoothRenderMs } from '../render/frame.ts'
import { sameCells, type Grid } from '../render/grid.ts'
import { chooseSpotlight } from '../render/spotlight.ts'
import { SVG_SOURCE_MAX, gridToSvg } from '../render/svg.ts'
import { FPS } from '../render/tokens.ts'
import type { Frame, View } from '../render/types.ts'
import { viewBudget } from './budget-guard.ts'
import { prunePulses } from './pane-model.ts'
import { PANE_ID, periodFailed, startPulling, type PaneHooks } from './pane-pull.ts'
import { hostOf, rt, type Host } from './pane-runtime.ts'
import { replayClockMs, replayTotalMs } from './replay.ts'

/** The Svg source for a grid off the terminal, or null for the summary as text: no Svg on the surface, or one too big to send. */
export const svgSource = (grid: Grid, alt: string, canDraw: boolean, max = SVG_SOURCE_MAX): string | null => (canDraw ? gridToSvg(grid, alt, max) : null)

export const sizeKey = (g: Grid): string => `${g.columns}x${g.rows}`
/** The pin counts only while its agent is in the state; a pin on an agent that has gone is no pin. */
export const pinOf = (state: SwarmState): string | null => (rt.pinned !== null && Object.hasOwn(state.agents, rt.pinned) ? rt.pinned : null)
/** The model on screen: the replay's while one plays, otherwise the live one. */
const shownModel = () => rt.replay?.model ?? rt.model
export const viewOf = (pinned: string | null): View => ({
  pinned, spotlight: rt.spot, pulses: shownModel().pulses, lagMs: shownModel().lagMs, tween: rt.tween, style: rt.style, still: rt.surface !== null && rt.surface !== 'terminal',
  budget: rt.replay === null ? viewBudget() : null,
})
export const waitingText = (): string =>
  rt.model.degraded !== null
    ? '⚠ Waiting for the swarm…'
    : rt.model.swarm === null ? 'No swarm yet. One starts with the first agent, or with omnis_swarm_init.' : 'Reading the swarm…'

/** The frame at `now` under the budget cap, after choosing the spotlight. Starts a glide when the nodes changed. Null until there is a state and a size. */
export function frameAt(now: number): Frame | null {
  const run = rt.replay
  const model = shownModel()
  const state = model.state
  if (state === null || rt.size === null) return null
  const pruned = { ...model, pulses: prunePulses(model.pulses, now) }
  if (run !== null) run.model = pruned
  else rt.model = pruned
  const pinned = pinOf(state)
  rt.spot = chooseSpotlight(rt.spot, pinned, state, pruned.pulses, now)
  const { degraded, degradedAgents, hiddenFinished } = pruned
  const replay = run === null ? null : { speed: run.speed, clockMs: replayClockMs(now), totalMs: replayTotalMs(), ended: run.ended }
  const frame = render(state, viewOf(pinned), now, rt.size, { degraded, degradedAgents, hiddenFinished, replay }, budgetFps(rt.renderAvgMs))
  if (rt.last !== null && frame.nodesKey !== rt.last.nodesKey) rt.tween = { from: rt.last.positions, at: now }
  return frame
}

/** A frame's time to draw and hand over: it spaces the next frame, and moves the average the motion cap follows. */
export function spent(ms: number): void {
  rt.renderMs = ms
  rt.renderAvgMs = smoothRenderMs(rt.renderAvgMs, ms)
}

/** Sends each grid whose cells differ from what its Raster shows, or whose last blit the engine refused. */
export function blitFrame(host: Host, frame: Frame): void {
  for (const key of ['top', 'bottom'] as const) {
    const grid = frame[key]
    const shown = rt.onScreen[key]
    if (grid === null || shown === null || sizeKey(shown) !== sizeKey(grid)) continue
    if (!rt.refused[key] && sameCells(shown, grid)) continue
    const id = ++rt.blitId[key]
    rt.onScreen[key] = grid
    rt.refused[key] = false
    const runtime = rt
    host.blit({ requestId: PANE_ID, key, cells: grid.encode(), columns: grid.columns, rows: grid.rows }).catch(() => {
      // Refused: the screen may still show older cells, so the next frame sends its own even if they match these.
      if (runtime.blitId[key] === id) runtime.refused[key] = true
    })
  }
}

/** What each Raster shows after a mount (nothing when there is none), with no blit refused. */
export function mounted(top: Grid | null, bottom: Grid | null): void {
  rt.onScreen = { top, bottom }
  rt.refused = { top: false, bottom: false }
}

/**
 * Asks for a redraw. Off the terminal each one renders the whole Svg, so they are held to the budget: no sooner than
 * frameInterval(FPS.tick, renderMs) after the last, with one held back until then so the latest news still lands.
 */
export function redraw(host: Host): void {
  if (rt.surface === null || rt.surface === 'terminal') {
    host.invalidate()
    return
  }
  if (rt.redrawWait !== null) return
  const wait = frameInterval(FPS.tick, rt.renderMs) - (Date.now() - rt.drawnAt)
  if (wait <= 0) {
    rt.drawnAt = Date.now()
    host.invalidate()
    return
  }
  rt.redrawWait = host.after(wait, () => {
    rt.redrawWait = null
    rt.drawnAt = Date.now()
    host.invalidate()
  })
}

export function stopFrames(): void {
  rt.frameTimer?.cancel()
  rt.frameTimer = null
  rt.frameMs = 0
  rt.wakeTimer?.cancel()
  rt.wakeTimer = null
}

/** Draws one frame at the frame's wakeAt, whatever the loop's rate: a blink is two frames, not a faster loop (pane.md 12.5). */
export function wakeFor(host: Host, frame: Frame): void {
  const at = frame.wakeAt
  if (at === undefined || !rt.open || !rt.shown || rt.surface !== 'terminal') {
    rt.wakeTimer?.cancel()
    rt.wakeTimer = null
    return
  }
  if (rt.wakeTimer !== null && rt.wakeAt === at) return
  rt.wakeTimer?.cancel()
  rt.wakeAt = at
  rt.wakeTimer = host.after(Math.max(1, Math.ceil(at - Date.now())), () => {
    rt.wakeTimer = null
    tick(host)
  })
}

/** Runs the frame loop at `fps`, held to the render budget; stops it at 0, when closed, or off the terminal. */
export function animate(host: Host, fps: number): void {
  if (fps <= 0 || !rt.open || !rt.shown || rt.surface !== 'terminal') {
    stopFrames()
    return
  }
  const interval = frameInterval(fps, rt.renderMs)
  if (rt.frameTimer !== null && interval === rt.frameMs) return
  rt.frameTimer?.cancel()
  rt.frameMs = interval
  rt.frameTimer = host.every(interval, () => tick(host))
}

/** One frame. A throw (a render that fails) stops the loop and flags the pane; the redraw it asks for starts it again. */
export function tick(host: Host): void {
  try {
    const started = Date.now()
    const frame = rt.open && rt.shown ? frameAt(started) : null
    if (frame === null || rt.last === null) {
      stopFrames()
      return
    }
    if (frame.treeKey !== rt.last.treeKey) {
      stopFrames()
      host.invalidate()
      return
    }
    blitFrame(host, frame)
    rt.last = frame
    spent(Date.now() - started)
    animate(host, frame.fps)
    wakeFor(host, frame)
  } catch {
    periodFailed(rt, host, stopFrames)
  }
}

/** After news: blit when the element tree still fits, otherwise ask for a redraw. */
export function show(host: Host, now: number): void {
  if (rt.surface !== null && rt.surface !== 'terminal') {
    // Off the terminal the news is drawn by the next ui.render, whenever the budget lets it come.
    redraw(host)
    return
  }
  const started = Date.now()
  const frame = frameAt(now)
  if (frame === null || rt.last === null || rt.surface !== 'terminal' || frame.treeKey !== rt.last.treeKey) {
    host.invalidate()
    return
  }
  blitFrame(host, frame)
  rt.last = frame
  spent(Date.now() - started)
  animate(host, frame.fps)
  wakeFor(host, frame)
}

/** Stops every timer the pane runs, a replay's included: no replay is left ticking on an older host. */
export function stopAll(): void {
  rt.replay?.timer?.cancel()
  rt.replay = null
  rt.pullTimer?.cancel()
  rt.pullTimer = null
  rt.pullMs = 0
  rt.connectWait?.cancel()
  rt.connectWait = null
  rt.redrawWait?.cancel()
  rt.redrawWait = null
  stopFrames()
}

export function closed(byPerson: boolean): void {
  rt.open = false
  rt.shown = false
  rt.closedByPerson = rt.closedByPerson || byPerson
  stopAll()
  rt.last = null
  mounted(null, null)
}

/** What the pulls (pane-pull.ts) see of the pane. */
export const hooks: PaneHooks<Host> = {
  state: () => rt,
  host: () => rt.host,
  closed: () => closed(false),
  hidden: stopFrames,
  // While a replay plays, live news is not drawn and does not touch what the replay shows.
  show: (host, now) => {
    if (rt.replay === null) show(host, now)
  },
  paused: () => rt.replay !== null,
  swarmChanged: () => {
    if (rt.replay !== null) return
    rt.spot = null
    rt.tween = null
    rt.last = null
  },
}

/** The live pulls, started unless a replay plays (hooks.paused: they stop for it, and start again when it stops). */
export function startLive(host: Host): void {
  startPulling(hooks, host)
}

/** Stops the live pulls for a replay; a pull in flight drops its answer. */
export function pauseLive(): void {
  rt.pullTimer?.cancel()
  rt.pullTimer = null
  rt.pullMs = 0
  if (rt.pulling) {
    rt.pulling = false
    rt.pullSeq++
  }
}

export async function openPane($: EngineInterface): Promise<{ isPlaced: boolean; reason: string }> {
  try {
    const result = await $.ui.open({ id: PANE_ID, title: 'Swarm' })
    rt.closedByPerson = false
    rt.open = true
    startLive(rt.host ?? hostOf($))
    return result.isPlaced ? { isPlaced: true, reason: '' } : { isPlaced: false, reason: result.reason }
  } catch (err) {
    return { isPlaced: false, reason: err instanceof Error ? err.message.slice(0, 160) : 'the pane could not be opened' }
  }
}
