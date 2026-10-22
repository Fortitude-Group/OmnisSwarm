import { expect, test } from 'claude-code/testing'
import type { Timer } from 'claude-code'
import { emptyModel } from './pane-model.ts'
import { pullTick, startPulling, type PaneHooks, type PullHost, type PullState } from './pane-pull.ts'
import { feedCalls, never, opened, KIT } from './test-engine.ts'

/** Pulls in the next `ms` of the mocked clock. */
async function pullsOver(seen: Parameters<typeof feedCalls>[0], clock: { advance: (ms: number) => Promise<void> }, ms: number): Promise<number> {
  const before = feedCalls(seen).length
  await clock.advance(ms)
  return feedCalls(seen).length - before
}

test('an idle shown pane pulls at most once every 1.5 s after 8 replies with no news, and news brings back 4 a second', { timeoutMs: 30_000 }, async ($, on) => {
  const { seen, clock, ui } = await opened($, on, true)
  seen.feed = 'quiet'
  // Eight quiet replies at 250 ms take 2 s; give it 3 s to slow down.
  await clock.advance(3000)
  expect(await pullsOver(seen, clock, 6000)).toBeLessThanOrEqual(4)
  seen.feed = 'ok'
  // The next slow pull brings news, and the pane is back to 250 ms.
  await clock.advance(1600)
  expect(await pullsOver(seen, clock, 1000)).toBeGreaterThanOrEqual(3)
  await ui.unmount()
})

test('a re-render or a pin press brings an idle pane back to 4 pulls a second', { timeoutMs: 30_000 }, async ($, on) => {
  const { seen, clock, ui } = await opened($, on, true)
  seen.feed = 'quiet'
  await clock.advance(3000)
  expect(await pullsOver(seen, clock, 1500)).toBeLessThanOrEqual(1)
  await ui.redraw()
  expect(await pullsOver(seen, clock, 1000)).toBeGreaterThanOrEqual(3)
  await clock.advance(3000)
  expect(await pullsOver(seen, clock, 1500)).toBeLessThanOrEqual(1)
  await ui.press({ key: 'pin:a-test' })
  expect(await pullsOver(seen, clock, 1000)).toBeGreaterThanOrEqual(3)
  await ui.unmount()
})

test('unreadable replies back the pulls off, doubling up to 5 s, and a good reply resets them', { timeoutMs: 30_000 }, async ($, on) => {
  const { seen, clock, ui, top } = await opened($, on, true)
  seen.feed = 'garbage'
  await clock.advance(300)
  expect(await top()).toContain('⚠ Waiting')
  // Waits of 0.5, 1, 2, 4 and then 5 s: far fewer than the 40 pulls 10 s at 250 ms would make.
  expect(await pullsOver(seen, clock, 10_000)).toBeLessThanOrEqual(6)
  const capped = await pullsOver(seen, clock, 10_000)
  expect(capped).toBeGreaterThanOrEqual(1)
  expect(capped).toBeLessThanOrEqual(3)
  seen.feed = 'ok'
  await clock.advance(5100)
  expect(await top()).not.toContain('⚠ Waiting')
  expect(await pullsOver(seen, clock, 1000)).toBeGreaterThanOrEqual(3)
  await ui.unmount()
})

type FakeTimer = Timer & { ms: number; cancelled: boolean }

test('a throw inside a pull period stops that timer and marks the pane degraded, and the pulls can start again', KIT, async () => {
  const timers: FakeTimer[] = []
  const fake = (ms: number): FakeTimer => {
    const t: FakeTimer = { ms, cancelled: false, cancel: () => { t.cancelled = true } } as FakeTimer
    timers.push(t)
    return t
  }
  let invalidates = 0
  const host: PullHost = {
    every: ms => fake(ms),
    after: ms => fake(ms),
    invalidate: () => { invalidates++ },
    // The first pull never settles, so the timer counts towards the stall mark, which draws the degraded note.
    panes: () => never(),
    connect: () => never(),
    call: () => never(),
  }
  const s: PullState = {
    open: true, shown: true, server: null, model: emptyModel(), pulling: false, pullSeq: 0, stalledMs: 0, stallMarked: false,
    pullTimer: null, pullMs: 0, connectWait: null, connectBackoffMs: 0, quiet: 0, unreadableMs: 0,
  }
  // Drawing the degraded note throws once, as a render that fails would.
  let throws = 1
  const pane: PaneHooks = {
    state: () => s, host: () => host, closed: () => {}, hidden: () => {}, swarmChanged: () => {},
    show: () => {
      if (throws-- > 0) throw new Error('render failed')
    },
  }
  startPulling(pane, host)
  const first = s.pullTimer as FakeTimer
  expect(first).not.toBeNull()
  // 5 s of 250 ms periods reach the stall mark.
  for (let i = 0; i < 20; i++) pullTick(pane, host)
  expect(first.cancelled).toBe(true)
  expect(s.pullTimer).toBeNull()
  expect(s.model.degraded).toBe('unreadable')
  expect(invalidates).toBe(1)
  startPulling(pane, host)
  expect(s.pullTimer).not.toBeNull()
  expect(s.pullTimer).not.toBe(first)
})
