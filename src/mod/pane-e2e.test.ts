/**
 * Spec section 12 e2e, headless through the engine: a stand-in omnis_feed answers as the real server would, a state for
 * the five-agent swarm's first 30 events at offset 30, then the other 16 as an events reply, then nothing new. The
 * pane draws the first, repaints with the second by blits, and stops pulling, blitting and looking at the panes once closed.
 *
 * The pane reads Date.now(), which the kit does not mock, so it draws at the real time while timers run on the mocked
 * clock; frames are spaced by their real cost and only changed cells are blitted. So the test waits for outcomes (a
 * blit that shows the news), never for a count of frames.
 */
import { expect, mock, test } from 'claude-code/testing'
import { foldAll } from '../core/fold.ts'
import { decodeCells, gridText } from '../render/grid.ts'
import { PANE, RUN } from './test-engine.ts'
import { FIVE_AT, FIVE_SWARM, fiveAgentEvents } from '../../tests/fixtures/swarm-five.ts'

type Blit = { key: string; cells: string; columns: number; rows: number }
const textOf = (b: { cells: string; columns: number; rows: number } | undefined): string =>
  b === undefined ? '' : gridText(decodeCells(b.cells, b.columns, b.rows)).join('\n')

test('a scripted five-agent swarm arrives in two pulls; the pane draws it, repaints with the news, and stops when closed', { timeoutMs: 30_000 }, async ($, on) => {
  const events = fiveAgentEvents()
  expect(events).toHaveLength(46)
  const blits: Blit[] = []
  const asked: Array<Record<string, unknown>> = []
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
  let panes = 0
  on('ui.panes', () => {
    panes++
    return { value: open ? [{ id: 'omnis-swarm', title: 'Swarm', isShown: true, isFocused: false, isPlaced: true }] : [] }
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.blit', (_, e) => {
    if ('cells' in e) blits.push({ key: e.key, cells: String(e.cells), columns: Number(e.columns), rows: Number(e.rows) })
    return { value: {} }
  })
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'plugin:omnis-swarm:omnis-swarm' } }))
  on('mcp.call', (_, e) => {
    if (e.tool !== 'omnis_feed') return { value: { content: [{ type: 'text', text: '{}' }], isError: false } }
    asked.push(e.args)
    const since = Number(e.args.since ?? 0)
    const reply = since === 0
      ? { v: 1, kind: 'state', swarm: FIVE_SWARM, offset: 30, state: foldAll(FIVE_SWARM, events.slice(0, 30)) }
      : since === 30
        ? { v: 1, kind: 'events', swarm: FIVE_SWARM, offset: 46, events: events.slice(30), bad: 0 }
        : { v: 1, kind: 'events', swarm: FIVE_SWARM, offset: since, events: [], bad: 0 }
    return { value: { content: [{ type: 'text', text: JSON.stringify(reply) }], isError: false } }
  })
  on('session.id', () => ({ value: 'test-session' }))
  on('agent.list', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const clock = mock.clock(on, { now: FIVE_AT.mid })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect((await $.command.run({ command: 'omnis', args: 'pane', ...RUN })).text).toBe('Swarm pane open.')
  await clock.settle()
  expect(asked[0]).toEqual({ since: 0 })

  // The first draw: the state of the first 30 events. The ghost name and the finished task are not in it yet.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const mountedTop = await ui.find({ type: 'Raster', key: 'top' })
  const first = textOf({ cells: String(mountedTop?.props.cells), columns: Number(mountedTop?.props.columns), rows: Number(mountedTop?.props.rows) })
  for (const name of ['lead', 'architect', 'coder-1', 'coder-2', 'tester', 'reviewer']) expect(first).toContain(name)
  expect(first).toContain('6 agents')
  expect(first).toContain('tasks 2 pending · 0 active · 0 done')
  expect(first).not.toContain('ghost')
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(6)

  // The second pull asks from offset 30 and brings the last 16 events: wait for a top blit that shows them.
  const lastOf = (key: string) => [...blits].reverse().find(b => b.key === key)
  for (let i = 0; i < 400 && !textOf(lastOf('top')).includes('ghost'); i++) await clock.advance(250)
  expect(asked).toContainEqual({ since: 30, swarm: FIVE_SWARM })
  const top = textOf(lastOf('top'))
  for (const name of ['lead', 'architect', 'coder-1', 'coder-2', 'tester', 'reviewer', 'ghost']) expect(top).toContain(name)
  expect(top).toContain('6 agents')
  expect(top).toContain('tasks 0 pending · 1 active · 1 done')
  expect(top).toContain('ctx 34%')
  for (let i = 0; i < 400 && !textOf(lastOf('bottom')).includes('task t2 → done'); i++) await clock.advance(250)
  expect(textOf(lastOf('bottom'))).toContain('task t2 → done')
  // Nothing new after that: the pane keeps asking from offset 46.
  await clock.advance(500)
  expect(asked.at(-1)).toEqual({ since: 46, swarm: FIVE_SWARM })

  // Closed: no more pulls, no more blits and no more looks at the panes.
  expect((await $.command.run({ command: 'omnis', args: 'pane close', ...RUN })).text).toBe('Swarm pane closed.')
  const pulls = asked.length
  const sent = blits.length
  const looks = panes
  await clock.advance(5000)
  expect(asked.length).toBe(pulls)
  expect(blits.length).toBe(sent)
  expect(panes).toBe(looks)
  await ui.unmount()
})
