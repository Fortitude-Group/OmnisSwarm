/**
 * The swarm pane. /omnis pane (or /omnis-swarm:watch) opens it. While it is placed and shown it pulls omnis_feed at
 * most 4 times a second, folds what arrives and draws render()'s frame: two Rasters with a row of pin chips on the
 * terminal, an Svg of the same cells elsewhere. Informational only: nothing here prompts, runs a tool other than
 * omnis_feed, or writes to the swarm. The chips change only what the pane shows.
 */
import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, On, PluginOptions, RenderElement, Timer } from 'claude-code'
import { parseFeedReply } from '../core/feed-reply.ts'
import type { SwarmState } from '../core/fold.ts'
import { hex } from '../render/color.ts'
import { budgetFps, frameInterval, render } from '../render/frame.ts'
import type { Grid } from '../render/grid.ts'
import { chooseSpotlight } from '../render/spotlight.ts'
import { CELL_W, SVG_SOURCE_MAX, gridToSvg } from '../render/svg.ts'
import { GLYPH, PULL_MS } from '../render/tokens.ts'
import type { Frame, Size, Spot, Tween, View } from '../render/types.ts'
import { applyReply, emptyModel, feedArgs, prunePulses, type PaneModel } from './pane-model.ts'
import { connectServer } from './server.ts'

export const PANE_ID = 'omnis-swarm'
const FEED_TOOL = 'omnis_feed'
const SWARM_INIT_TOOL = 'mcp__plugin_omnis-swarm_omnis-swarm__omnis_swarm_init'
/** While the pane is hidden it only looks at $.ui.panes(), this often. */
const HIDDEN_PULL_MS = 1_000
/** After a failed connect, the wait before the next try: from the first, doubling to the last; reset by a success. */
const CONNECT_RETRY_MS = 5_000
const CONNECT_RETRY_MAX_MS = 60_000
/** A pull still unsettled after STALL_MS marks the pane degraded; after STALL_GIVE_UP_MS a new pull may start. */
const STALL_MS = 5_000
const STALL_GIVE_UP_MS = 30_000
/** The built-in tool that spawns an agent: with panel auto, a spawn opens the pane as a new swarm does. */
const AGENT_TOOL = 'Agent'
const pinnedAtom = atom({ plugin: 'omnis-swarm', key: 'panePinned' } as const, null)

type Panel = 'command' | 'auto' | 'off'
type Kit = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>
type BlitArgs = Parameters<EngineInterface['ui']['blit']>[0]
type CallResult = Awaited<ReturnType<EngineInterface['mcp']['call']>>
type PaneInfo = { id: string; isPlaced: boolean; isShown: boolean }

/**
 * What the timers and blits need from the engine. The engine refuses a module that keeps `$` itself, so session.start
 * binds this from its `$` (as RuFlo's pane does) and the module keeps the closures.
 */
type Host = {
  every: (ms: number, fn: () => void) => Timer
  after: (ms: number, fn: () => void) => Timer
  invalidate: () => void
  blit: (args: BlitArgs) => void
  panes: () => Promise<readonly PaneInfo[]>
  connect: () => Promise<string | null>
  call: (server: string, tool: string, args: Record<string, unknown>) => Promise<CallResult>
}

/** Binds a Host from `$`, each member spelled `$.noun.event(...)`. A refused redraw or blit is not a crashed timer. */
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
      void $.ui.blit(args).catch(() => undefined)
    },
    panes: () => $.ui.panes(),
    connect: () => connectServer($),
    call: (server, tool, args) => $.mcp.call(server, tool, args),
  }
}

type Runtime = {
  panel: Panel
  host: Host | null
  open: boolean
  /** Whether the last look at $.ui.panes() found the pane placed and shown; the frame loop runs only while it is. */
  shown: boolean
  closedByPerson: boolean
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
  /** The frame loop, its period, and how long the last frame took to draw and hand over on any path (it sets the budget cap). */
  frameTimer: Timer | null; frameMs: number; renderMs: number
  spot: Spot | null
  tween: Tween | null
  pinned: string | null
  surface: string | null
  size: Size | null
  last: Frame | null
  /** The size each Raster was last mounted at; a blit of any other size is refused, so none is sent. */
  mounted: { top: string | null; bottom: string | null }
}

const panelOf = (x: unknown): Panel => (x === 'auto' || x === 'off' ? x : 'command')
const fresh = (panel: Panel): Runtime => ({
  panel, host: null, open: false, shown: false, closedByPerson: false, server: null, model: emptyModel(), pulling: false, pullSeq: 0, stalledMs: 0, stallMarked: false,
  pullTimer: null, pullMs: 0, connectWait: null, connectBackoffMs: 0,
  frameTimer: null, frameMs: 0, renderMs: 0, spot: null, tween: null, pinned: null, surface: null, size: null, last: null,
  mounted: { top: null, bottom: null },
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
  const frame = render(state, viewOf(pinned), now, rt.size, { degraded, degradedAgents, hiddenFinished }, budgetFps(rt.renderMs))
  if (rt.last !== null && frame.nodesKey !== rt.last.nodesKey) rt.tween = { from: rt.last.positions, at: now }
  return frame
}

function blitFrame(host: Host, frame: Frame): void {
  const grids: Array<[string, Grid | null, string | null]> = [['top', frame.top, rt.mounted.top], ['bottom', frame.bottom, rt.mounted.bottom]]
  for (const [key, grid, mounted] of grids) {
    if (grid === null || mounted !== sizeKey(grid)) continue
    host.blit({ requestId: PANE_ID, key, cells: grid.encode(), columns: grid.columns, rows: grid.rows })
  }
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

function tick(host: Host): void {
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
  rt.renderMs = Date.now() - started
  animate(host, frame.fps)
}

/** After news: blit when the element tree still fits, otherwise ask for a redraw. */
function show(host: Host, now: number): void {
  const started = Date.now()
  const frame = frameAt(now)
  if (frame === null || rt.last === null || rt.surface !== 'terminal' || frame.treeKey !== rt.last.treeKey) {
    host.invalidate()
    return
  }
  blitFrame(host, frame)
  rt.last = frame
  rt.renderMs = Date.now() - started
  animate(host, frame.fps)
}

function stopAll(): void {
  rt.pullTimer?.cancel()
  rt.pullTimer = null
  rt.pullMs = 0
  rt.connectWait?.cancel()
  rt.connectWait = null
  stopFrames()
}

/** A failed read: keep the last good state, flag it, and show the note. */
function degrade(host: Host): void {
  const now = Date.now()
  const applied = applyReply(rt.model, null, now)
  rt.model = applied.model
  if (applied.changed) show(host, now)
}

/** No server: wait CONNECT_RETRY_MS before the next try, doubling each time up to CONNECT_RETRY_MAX_MS. */
function connectFailed(host: Host): void {
  rt.connectBackoffMs = rt.connectBackoffMs === 0 ? CONNECT_RETRY_MS : Math.min(CONNECT_RETRY_MAX_MS, rt.connectBackoffMs * 2)
  rt.connectWait?.cancel()
  rt.connectWait = host.after(rt.connectBackoffMs, () => {
    rt.connectWait = null
  })
}

/** Pull every `ms`; the timer is replaced only when the period changes. */
function pullEvery(host: Host, ms: number): void {
  if (rt.pullTimer !== null && rt.pullMs === ms) return
  rt.pullTimer?.cancel()
  rt.pullMs = ms
  rt.pullTimer = host.every(ms, () => pullTick(host))
}

/** One pull-timer period: a new pull, or, while one is in flight, the count towards marking it stalled and giving up on it. */
function pullTick(host: Host): void {
  if (!rt.pulling) {
    void pull(host)
    return
  }
  rt.stalledMs += rt.pullMs
  if (rt.stalledMs >= STALL_GIVE_UP_MS) {
    rt.pulling = false
    rt.pullSeq++
  } else if (rt.stalledMs >= STALL_MS && !rt.stallMarked) {
    rt.stallMarked = true
    degrade(host)
  }
}

function closed(byPerson: boolean): void {
  rt.open = false
  rt.shown = false
  rt.closedByPerson = rt.closedByPerson || byPerson
  stopAll()
  rt.last = null
  rt.mounted = { top: null, bottom: null }
}

async function pull(host: Host): Promise<void> {
  if (rt.pulling || !rt.open) return
  rt.pulling = true
  rt.stalledMs = 0
  rt.stallMarked = false
  const seq = ++rt.pullSeq
  const current = (): boolean => seq === rt.pullSeq && rt.open
  try {
    const me = (await host.panes()).find(p => p.id === PANE_ID)
    if (!current()) return
    if (me === undefined) {
      closed(false)
      return
    }
    if (!me.isPlaced || !me.isShown) {
      // Hidden: no frames, no server calls, and a look at the panes about once a second.
      rt.shown = false
      stopFrames()
      pullEvery(host, HIDDEN_PULL_MS)
      return
    }
    pullEvery(host, PULL_MS)
    // Shown again after being hidden: redraw, which restarts the frame loop from ui.render.
    if (!rt.shown) {
      rt.shown = true
      host.invalidate()
    }
    if (rt.server === null) {
      if (rt.connectWait !== null) return
      const server = await host.connect().catch(() => null)
      if (!current()) return
      if (server === null) {
        connectFailed(host)
        degrade(host)
        return
      }
      rt.server = server
      rt.connectBackoffMs = 0
    }
    let result: CallResult
    try {
      result = await host.call(rt.server, FEED_TOOL, feedArgs(rt.model))
    } catch {
      // The call failed outright (the server may have gone): flag it, and connect again on the next pull.
      if (!current()) return
      rt.server = null
      degrade(host)
      return
    }
    if (!current()) return
    const block = result.content[0]
    // An error, or text that will not parse (such as the notice that a reply too big for the MCP output cap went to a
    // file), is a failed read: applyReply(null) keeps the last good state and flags it.
    const reply = !result.isError && block !== undefined && block.type === 'text' && typeof block.text === 'string' ? parseFeedReply(block.text) : null
    const now = Date.now()
    const applied = applyReply(rt.model, reply, now)
    rt.model = applied.model
    if (applied.swarmChanged) {
      rt.spot = null
      rt.tween = null
      rt.last = null
    }
    if (applied.changed || applied.swarmChanged) show(host, now)
  } catch {
    // A failed pull shows less and changes nothing else; the next tick tries again.
  } finally {
    if (seq === rt.pullSeq) rt.pulling = false
  }
}

/** After a hot reload the pane is still open: keep it pulling (unless a later session.start has rebound the host). */
async function resume(host: Host): Promise<void> {
  if ((await host.panes()).some(p => p.id === PANE_ID) && host === rt.host) {
    rt.open = true
    startPulling(host)
  }
}

function startPulling(host: Host): void {
  if (rt.pullTimer !== null) return
  pullEvery(host, PULL_MS)
  void pull(host)
}

async function openPane($: EngineInterface): Promise<{ isPlaced: boolean; reason: string }> {
  try {
    const result = await $.ui.open({ id: PANE_ID, title: 'Swarm' })
    rt.closedByPerson = false
    rt.open = true
    startPulling(rt.host ?? hostOf($))
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
    void resume(host).catch(() => undefined)
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
    if (rt.host !== null) startPulling(rt.host)
    const started = Date.now()
    const frame = frameAt(started)
    rt.last = frame
    if (e.surface === 'terminal') {
      const { Box, Text, Button, Raster } = $.ui.resolve(e)
      if (frame === null) {
        rt.mounted = { top: null, bottom: null }
        return Text({ dimColor: true, children: waitingText() })
      }
      rt.mounted = { top: sizeKey(frame.top), bottom: frame.bottom === null ? null : sizeKey(frame.bottom) }
      const tree = Box({
        flexDirection: 'column',
        children: [
          Raster(frame.top.toRaster('top')),
          ...chipRow($, { Box, Text, Button }, frame, rt.size.columns),
          ...(frame.bottom === null ? [] : [Raster(frame.bottom.toRaster('bottom'))]),
        ],
      })
      rt.renderMs = Date.now() - started
      if (rt.host !== null) animate(rt.host, frame.fps)
      return tree
    }
    const { Box, Text, Button, Svg } = $.ui.resolve(e)
    rt.mounted = { top: null, bottom: null }
    stopFrames()
    if (frame === null) return Text({ dimColor: true, children: waitingText() })
    const picture = (grid: Grid, key: string): RenderElement => {
      const source = svgSource(grid, frame.alt, typeof Svg === 'function')
      return source === null ? Text({ children: frame.alt }) : Box({ key: `svg-${key}`, children: [Svg({ source, alt: frame.alt, width: grid.columns * CELL_W })] })
    }
    return Box({
      flexDirection: 'column',
      children: [picture(frame.top, 'top'), ...chipRow($, { Box, Text, Button }, frame, rt.size.columns), ...(frame.bottom === null ? [] : [picture(frame.bottom, 'bottom')])],
    })
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
