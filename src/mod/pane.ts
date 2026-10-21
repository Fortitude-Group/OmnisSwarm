/**
 * The swarm pane. /omnis pane (or /omnis-swarm:watch) opens it. While it is placed and shown it pulls omnis_feed at
 * most 4 times a second, folds what arrives and draws render()'s frame: two Rasters with a row of pin chips on the
 * terminal, an Svg of the same cells elsewhere. Informational only: nothing here prompts, runs a tool other than
 * omnis_feed, or writes to the swarm. The chips change only what the pane shows.
 */
import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, On, PluginOptions, RenderElement, Timer } from 'claude-code'
import type { SwarmState } from '../core/fold.ts'
import { hex } from '../render/color.ts'
import { budgetFps, frameInterval, render, smoothRenderMs } from '../render/frame.ts'
import { sameCells, type Grid } from '../render/grid.ts'
import { chooseSpotlight } from '../render/spotlight.ts'
import { CELL_W, SVG_SOURCE_MAX, gridToSvg } from '../render/svg.ts'
import { FPS, GLYPH } from '../render/tokens.ts'
import type { Frame, Size, Spot, Tween, View } from '../render/types.ts'
import { emptyModel, prunePulses } from './pane-model.ts'
import { PANE_ID, periodFailed, resume, startPulling, wake, type PaneHooks, type PullHost, type PullState } from './pane-pull.ts'
import { connectServer } from './server.ts'

export { PANE_ID }
const SWARM_INIT_TOOL = 'mcp__plugin_omnis-swarm_omnis-swarm__omnis_swarm_init'
/** The built-in tool that spawns an agent: with panel auto, a spawn opens the pane as a new swarm does. */
const AGENT_TOOL = 'Agent'
const pinnedAtom = atom({ plugin: 'omnis-swarm', key: 'panePinned' } as const, null)

type Panel = 'command' | 'auto' | 'off'
type Kit = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>
type BlitArgs = Parameters<EngineInterface['ui']['blit']>[0]

/**
 * What the timers and blits need from the engine. The engine refuses a module that keeps `$` itself, so session.start
 * binds this from its `$` (as RuFlo's pane does) and the module keeps the closures.
 */
type Host = PullHost & { blit: (args: BlitArgs) => Promise<void> }

/** Binds a Host from `$`, each member spelled `$.noun.event(...)`. A refused redraw is not a crashed timer; a refused blit rejects, for blitFrame to see. */
function hostOf($: EngineInterface): Host {
  return {
    every: (ms, fn) => $.clock.every(ms, fn),
    after: (ms, fn) => $.clock.after(ms, fn),
    invalidate: () => {
      try {
        $.ui.invalidate('ui.render')
      } catch {
        // A refused redraw leaves the last frame on screen.
      }
    },
    blit: args => {
      try {
        return $.ui.blit(args).then(() => undefined)
      } catch (err) {
        return Promise.reject(err)
      }
    },
    panes: () => $.ui.panes(),
    connect: () => connectServer($),
    call: (server, tool, args) => $.mcp.call(server, tool, args),
  }
}

type Runtime = PullState & {
  panel: Panel
  host: Host | null
  closedByPerson: boolean
  /**
   * The frame loop and its period; how long the last frame took to draw and hand over on any path (it spaces the next
   * frame), and the moving average of that (it sets the motion cap).
   */
  frameTimer: Timer | null; frameMs: number; renderMs: number; renderAvgMs: number
  /** Off the terminal: when the pane last asked for a redraw, and the redraw held back by the budget, if one is. */
  drawnAt: number; redrawWait: Timer | null
  spot: Spot | null
  tween: Tween | null
  pinned: string | null
  surface: string | null
  size: Size | null
  last: Frame | null
  /**
   * The grid each Raster shows now, as mounted or last blitted. A blit of another size is refused, so none is sent;
   * one with the same cells would change nothing, so none is sent either.
   */
  onScreen: { top: Grid | null; bottom: Grid | null }
  /** Per Raster: the last blit sent, and whether the engine refused it, so the next frame sends its cells again. */
  blitId: { top: number; bottom: number }; refused: { top: boolean; bottom: boolean }
}

const panelOf = (x: unknown): Panel => (x === 'auto' || x === 'off' ? x : 'command')
const fresh = (panel: Panel): Runtime => ({
  panel, host: null, open: false, shown: false, closedByPerson: false, server: null, model: emptyModel(), pulling: false, pullSeq: 0, stalledMs: 0, stallMarked: false,
  pullTimer: null, pullMs: 0, connectWait: null, connectBackoffMs: 0, quiet: 0, unreadableMs: 0,
  frameTimer: null, frameMs: 0, renderMs: 0, renderAvgMs: 0, drawnAt: 0, redrawWait: null, spot: null, tween: null, pinned: null, surface: null, size: null, last: null,
  onScreen: { top: null, bottom: null }, blitId: { top: 0, bottom: 0 }, refused: { top: false, bottom: false },
})

/** Module state. A hot reload starts it over and the pane pulls a fresh state within one PULL_MS; the pin is in $.state. */
let rt: Runtime = fresh('command')

/** The Svg source for a grid off the terminal, or null for the summary as text: no Svg on the surface, or one too big to send. */
export const svgSource = (grid: Grid, alt: string, canDraw: boolean, max = SVG_SOURCE_MAX): string | null => (canDraw ? gridToSvg(grid, alt, max) : null)

const sizeKey = (g: Grid): string => `${g.columns}x${g.rows}`
/** The pin counts only while its agent is in the state; a pin on an agent that has gone is no pin. */
const pinOf = (state: SwarmState): string | null => (rt.pinned !== null && Object.hasOwn(state.agents, rt.pinned) ? rt.pinned : null)
const viewOf = (pinned: string | null): View => ({ pinned, spotlight: rt.spot, pulses: rt.model.pulses, lagMs: rt.model.lagMs, tween: rt.tween })
const waitingText = (): string =>
  rt.model.degraded !== null
    ? '⚠ Waiting for the swarm…'
    : rt.model.swarm === null ? 'No swarm yet. One starts with the first agent, or with omnis_swarm_init.' : 'Reading the swarm…'

/** The frame at `now` under the budget cap, after choosing the spotlight. Starts a glide when the nodes changed. Null until there is a state and a size. */
function frameAt(now: number): Frame | null {
  const state = rt.model.state
  if (state === null || rt.size === null) return null
  rt.model = { ...rt.model, pulses: prunePulses(rt.model.pulses, now) }
  const pinned = pinOf(state)
  rt.spot = chooseSpotlight(rt.spot, pinned, state, rt.model.pulses, now)
  const { degraded, degradedAgents, hiddenFinished } = rt.model
  const frame = render(state, viewOf(pinned), now, rt.size, { degraded, degradedAgents, hiddenFinished }, budgetFps(rt.renderAvgMs))
  if (rt.last !== null && frame.nodesKey !== rt.last.nodesKey) rt.tween = { from: rt.last.positions, at: now }
  return frame
}

/** A frame's time to draw and hand over: it spaces the next frame, and moves the average the motion cap follows. */
function spent(ms: number): void {
  rt.renderMs = ms
  rt.renderAvgMs = smoothRenderMs(rt.renderAvgMs, ms)
}

/** Sends each grid whose cells differ from what its Raster shows, or whose last blit the engine refused. */
function blitFrame(host: Host, frame: Frame): void {
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
function mounted(top: Grid | null, bottom: Grid | null): void {
  rt.onScreen = { top, bottom }
  rt.refused = { top: false, bottom: false }
}

/**
 * Asks for a redraw. Off the terminal each one renders the whole Svg, so they are held to the budget: no sooner than
 * frameInterval(FPS.tick, renderMs) after the last, with one held back until then so the latest news still lands.
 */
function redraw(host: Host): void {
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

function stopFrames(): void {
  rt.frameTimer?.cancel()
  rt.frameTimer = null
  rt.frameMs = 0
}

/** Runs the frame loop at `fps`, held to the render budget; stops it at 0, when closed, or off the terminal. */
function animate(host: Host, fps: number): void {
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
function tick(host: Host): void {
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
  } catch {
    periodFailed(rt, host, stopFrames)
  }
}

/** After news: blit when the element tree still fits, otherwise ask for a redraw. */
function show(host: Host, now: number): void {
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
}

function stopAll(): void {
  rt.pullTimer?.cancel()
  rt.pullTimer = null
  rt.pullMs = 0
  rt.connectWait?.cancel()
  rt.connectWait = null
  rt.redrawWait?.cancel()
  rt.redrawWait = null
  stopFrames()
}

function closed(byPerson: boolean): void {
  rt.open = false
  rt.shown = false
  rt.closedByPerson = rt.closedByPerson || byPerson
  stopAll()
  rt.last = null
  mounted(null, null)
}

/** What the pulls (pane-pull.ts) see of the pane. */
const hooks: PaneHooks<Host> = {
  state: () => rt,
  host: () => rt.host,
  closed: () => closed(false),
  hidden: stopFrames,
  show,
  swarmChanged: () => {
    rt.spot = null
    rt.tween = null
    rt.last = null
  },
}

async function openPane($: EngineInterface): Promise<{ isPlaced: boolean; reason: string }> {
  try {
    const result = await $.ui.open({ id: PANE_ID, title: 'Swarm' })
    rt.closedByPerson = false
    rt.open = true
    startPulling(hooks, rt.host ?? hostOf($))
    return result.isPlaced ? { isPlaced: true, reason: '' } : { isPlaced: false, reason: result.reason }
  } catch (err) {
    return { isPlaced: false, reason: err instanceof Error ? err.message.slice(0, 160) : 'the pane could not be opened' }
  }
}

async function paneCommand($: EngineInterface, arg: string): Promise<string> {
  if (arg === 'close') {
    await $.ui.close({ id: PANE_ID }).catch(() => undefined)
    closed(true)
    return 'Swarm pane closed.'
  }
  if (rt.panel === 'off') return 'The swarm pane is off (the panel setting). Set it to command or auto in /config to use it.'
  const opened = await openPane($)
  return opened.isPlaced ? 'Swarm pane open.' : `The swarm pane is waiting to be shown: ${opened.reason}`
}

/** True while an auto-open is in flight, so tool calls in quick succession open the pane once. */
let autoOpening = false

/** Run in the background by its hook, started before next(e) and never awaited: a tool call never waits on ui.open. */
async function maybeAutoOpen($: EngineInterface): Promise<void> {
  if (rt.panel !== 'auto' || rt.open || rt.closedByPerson || autoOpening) return
  autoOpening = true
  try {
    await openPane($)
  } finally {
    autoOpening = false
  }
}

/** What a command answers when its hook fails: the session goes on, and the markdown fallback is not sent to the model. */
const COMMAND_FAILED = { text: 'The swarm pane could not be opened.' }

async function togglePin($: EngineInterface, id: string): Promise<void> {
  await update($, pinnedAtom, current => (current === id ? null : id))
}

/** The chip row: one plain Button per agent, as many as fit, then "+n". Pressing one pins it; pressing it again unpins. */
function chipRow($: EngineInterface, kit: Kit, frame: Frame, columns: number): RenderElement[] {
  if (frame.chips.length === 0) return []
  const shown: typeof frame.chips = []
  let width = 0
  for (const chip of frame.chips) {
    const w = [...chip.label].length + 4
    if (shown.length > 0 && width + w > columns - 4) break
    shown.push(chip)
    width += w
  }
  const buttons = shown.map(chip => kit.Button({
    key: `pin:${chip.id}`,
    plain: true,
    ...(chip.pinned && { variant: 'primary' as const }),
    onPress: () => {
      void togglePin($, chip.id)
      if (rt.host !== null) wake(hooks, rt.host)
    },
    children: [kit.Text({ color: hex(chip.color), children: chip.pinned ? GLYPH.pinned : GLYPH.dot }), ` ${chip.label}`],
  }))
  const more = frame.chips.length - shown.length
  return [kit.Box({ key: 'chips', flexDirection: 'row', gap: 2, children: [...buttons, ...(more > 0 ? [kit.Text({ dimColor: true, children: `+${more}` })] : [])] })]
}

export function registerPane(on: On, options: PluginOptions): void {
  rt = fresh(panelOf(options.panel))
  autoOpening = false

  // Matched: the recorder holds the plugin's one unmatched session.start, and only a session with a person at the prompt can show a pane.
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const result = await next(e)
    // A new session.start rebinds: the timers of the last one stop, and restart on this one's host if the pane is open.
    stopAll()
    const host = hostOf($)
    rt.host = host
    // Neither is awaited: the session starts whether or not they ever answer.
    void $.command.register({
      name: 'omnis',
      description: 'OmnisSwarm: /omnis pane shows the live swarm pane, /omnis pane close hides it',
      argumentHint: 'pane [close]',
      immediate: true,
    }).catch(() => undefined)
    void resume(hooks, host).catch(() => undefined)
    return result
  })

  on('command.run', { command: 'omnis' }, async ($, e) => {
    const [sub = '', arg = ''] = e.args.trim().toLowerCase().split(/\s+/)
    if (sub !== 'pane') return { text: 'Usage: /omnis pane, or /omnis pane close.' }
    return { text: await paneCommand($, arg) }
  }).catch(() => COMMAND_FAILED)

  on('command.run', { command: 'omnis-swarm:watch' }, async $ => ({ text: await paneCommand($, '') })).catch(() => COMMAND_FAILED)

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    rt.pinned = await read($, pinnedAtom)
    rt.surface = e.surface
    rt.open = true
    rt.shown = true
    rt.size = {
      columns: Math.max(1, Math.floor(Number(e.props.bodyColumns) || 1)),
      rows: Math.max(1, Math.floor(Number(e.props.scroll.bodyRows) || 1)),
    }
    if (rt.host !== null) {
      startPulling(hooks, rt.host)
      // A re-render (a resize, or shown again) means someone is looking: pull at full speed.
      wake(hooks, rt.host)
    }
    const started = Date.now()
    const frame = frameAt(started)
    rt.last = frame
    if (e.surface === 'terminal') {
      const { Box, Text, Button, Raster } = $.ui.resolve(e)
      if (frame === null) {
        mounted(null, null)
        return Text({ dimColor: true, children: waitingText() })
      }
      mounted(frame.top, frame.bottom)
      const tree = Box({
        flexDirection: 'column',
        children: [
          Raster(frame.top.toRaster('top')),
          ...chipRow($, { Box, Text, Button }, frame, rt.size.columns),
          ...(frame.bottom === null ? [] : [Raster(frame.bottom.toRaster('bottom'))]),
        ],
      })
      spent(Date.now() - started)
      if (rt.host !== null) animate(rt.host, frame.fps)
      return tree
    }
    const { Box, Text, Button, Svg } = $.ui.resolve(e)
    mounted(null, null)
    stopFrames()
    rt.drawnAt = started
    if (frame === null) return Text({ dimColor: true, children: waitingText() })
    const picture = (grid: Grid, key: string): RenderElement => {
      const source = svgSource(grid, frame.alt, typeof Svg === 'function')
      return source === null ? Text({ children: frame.alt }) : Box({ key: `svg-${key}`, children: [Svg({ source, alt: frame.alt, width: grid.columns * CELL_W })] })
    }
    const tree = Box({
      flexDirection: 'column',
      children: [picture(frame.top, 'top'), ...chipRow($, { Box, Text, Button }, frame, rt.size.columns), ...(frame.bottom === null ? [] : [picture(frame.bottom, 'bottom')])],
    })
    // The Svg's frame and source count against the budget too: they space the redraws that news asks for.
    spent(Date.now() - started)
    return tree
  })

  on('ui.close', async ($, e, next) => {
    const result = await next(e)
    if (e.id === PANE_ID) closed(e.origin.kind === 'person')
    return result
  }).catch((_$, e, next) => next(e))

  // With panel auto, a new swarm or a spawned agent (an Agent tool call) opens the pane.
  on('tool.call', { tool: [SWARM_INIT_TOOL, AGENT_TOOL] }, async ($, e, next) => {
    // Started first and not awaited: the pane opens as the agent spawns, and the tool call never waits on it.
    void maybeAutoOpen($).catch(() => {})
    return next(e)
  }).catch((_$, e, next) => next(e)) // next is replay-safe here: once the hook has called it, it returns that result without running the tool again.
}
