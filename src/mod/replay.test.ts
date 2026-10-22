// src/mod/replay.test.ts
// The kit loads the plugin itself (register.ts), so these tests do not call registerPane again: a second ui.close hook is refused.
import { expect, mock, test, type TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'
import { parseReplay } from './replay-command.ts'
import { PANE, RUN, engine, feedCalls, never, rasterText, settle, KIT } from './test-engine.ts'
import { FIVE_AT, FIVE_SWARM, fiveAgentEvents } from '../../tests/fixtures/swarm-five.ts'

const LOADED = { timeoutMs: 60000 }
const page = (done: boolean) => JSON.stringify({ v: 1, kind: 'replay', swarm: FIVE_SWARM, offset: 9, done, events: fiveAgentEvents(), bad: 0 })

test('/omnis replay opens the pane, plays at 10× by default, and stop returns to live', LOADED, async ($, on) => {
  const seen = engine(on)
  seen.onTool = tool => (tool === 'omnis_replay' ? page(true) : null)
  const clock = mock.clock(on, { now: FIVE_AT.mid })
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  expect((await $.command.run({ command: 'omnis', args: 'replay', ...RUN })).text).toBe(`Replaying ${FIVE_SWARM} at 10×. /omnis replay stop returns to live.`)
  expect(seen.opens).toBe(1)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await clock.advance(500)
  await settle()
  expect(seen.calls.some(c => c.tool === 'omnis_replay' && c.args.since === 0)).toBe(true)
  expect(rasterText(await ui.find({ type: 'Raster', key: 'top' }))[0]).toMatch(/^ REPLAY 10× {2}\d\d:\d\d \/ /)
  // The live pulls stop while the replay plays.
  const feeds = feedCalls(seen).length
  await clock.advance(3000)
  await settle()
  expect(feedCalls(seen).length).toBe(feeds)
  expect((await $.command.run({ command: 'omnis', args: 'replay stop', ...RUN })).text).toBe('Back to the live swarm.')
  // And start again after it.
  await clock.advance(1000)
  await settle()
  expect(feedCalls(seen).length).toBeGreaterThan(feeds)
  expect((await $.command.run({ command: 'omnis', args: 'replay stop', ...RUN })).text).toBe('No replay is playing.')
  await ui.unmount()
})

/** Starts a replay on the terminal and mounts the pane, as a person would see it. */
async function replaying($: Parameters<TestBody>[0], on: On) {
  const seen = engine(on)
  seen.onTool = tool => (tool === 'omnis_replay' ? page(true) : null)
  const clock = mock.clock(on, { now: FIVE_AT.mid })
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'omnis', args: 'replay', ...RUN })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await clock.advance(500)
  await settle()
  return { seen, clock, ui }
}

test('a second session.start ends the replay (no replay is left on the old host) and the pane goes back to live', LOADED, async ($, on) => {
  const { seen, clock, ui } = await replaying($, on)
  const feeds = feedCalls(seen).length
  await clock.advance(1000)
  await settle()
  expect(feedCalls(seen).length).toBe(feeds)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await clock.advance(1000)
  await settle()
  expect(feedCalls(seen).length).toBeGreaterThan(feeds)
  expect((await $.command.run({ command: 'omnis', args: 'replay stop', ...RUN })).text).toBe('No replay is playing.')
  await ui.unmount()
})

test('two pages: the second asks from the first reply\'s offset, and the replay plays both to the end', LOADED, async ($, on) => {
  const seen = engine(on)
  // Every event at the first one's time: the replay folds both pages and ends on its first tick, with no wait on the
  // real clock (the kit mocks timers, not the Date.now the replay runs on).
  const all = fiveAgentEvents().map((e, _i, list) => ({ ...e, ts: list[0]!.ts }))
  const pageOf = (offset: number, done: boolean, events: unknown[]) => JSON.stringify({ v: 1, kind: 'replay', swarm: FIVE_SWARM, offset, done, events, bad: 0 })
  seen.onTool = (tool, args) => (tool !== 'omnis_replay' ? null : args.since === 0 ? pageOf(9, false, all.slice(0, 19)) : pageOf(30, true, all.slice(19)))
  const clock = mock.clock(on, { now: FIVE_AT.mid })
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  expect((await $.command.run({ command: 'omnis', args: 'replay 60', ...RUN })).text).toBe(`Replaying ${FIVE_SWARM} at 60×. /omnis replay stop returns to live.`)
  const pages = seen.calls.filter(c => c.tool === 'omnis_replay').map(c => c.args)
  expect(pages).toEqual([{ since: 0 }, { since: 9, swarm: FIVE_SWARM }])
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await clock.advance(500)
  await settle()
  // New agents change the chips, so the pane asks for a redraw; the kit does not redraw a mount, so mount again.
  await ui.unmount()
  const again = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const row0 = rasterText(await again.find({ type: 'Raster', key: 'top' }))[0]!
  expect(row0).toMatch(/^ REPLAY 60× {2}00:00 \/ 00:00 end {2}◆ auth refactor/)
  // Agents from both pages: the second page starts the sixth.
  expect(row0).toContain('6 agents')
  await again.unmount()
})

test('after the end the replay only looks at the pane, at the idle rate', LOADED, async ($, on) => {
  const seen = engine(on)
  const first = fiveAgentEvents().slice(0, 1)
  seen.onTool = tool => (tool === 'omnis_replay' ? JSON.stringify({ v: 1, kind: 'replay', swarm: FIVE_SWARM, offset: 1, done: true, events: first, bad: 0 }) : null)
  const clock = mock.clock(on, { now: FIVE_AT.mid })
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'omnis', args: 'replay', ...RUN })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // One event at offset 0: the first tick ends it.
  await clock.advance(1000)
  await settle()
  const looks = seen.panes
  await clock.advance(6000)
  await settle()
  // IDLE_PULL_MS is 1.5 s: 4 looks in 6 s, not the 24 a playing replay makes.
  expect(seen.panes - looks).toBeGreaterThanOrEqual(3)
  expect(seen.panes - looks).toBeLessThanOrEqual(5)
  expect((await $.command.run({ command: 'omnis', args: 'replay stop', ...RUN })).text).toBe('Back to the live swarm.')
  await ui.unmount()
})

test('a swarm longer than 40 pages is refused with the export hint', LOADED, async ($, on) => {
  const seen = engine(on)
  seen.onTool = tool => (tool === 'omnis_replay' ? page(false) : null)
  await $.session.start({ cwd: '/p', surface: null, isInteractive: true })
  expect((await $.command.run({ command: 'omnis', args: 'replay', ...RUN })).text).toBe('That swarm is too long to replay in the pane; try /omnis export gif.')
  expect(seen.calls.filter(c => c.tool === 'omnis_replay')).toHaveLength(40)
  expect(seen.opens).toBe(0)
})

test('a server that never answers fails the command after REPLAY_CALL_MS instead of hanging it', LOADED, async ($, on) => {
  const seen = engine(on)
  seen.onTool = tool => (tool === 'omnis_replay' ? never<string>() : null)
  const clock = mock.clock(on, { now: FIVE_AT.mid })
  await $.session.start({ cwd: '/p', surface: null, isInteractive: true })
  const ran = $.command.run({ command: 'omnis', args: 'replay', ...RUN })
  await settle()
  await clock.advance(15_000)
  expect((await ran).text).toBe('The swarm server did not answer in time; try again in a moment.')
  expect(seen.opens).toBe(0)
})

test('a replay stops drawing while the pane is hidden, draws again when shown, and ends when it closes', LOADED, async ($, on) => {
  const { seen, clock, ui } = await replaying($, on)
  // It looks at the panes as a shown pane pulls: about 4 times a second.
  let looks = seen.panes
  await clock.advance(1000)
  await settle()
  expect(seen.panes - looks).toBeGreaterThanOrEqual(3)
  seen.shown = false
  await clock.advance(500)
  await settle()
  const drawn = seen.blits + seen.invalidates
  looks = seen.panes
  await clock.advance(3000)
  await settle()
  // Hidden: no blits, no redraws, and a look about once a second.
  expect(seen.blits + seen.invalidates).toBe(drawn)
  expect(seen.panes - looks).toBeGreaterThanOrEqual(2)
  expect(seen.panes - looks).toBeLessThanOrEqual(4)
  const redraws = seen.invalidates
  seen.shown = true
  await clock.advance(1500)
  await settle()
  expect(seen.invalidates).toBeGreaterThan(redraws)
  expect((await $.command.run({ command: 'omnis', args: 'pane close', ...RUN })).text).toBe('Swarm pane closed.')
  expect((await $.command.run({ command: 'omnis', args: 'replay stop', ...RUN })).text).toBe('No replay is playing.')
  await ui.unmount()
})

test('speed outside 1-60 and an unknown swarm are refused', LOADED, async ($, on) => {
  const seen = engine(on)
  seen.onTool = tool => (tool === 'omnis_replay' ? JSON.stringify({ v: 1, kind: 'none', recent: ['alpha'] }) : null)
  await $.session.start({ cwd: '/p', surface: null, isInteractive: true })
  expect((await $.command.run({ command: 'omnis', args: 'replay alpha 61', ...RUN })).text).toBe('Usage: /omnis replay [swarm] [speed 1-60], or /omnis replay stop.')
  expect((await $.command.run({ command: 'omnis', args: 'replay nope', ...RUN })).text).toBe('No swarm nope here. Recent: alpha.')
  expect(seen.opens).toBe(0)
})

test('parseReplay reads the swarm, the speed and stop', KIT, async () => {
  expect(parseReplay(['replay'])).toEqual({ swarm: null, speed: 10 })
  expect(parseReplay(['replay', 'alpha', '20'])).toEqual({ swarm: 'alpha', speed: 20 })
  expect(parseReplay(['replay', '5'])).toEqual({ swarm: null, speed: 5 })
  expect(parseReplay(['replay', '0'])).toBe(null)
  expect(parseReplay(['replay', 'alpha', 'beta'])).toBe(null)
  expect(parseReplay(['replay', 'alpha', '61'])).toBe(null)
  expect(parseReplay(['replay', 'stop'])).toBe('stop')
  // An all-digit word is always a speed, and only last.
  expect(parseReplay(['replay', '123'])).toBe(null)
  expect(parseReplay(['replay', '007'])).toEqual({ swarm: null, speed: 7 })
  expect(parseReplay(['replay', '5', '6'])).toBe(null)
  expect(parseReplay(['replay', '5', 'alpha'])).toBe(null)
})
