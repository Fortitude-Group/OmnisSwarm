/**
 * End to end: a swarm budget the swarm has passed shows ≈$X/$limit and BLOCKED in the pane's header, and
 * /omnis budget <higher> takes BLOCKED away. Headless through the engine, like pane-e2e.test.ts.
 */
import { expect, mock, test } from 'claude-code/testing'
import { foldAll } from '../core/fold.ts'
import { decodeCells, gridText } from '../render/grid.ts'
import { PANE, RUN } from './test-engine.ts'
import { FIVE_AT, FIVE_SWARM, fiveAgentEvents } from '../../tests/fixtures/swarm-five.ts'

type Blit = { key: string; cells: string; columns: number; rows: number }
const textOf = (b: Blit | undefined): string => (b === undefined ? '' : gridText(decodeCells(b.cells, b.columns, b.rows)).join('\n'))
const INIT = 'mcp__plugin_omnis-swarm_omnis-swarm__omnis_swarm_init'

test('the header shows the cost against the budget and BLOCKED, and a raised budget clears it', { timeoutMs: 60_000 }, async ($, on) => {
  const events = fiveAgentEvents()
  const blits: Blit[] = []
  let open = false
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => {
    open = true
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    open = false
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: open ? [{ id: 'omnis-swarm', title: 'Swarm', isShown: true, isFocused: false, isPlaced: true }] : [] }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.blit', (_, e) => {
    if ('cells' in e) blits.push({ key: e.key, cells: String(e.cells), columns: Number(e.columns), rows: Number(e.rows) })
    return { value: {} }
  })
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'plugin:omnis-swarm:omnis-swarm' } }))
  on('mcp.call', (_, e) => {
    const text = e.tool === 'omnis_record'
      ? `ok ${FIVE_SWARM}`
      : JSON.stringify(
        Number(e.args.since ?? 0) === 0
          ? { v: 1, kind: 'state', swarm: FIVE_SWARM, offset: 46, state: foldAll(FIVE_SWARM, events) }
          : { v: 1, kind: 'events', swarm: FIVE_SWARM, offset: Number(e.args.since), events: [], bad: 0 })
    return { value: { content: [{ type: 'text', text }], isError: false } }
  })
  on('session.id', () => ({ value: 'test-session' }))
  on('agent.list', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  // omnis_swarm_init answers as the server does for a new swarm; the guard reads that reply.
  on('tool.call', () => ({ result: { content: 'ok' } as never, text: `Swarm "auth refactor" started as ${FIVE_SWARM} (hierarchical).` }))
  const clock = mock.clock(on, { now: FIVE_AT.mid })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.tool.call({ tool: INIT, tool_use_id: 'toolu_init', topology: 'hierarchical', budget: { swarmUsd: 2 } } as never)
  await $.command.run({ command: 'omnis', args: 'pane', ...RUN })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await clock.settle()
  await $.session.measure({ context: { window: 1 }, cost: { usd: 5 }, changed: ['cost'] } as never)
  await clock.settle()

  const lastTop = () => textOf([...blits].reverse().find(b => b.key === 'top'))
  for (let i = 0; i < 400 && !lastTop().includes(' BLOCKED '); i++) await clock.advance(250)
  expect(lastTop()).toContain(' BLOCKED ')
  expect(lastTop()).toContain('/$2')

  expect((await $.command.run({ command: 'omnis', args: 'budget 8', ...RUN })).text).toBe('Swarm budget set to $8. New agents: allowed.')
  for (let i = 0; i < 400 && lastTop().includes(' BLOCKED '); i++) await clock.advance(250)
  expect(lastTop()).not.toContain(' BLOCKED ')
  expect(lastTop()).toContain('/$8')
  await ui.unmount()
})
