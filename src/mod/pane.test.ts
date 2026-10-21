import { expect, mock, test, type TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'
import { foldAll } from '../core/fold.ts'
import { Grid, decodeCells, gridText } from '../render/grid.ts'
import { svgSource } from './pane.ts'
import { FIVE_AT, FIVE_SWARM, fiveAgentEvents } from '../../tests/fixtures/swarm-five.ts'

const SERVER = 'plugin:omnis-swarm:omnis-swarm'
const INIT = 'mcp__plugin_omnis-swarm_omnis-swarm__omnis_swarm_init'
const PANE = {
  plugin: 'omnis-swarm',
  component: 'Pane',
  requestId: 'omnis-swarm',
  props: { title: 'Swarm', isFocused: false, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 44 }, view: {} },
} as const
const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const

type Feed = 'ok' | 'error' | 'garbage' | 'late' | 'throw'
/** What the stub saw, and its switches: `shown` (the pane placed but hidden when false), `feed` (how omnis_feed answers), `connectOk`. */
type Seen = {
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
  redrawnAt: number
  seq: number
}
/** Faults beneath session.start: ui.panes or command.register that never answer. */
type Faults = { panes?: 'hang'; register?: 'hang' }
const never = <T>(): Promise<T> => new Promise<T>(() => {})

/** Stands in for the engine and the MCP server, which answers the five-agent swarm's folded state. `openAs` makes ui.open fail or hang. */
function engine(on: On, openAs: 'ok' | 'throw' | 'hang' = 'ok', faults: Faults = {}): Seen {
  const seen: Seen = { calls: [], opens: 0, blits: 0, invalidates: 0, panes: 0, connects: 0, shown: true, feed: 'ok', connectOk: true,
    topBlit: null, redrawnAt: 0, seq: 0, late: () => Promise.resolve() }
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
    seen.blits++
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
    const text = JSON.stringify({ v: 1, kind: 'state', swarm: FIVE_SWARM, offset: 100, state })
    return { value: { content: [{ type: 'text', text }], isError: false } }
  })
  on('session.id', () => ({ value: 'test-session' }))
  on('agent.list', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return seen
}

/** The auto-open runs in the background after the tool call returns: these wait for it, by microtask yields. */
async function until(cond: () => boolean, max = 20000): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (cond()) return
    await Promise.resolve()
  }
  throw new Error(`until: the condition still did not hold after ${max} microtask yields`)
}
async function settle(): Promise<void> {
  for (let i = 0; i < 2000; i++) await Promise.resolve()
}

const feedCalls = (seen: Seen) => seen.calls.filter(c => c.tool === 'omnis_feed')
const rasterText = (el: { props: Record<string, unknown> } | undefined): string[] =>
  el === undefined ? [] : gridText(decodeCells(String(el.props.cells), Number(el.props.columns), Number(el.props.rows)))

test('/omnis pane opens the pane, pulls omnis_feed and draws the swarm in two Rasters with pin chips', async ($, on) => {
  const seen = engine(on)
  const clock = mock.clock(on, { now: FIVE_AT.mid })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ran = await $.command.run({ command: 'omnis', args: 'pane', ...RUN })
  expect(ran.text).toBe('Swarm pane open.')
  await clock.settle()
  expect(feedCalls(seen)[0]?.args).toEqual({ since: 0 })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const top = rasterText(await ui.find({ type: 'Raster', key: 'top' })).join('\n')
  const bottom = rasterText(await ui.find({ type: 'Raster', key: 'bottom' })).join('\n')
  expect(top).toContain('auth refactor')
  for (const name of ['architect', 'coder-1', 'coder-2', 'tester', 'reviewer']) expect(top).toContain(name)
  expect(bottom).toContain('tokens')
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(6)
  await ui.unmount()
})

test('a pin chip changes only what is shown: it pins the spotlight, and pressing it again unpins', async ($, on) => {
  const seen = engine(on)
  const clock = mock.clock(on, { now: FIVE_AT.mid })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'omnis', args: 'pane', ...RUN })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'pin:a-test' })
  expect(rasterText(await ui.find({ type: 'Raster', key: 'bottom' }))[0]).toContain('tester')
  expect((await ui.find({ type: 'Button', key: 'pin:a-test' }))?.props.variant).toBe('primary')
  await ui.press({ key: 'pin:a-test' })
  expect((await ui.find({ type: 'Button', key: 'pin:a-test' }))?.props.variant).toBeUndefined()
  expect(seen.calls.every(c => c.tool === 'omnis_feed' || c.tool === 'omnis_record')).toBe(true)
  await ui.unmount()
})

test('pulls run at most 4 a second and stop when the pane closes', async ($, on) => {
  const seen = engine(on)
  const clock = mock.clock(on, { now: FIVE_AT.mid })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'omnis', args: 'pane', ...RUN })
  await clock.settle()
  const before = feedCalls(seen).length
  await clock.advance(1000)
  const perSecond = feedCalls(seen).length - before
  expect(perSecond).toBeGreaterThanOrEqual(1)
  expect(perSecond).toBeLessThanOrEqual(4)
  const closed = await $.command.run({ command: 'omnis', args: 'pane close', ...RUN })
  expect(closed.text).toBe('Swarm pane closed.')
  const atClose = feedCalls(seen).length
  await clock.advance(2000)
  expect(feedCalls(seen).length).toBe(atClose)
})

test('off the terminal the same picture is an Svg, and nothing is blitted', async ($, on) => {
  const seen = engine(on)
  const clock = mock.clock(on, { now: FIVE_AT.mid })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'omnis', args: 'pane', ...RUN })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const svgs = await ui.findAll({ type: 'Svg' })
  expect(svgs).toHaveLength(2)
  expect(String(svgs[0]?.props.source)).toContain('architect')
  expect(String(svgs[0]?.props.alt)).toContain('auth refactor')
  expect(seen.blits).toBe(0)
  await ui.unmount()
})

test('panel off refuses to open the pane', { options: { panel: 'off' } }, async ($, on) => {
  const seen = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ran = await $.command.run({ command: 'omnis', args: 'pane', ...RUN })
  expect(ran.text).toMatch(/off/)
  expect(seen.opens).toBe(0)
})

test('/omnis-swarm:watch opens it too, and an unknown subcommand gets the usage', async ($, on) => {
  const seen = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect((await $.command.run({ command: 'omnis-swarm:watch', args: '', ...RUN })).text).toBe('Swarm pane open.')
  expect(seen.opens).toBe(1)
  expect((await $.command.run({ command: 'omnis', args: 'nonsense', ...RUN })).text).toMatch(/^Usage/)
})

test('auto opens the pane when a swarm starts, but not again after the person closed it', { options: { panel: 'auto' } }, async ($, on) => {
  const seen = engine(on)
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: INIT, name: 'x', topology: 'mesh' })
  await until(() => seen.opens === 1)
  await $.command.run({ command: 'omnis', args: 'pane close', ...RUN })
  await $.tool.call({ tool: INIT, name: 'y', topology: 'mesh' })
  await settle()
  expect(seen.opens).toBe(1)
})

test('auto opens the pane when an agent is spawned through the Agent tool', { options: { panel: 'auto' } }, async ($, on) => {
  const seen = engine(on)
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Agent', prompt: 'Review the auth module', description: 'review auth' })
  await until(() => seen.opens === 1)
  await $.tool.call({ tool: 'Agent', prompt: 'Test it', description: 'test auth' })
  await settle()
  expect(seen.opens).toBe(1)
})

test('auto does not open the pane for other tools', { options: { panel: 'auto' } }, async ($, on) => {
  const seen = engine(on)
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.tool.call({ tool: 'Read', file_path: '/a.ts' })
  await settle()
  expect(seen.opens).toBe(0)
})

test('with panel command an Agent tool call does not open the pane', async ($, on) => {
  const seen = engine(on)
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Agent', prompt: 'Review the auth module', description: 'review auth' })
  await settle()
  expect(seen.opens).toBe(0)
})

test("the recorder does not record the pane's omnis_feed pulls as agent tool calls", async ($, on) => {
  const seen = engine(on)
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on, { now: FIVE_AT.mid })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'omnis', args: 'pane', ...RUN })
  await clock.advance(1000)
  expect(feedCalls(seen).length).toBeGreaterThanOrEqual(1)
  // In case the engine dispatches a plugin's $.mcp.call as a tool call: the pull, by its full tool name, then a
  // Bash call to show the recorder is live in this session.
  await $.tool.call({ tool: 'mcp__plugin_omnis-swarm_omnis-swarm__omnis_feed', since: 0 })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await clock.settle()
  const recorded = seen.calls.filter(c => c.tool === 'omnis_record' && c.args.type === 'agent.tool').map(c => (c.args.data as { tool?: unknown }).tool)
  expect(recorded).toContain('Bash')
  expect(recorded.some(t => String(t).includes('omnis_feed'))).toBe(false)
})

for (const openAs of ['throw', 'hang'] as const) {
  const how = openAs === 'throw' ? 'throws' : 'never answers'
  test(`an Agent call's result comes back unchanged when ui.open ${how}`, { options: { panel: 'auto' } }, async ($, on) => {
    const seen = engine(on, openAs)
    const answer = { status: 'completed', content: [{ type: 'text', text: 'Reviewed.' }] }
    on('tool.call', () => ({ result: answer as never }))
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const ran = await $.tool.call({ tool: 'Agent', prompt: 'Review the auth module', description: 'review auth' })
    expect(ran.result).toEqual(answer)
    await until(() => seen.opens === 1)
    expect(feedCalls(seen)).toHaveLength(0)
  })
}

/** Opens the pane on the terminal, lets the first pull land and mounts it. */
/** `small` mounts an 80 x 24 pane: the long-clock tests render every frame for real, and a smaller grid keeps them quick. */
async function opened($: Parameters<TestBody>[0], on: On, small = false) {
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

test('a hidden pane makes no omnis_feed calls and runs no frames, looks at the panes about once a second, and resumes when shown', async ($, on) => {
  const { seen, clock, ui } = await opened($, on)
  await clock.advance(1000)
  expect(seen.blits).toBeGreaterThan(0)
  seen.shown = false
  await clock.advance(300)
  const feeds = feedCalls(seen).length
  const blits = seen.blits
  const panes = seen.panes
  await clock.advance(3000)
  expect(feedCalls(seen).length).toBe(feeds)
  expect(seen.blits).toBe(blits)
  expect(seen.panes - panes).toBeLessThanOrEqual(4)
  seen.shown = true
  await clock.advance(1500)
  expect(feedCalls(seen).length).toBeGreaterThan(feeds)
  const back = feedCalls(seen).length
  await clock.advance(1000)
  expect(feedCalls(seen).length - back).toBeLessThanOrEqual(4)
  await ui.unmount()
})

test('nothing is blitted after the pane closes', async ($, on) => {
  const { seen, clock, ui } = await opened($, on)
  await clock.advance(500)
  await $.command.run({ command: 'omnis', args: 'pane close', ...RUN })
  const blits = seen.blits
  await clock.advance(3000)
  expect(seen.blits).toBe(blits)
  await ui.unmount()
})

test('two session.starts and then an open still pull at most 4 times a second', async ($, on) => {
  const seen = engine(on)
  const clock = mock.clock(on, { now: FIVE_AT.mid })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'omnis', args: 'pane', ...RUN })
  await clock.settle()
  const before = feedCalls(seen).length
  await clock.advance(1000)
  expect(feedCalls(seen).length - before).toBeLessThanOrEqual(4)
})

for (const feed of ['error', 'garbage'] as const) {
  test(`a reply that ${feed === 'error' ? 'is an error' : 'will not parse'} shows the degraded note and keeps the last frame`, async ($, on) => {
    const { seen, clock, ui, top } = await opened($, on)
    expect(await top()).toContain('architect')
    seen.feed = feed
    await clock.advance(300)
    expect(await top()).toContain('⚠ Waiting')
    expect(await top()).toContain('architect')
    await ui.unmount()
  })
}

test('a lost server shows the degraded note, keeps the last frame, and reconnects no sooner than 5 s, backing off', { timeoutMs: 30_000 }, async ($, on) => {
  const { seen, clock, ui, top } = await opened($, on, true)
  seen.feed = 'throw'
  seen.connectOk = false
  // The failed call marks the pane, and the next pull tries to connect once at once.
  await clock.advance(600)
  expect(await top()).toContain('⚠ Waiting')
  expect(await top()).toContain('architect')
  const connects = seen.connects
  await clock.advance(4000)
  expect(seen.connects).toBe(connects)
  // Tries at about 5 s and 15 s (the wait doubles), not every 250 ms.
  await clock.advance(16_000)
  expect(seen.connects - connects).toBeGreaterThanOrEqual(1)
  expect(seen.connects - connects).toBeLessThanOrEqual(2)
  // The last failed try (at about 15 s) set a 20 s wait; the next try finds the server.
  seen.feed = 'ok'
  seen.connectOk = true
  await clock.advance(16_000)
  expect(await top()).not.toContain('⚠ Waiting')
  await ui.unmount()
})

test('with no server at all the pane says it is waiting, and does not reconnect on every pull', async ($, on) => {
  const seen = engine(on)
  seen.connectOk = false
  const clock = mock.clock(on, { now: FIVE_AT.mid })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  // The recorder connects once at session.start; the pane's own tries are counted from here.
  const atStart = seen.connects
  await $.command.run({ command: 'omnis', args: 'pane', ...RUN })
  await clock.advance(2000)
  expect(seen.connects - atStart).toBe(1)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toContain('⚠ Waiting')
  await ui.unmount()
})

test('a pull that does not settle shows the degraded note after 5 s, and a new pull may start after 30 s', { timeoutMs: 30_000 }, async ($, on) => {
  const { seen, clock, ui, top } = await opened($, on, true)
  await clock.advance(300)
  seen.late = () => clock.sleep(40_000)
  seen.feed = 'late'
  await clock.advance(300)
  const stuck = feedCalls(seen).length
  await clock.advance(6000)
  expect(await top()).toContain('⚠ Waiting')
  expect(feedCalls(seen).length).toBe(stuck)
  seen.feed = 'ok'
  await clock.advance(25_000)
  expect(feedCalls(seen).length).toBeGreaterThan(stuck)
  await ui.unmount()
})

for (const fault of ['panes', 'register'] as const) {
  test(`session.start returns when ${fault === 'panes' ? 'ui.panes' : 'command.register'} never answers`, async ($, on) => {
    engine(on, 'ok', { [fault]: 'hang' })
    expect(await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })).toEqual({ cwd: '/' })
  })
}

test('auto opens the pane while a foreground Agent call is still running', { options: { panel: 'auto' } }, async ($, on) => {
  const seen = engine(on)
  on('tool.call', () => never())
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  void $.tool.call({ tool: 'Agent', prompt: 'Review the auth module', description: 'review auth' })
  await until(() => seen.opens === 1)
})

test('off the terminal a grid becomes Svg source, or the summary as text when the Svg is too big or the surface has none', () => {
  const grid = new Grid(40, 10, 0x0b0f17, 0xe6edf3)
  expect(svgSource(grid, 'auth refactor', true)).toContain('<svg')
  expect(svgSource(grid, 'auth refactor', true, 50)).toBeNull()
  expect(svgSource(grid, 'auth refactor', false)).toBeNull()
})
