/**
 * The stub engine and MCP server the pane's kit tests run against, with their helpers. Not a *.test.ts file, so the
 * kit does not run it as a test; it is test support only, and phase 4 leaves it out of the shipped plugin.
 */
import { mock, type MockClock, type TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'
import { foldAll } from '../core/fold.ts'
import { decodeCells, gridText } from '../render/grid.ts'
import { FIVE_AT, FIVE_SWARM, fiveAgentEvents } from '../../tests/fixtures/swarm-five.ts'

export const SERVER = 'plugin:omnis-swarm:omnis-swarm'
export const INIT = 'mcp__plugin_omnis-swarm_omnis-swarm__omnis_swarm_init'
export const PANE = {
  plugin: 'omnis-swarm',
  component: 'Pane',
  requestId: 'omnis-swarm',
  props: { title: 'Swarm', isFocused: false, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 44 }, view: {} },
} as const
export const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const

export type Feed = 'ok' | 'quiet' | 'error' | 'garbage' | 'late' | 'throw'
/**
 * What the stub saw, and its switches: `shown` (the pane placed but hidden when false), `feed` (how omnis_feed answers:
 * 'ok' a whole state every time, which counts as news; 'quiet' the state for a first pull, then nothing new), `connectOk`.
 */
export type Seen = {
  calls: Array<{ tool: string; args: Record<string, unknown> }>
  opens: number
  blits: number
  invalidates: number
  panes: number
  connects: number
  shown: boolean
  feed: Feed
  connectOk: boolean
  /** How a 'late' feed waits before it answers (a test's clock.sleep: the kit's clock does not wait on it). */
  late: () => Promise<void>
  /** The kit draws a mount's tree but never paints a blit: the last top blit, and when it and the last redraw came (by count). */
  topBlit: { cells: string; columns: number; rows: number; at: number } | null
  /** Blits that carried exactly the cells the last blit of the same Raster did. */
  repeats: number
  /** How many of the next blits the engine refuses; and every blit in order, refused or not, stamped from `seq`. */
  refuse: number
  blitLog: Array<{ key: string; cells: string; ok: boolean; at: number }>
  redrawnAt: number
  /** When (by count, as redrawnAt) omnis_feed last answered with news, and every such answer. */
  newsAt: number
  news: number[]
  seq: number
}
/** Faults beneath session.start: ui.panes or command.register that never answer. */
export type Faults = { panes?: 'hang'; register?: 'hang' }
export const never = <T>(): Promise<T> => new Promise<T>(() => {})

/** Stands in for the engine and the MCP server, which answers the five-agent swarm's folded state. `openAs` makes ui.open fail or hang. */
export function engine(on: On, openAs: 'ok' | 'throw' | 'hang' = 'ok', faults: Faults = {}): Seen {
  const seen: Seen = { calls: [], opens: 0, blits: 0, invalidates: 0, panes: 0, connects: 0, shown: true, feed: 'ok', connectOk: true,
    topBlit: null, repeats: 0, refuse: 0, blitLog: [], redrawnAt: 0, newsAt: 0, news: [], seq: 0, late: () => Promise.resolve() }
  const lastCells = new Map<string, string>()
  const state = foldAll(FIVE_SWARM, fiveAgentEvents())
  let open = false
  on('command.register', (_, e) => (faults.register === 'hang' ? never() : { value: { command: e.name } }))
  on('ui.open', () => {
    seen.opens++
    if (openAs === 'throw') throw new Error('no room for the pane')
    if (openAs === 'hang') return new Promise<never>(() => {})
    open = true
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    open = false
    return { value: undefined }
  })
  on('ui.panes', () => {
    seen.panes++
    if (faults.panes === 'hang') return never()
    return { value: open ? [{ id: 'omnis-swarm', title: 'Swarm', isShown: seen.shown, isFocused: false, isPlaced: true }] : [] }
  })
  on('ui.blit', (_, e) => {
    if (seen.refuse > 0 && 'cells' in e) {
      seen.refuse--
      seen.blitLog.push({ key: e.key, cells: String(e.cells), ok: false, at: ++seen.seq })
      throw new Error('blit refused')
    }
    if ('cells' in e) seen.blitLog.push({ key: e.key, cells: String(e.cells), ok: true, at: ++seen.seq })
    seen.blits++
    if ('cells' in e) {
      if (lastCells.get(e.key) === String(e.cells)) seen.repeats++
      lastCells.set(e.key, String(e.cells))
    }
    if (e.key === 'top' && 'cells' in e) seen.topBlit = { cells: String(e.cells), columns: Number(e.columns), rows: Number(e.rows), at: ++seen.seq }
    return { value: {} }
  })
  on('ui.invalidate', () => {
    seen.invalidates++
    seen.redrawnAt = ++seen.seq
    return { value: undefined }
  })
  on('mcp.connect', () => {
    seen.connects++
    return { value: seen.connectOk ? { isConnected: true, server: SERVER } : { isConnected: false, reason: 'unlisted', message: 'not listed' } }
  })
  on('mcp.call', async (_, e) => {
    seen.calls.push({ tool: e.tool, args: e.args })
    if (e.tool !== 'omnis_feed') return { value: { content: [{ type: 'text', text: '{}' }], isError: false } }
    if (seen.feed === 'late') await seen.late()
    if (seen.feed === 'throw') throw new Error('Connection closed')
    if (seen.feed === 'error') return { value: { content: [{ type: 'text', text: 'omnis_feed failed' }], isError: true } }
    // Past the MCP output cap the engine hands back a notice in place of the reply.
    if (seen.feed === 'garbage') return { value: { content: [{ type: 'text', text: 'Output too large (61.2KB), saved to a file.' }], isError: false } }
    if (seen.feed === 'quiet' && Number(e.args.since ?? 0) === 100) {
      return { value: { content: [{ type: 'text', text: JSON.stringify({ v: 1, kind: 'events', swarm: FIVE_SWARM, offset: 100, events: [], bad: 0 }) }], isError: false } }
    }
    const text = JSON.stringify({ v: 1, kind: 'state', swarm: FIVE_SWARM, offset: 100, state })
    seen.newsAt = ++seen.seq
    seen.news.push(seen.newsAt)
    return { value: { content: [{ type: 'text', text }], isError: false } }
  })
  on('session.id', () => ({ value: 'test-session' }))
  on('agent.list', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return seen
}

/** The auto-open runs in the background after the tool call returns: these wait for it, by microtask yields. */
export async function until(cond: () => boolean, max = 20000): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (cond()) return
    await Promise.resolve()
  }
  throw new Error(`until: the condition still did not hold after ${max} microtask yields`)
}
export async function settle(): Promise<void> {
  for (let i = 0; i < 2000; i++) await Promise.resolve()
}

export const feedCalls = (seen: Seen) => seen.calls.filter(c => c.tool === 'omnis_feed')
export const rasterText = (el: { props: Record<string, unknown> } | undefined): string[] =>
  el === undefined ? [] : gridText(decodeCells(String(el.props.cells), Number(el.props.columns), Number(el.props.rows)))

/** Opens the pane on the terminal, lets the first pull land and mounts it. */
/** `small` mounts an 80 x 24 pane: the long-clock tests render every frame for real, and a smaller grid keeps them quick. */
export async function opened($: Parameters<TestBody>[0], on: On, small = false) {
  const seen = engine(on)
  const clock = mock.clock(on, { now: FIVE_AT.mid })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'omnis', args: 'pane', ...RUN })
  await clock.settle()
  const props = small ? { ...PANE.props, bodyColumns: 80, scroll: { offset: 0, bodyRows: 24 } } : PANE.props
  const ui = await $.ui.mount({ ...PANE, props, surface: 'terminal' })
  // What the top Raster shows now: the last blit when it came after the last redraw, otherwise the drawn tree.
  const top = async (): Promise<string> => {
    const b = seen.topBlit
    if (b !== null && b.at > seen.redrawnAt) return gridText(decodeCells(b.cells, b.columns, b.rows)).join('\n')
    return rasterText(await ui.find({ type: 'Raster', key: 'top' })).join('\n')
  }
  return { seen, clock, ui, top }
}

/**
 * Why tests wait for a blit rather than count on one a second: the pane reads Date.now(), which the kit does not mock,
 * so it draws each frame at the real time while timers run on the test's mocked clock. It blits only cells that
 * changed, and frames a few real milliseconds apart are the same picture, so a blit comes only once enough real time
 * has passed for the picture to move. And the render budget spaces frames by their real cost (a cold first frame takes
 * tens of real ms, so the next comes hundreds of mocked ms later). How many blits land in a mocked second therefore
 * depends on the machine. Move the clock on until one has, up to 100 mocked seconds.
 */
export async function untilBlit(seen: Seen, clock: MockClock): Promise<void> {
  for (let i = 0; i < 400 && seen.blits === 0; i++) await clock.advance(250)
}
