// src/mod/replay.test.ts
// The kit loads the plugin itself (register.ts), so these tests do not call registerPane again: a second ui.close hook is refused.
import { expect, mock, test, type TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'
import { parseReplay } from './replay-command.ts'
import { PANE, RUN, engine, feedCalls, rasterText, settle } from './test-engine.ts'
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

test('a second session.start during a replay does not start the live pulls again', LOADED, async ($, on) => {
  const { seen, clock, ui } = await replaying($, on)
  const feeds = feedCalls(seen).length
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)
  await settle()
  expect(feedCalls(seen).length).toBe(feeds)
  expect((await $.command.run({ command: 'omnis', args: 'replay stop', ...RUN })).text).toBe('Back to the live swarm.')
  await clock.advance(1000)
  await settle()
  expect(feedCalls(seen).length).toBeGreaterThan(feeds)
  await ui.unmount()
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

test('parseReplay reads the swarm, the speed and stop', async () => {
  expect(parseReplay(['replay'])).toEqual({ swarm: null, speed: 10 })
  expect(parseReplay(['replay', 'alpha', '20'])).toEqual({ swarm: 'alpha', speed: 20 })
  expect(parseReplay(['replay', '5'])).toEqual({ swarm: null, speed: 5 })
  expect(parseReplay(['replay', '0'])).toBe(null)
  expect(parseReplay(['replay', 'alpha', 'beta'])).toBe(null)
  expect(parseReplay(['replay', 'alpha', '61'])).toBe(null)
  expect(parseReplay(['replay', 'stop'])).toBe('stop')
})
