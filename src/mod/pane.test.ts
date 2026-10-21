import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { foldAll } from '../core/fold.ts'
import { decodeCells, gridText } from '../render/grid.ts'
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

type Seen = { calls: Array<{ tool: string; args: Record<string, unknown> }>; opens: number; blits: number }

/** Stands in for the engine and the MCP server, which answers the five-agent swarm's folded state. */
function engine(on: On): Seen {
  const seen: Seen = { calls: [], opens: 0, blits: 0 }
  const state = foldAll(FIVE_SWARM, fiveAgentEvents())
  let open = false
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => {
    seen.opens++
    open = true
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    open = false
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: open ? [{ id: 'omnis-swarm', title: 'Swarm', isShown: true, isFocused: false, isPlaced: true }] : [] }))
  on('ui.blit', () => {
    seen.blits++
    return { value: {} }
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('mcp.connect', () => ({ value: { isConnected: true, server: SERVER } }))
  on('mcp.call', (_, e) => {
    seen.calls.push({ tool: e.tool, args: e.args })
    const text = e.tool === 'omnis_feed' ? JSON.stringify({ v: 1, kind: 'state', swarm: FIVE_SWARM, offset: 100, state }) : '{}'
    return { value: { content: [{ type: 'text', text }], isError: false } }
  })
  on('session.id', () => ({ value: 'test-session' }))
  on('agent.list', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return seen
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
  expect(seen.opens).toBe(1)
  await $.command.run({ command: 'omnis', args: 'pane close', ...RUN })
  await $.tool.call({ tool: INIT, name: 'y', topology: 'mesh' })
  expect(seen.opens).toBe(1)
})

test('auto opens the pane when an agent is spawned through the Agent tool', { options: { panel: 'auto' } }, async ($, on) => {
  const seen = engine(on)
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Agent', prompt: 'Review the auth module', description: 'review auth' })
  expect(seen.opens).toBe(1)
})

test('auto does not open the pane for other tools', { options: { panel: 'auto' } }, async ($, on) => {
  const seen = engine(on)
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.tool.call({ tool: 'Read', file_path: '/a.ts' })
  expect(seen.opens).toBe(0)
})

test('with panel command an Agent tool call does not open the pane', async ($, on) => {
  const seen = engine(on)
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Agent', prompt: 'Review the auth module', description: 'review auth' })
  expect(seen.opens).toBe(0)
})
