import { expect, mock, test } from 'claude-code/testing'
import { Grid } from '../render/grid.ts'
import { svgSource } from './pane.ts'
import { INIT, PANE, RUN, engine, feedCalls, never, opened, rasterText, settle, until, untilBlit } from './test-engine.ts'
import { FIVE_AT } from '../../tests/fixtures/swarm-five.ts'

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

test('a pin press whose state write never lands changes nothing and leaves no rejection behind', async ($, on) => {
  engine(on)
  // Every write misses its version, as if another write always beat it.
  on('state.set', () => ({ value: { isSet: false, version: 1 } }))
  const clock = mock.clock(on, { now: FIVE_AT.mid })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'omnis', args: 'pane', ...RUN })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'pin:a-test' })
  await clock.settle()
  expect((await ui.find({ type: 'Button', key: 'pin:a-test' }))?.props.variant).toBeUndefined()
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

test('auto opens the pane for omnis_swarm_init under the .mcp.json server name too', { options: { panel: 'auto' } }, async ($, on) => {
  const seen = engine(on)
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__omnis-swarm__omnis_swarm_init', name: 'x', topology: 'mesh' })
  await until(() => seen.opens === 1)
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


test('a hidden pane makes no omnis_feed calls and runs no frames, looks at the panes about once a second, and resumes when shown', async ($, on) => {
  const { seen, clock, ui } = await opened($, on)
  await untilBlit(seen, clock)
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

test('a Raster whose cells have not changed is not blitted again', async ($, on) => {
  const { seen, clock, ui } = await opened($, on)
  await untilBlit(seen, clock)
  await clock.advance(3000)
  expect(seen.blits).toBeGreaterThan(0)
  expect(seen.repeats).toBe(0)
  await ui.unmount()
})

test('a refused blit is sent again by the next frame, even when its cells have not changed', { timeoutMs: 15_000 }, async ($, on) => {
  const { seen, clock, ui } = await opened($, on)
  await untilBlit(seen, clock)
  seen.refuse = 1
  // A blit comes only once enough real time has passed for the picture to move (see untilBlit), so this cap is
  // generous; the test's own time limit bounds it.
  for (let i = 0; i < 400 && seen.blitLog.filter(b => !b.ok).length === 0; i++) await clock.advance(250)
  const refused = seen.blitLog.find(b => !b.ok)
  expect(refused).toBeDefined()
  // This discriminates only while nothing animates: a moving picture sends fresh cells on its own, with or without the
  // fix. The five-agent swarm at FIVE_AT.mid is still enough between pulls for the frames to match.
  // Every pull answers a whole state, and each answer draws a frame. Frames that send nothing are invisible to the
  // stub, so the answers mark frames: the resend must come no later than the frame drawn for the first answer after
  // the refusal, so before the second answer. Without the fix, identical frames send nothing until the picture moves.
  const newsAfter = () => seen.news.filter(n => n > refused!.at)
  for (let i = 0; i < 80 && newsAfter().length < 2; i++) await clock.advance(50)
  expect(newsAfter().length).toBeGreaterThanOrEqual(2)
  const resend = seen.blitLog.find(b => b.at > refused!.at && b.key === refused!.key)
  expect(resend).toBeDefined()
  expect(resend!.ok).toBe(true)
  expect(resend!.at).toBeLessThan(newsAfter()[1]!)
  await ui.unmount()
})

test('off the terminal, news redraws the Svg no faster than the budget allows, and the latest news is drawn', async ($, on) => {
  const seen = engine(on)
  const clock = mock.clock(on, { now: FIVE_AT.mid })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'omnis', args: 'pane', ...RUN })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // Every pull answers a whole state, which counts as news: about 4 a second.
  const before = seen.invalidates
  const pulls = feedCalls(seen).length
  await clock.advance(3000)
  expect(feedCalls(seen).length - pulls).toBeGreaterThanOrEqual(8)
  // At most one redraw a second (the tick rate, or slower when the Svg is slow), plus one held back to the end.
  expect(seen.invalidates - before).toBeGreaterThanOrEqual(1)
  expect(seen.invalidates - before).toBeLessThanOrEqual(4)
  // The news stops (the next pull never answers). The redraw held back for the last news still comes, after it.
  // (The kit does not draw the mount again on a redraw, so this checks the order of the asks, not the picture.)
  seen.feed = 'late'
  seen.late = never
  const lastNews = seen.newsAt
  // The Svg is dear to draw (often over 100 ms real in the engine), so the held redraw can be a few seconds off.
  await clock.advance(8000)
  expect(seen.newsAt).toBe(lastNews)
  expect(seen.redrawnAt).toBeGreaterThan(lastNews)
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
  // Given up at 30 s, then the 5 s wait before connecting afresh.
  await clock.advance(30_000)
  expect(feedCalls(seen).length).toBeGreaterThan(stuck)
  await ui.unmount()
})

test('giving up on a hung pull drops the server and backs off before connecting again', { timeoutMs: 30_000 }, async ($, on) => {
  // Off the terminal there is no frame loop, so moving the clock 36 s costs little real time. The kit gives the hung
  // feed call 10 real seconds before it drops the stub; with frames drawn, a busy machine went past that.
  const seen = engine(on)
  const clock = mock.clock(on, { now: FIVE_AT.mid })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'omnis', args: 'pane', ...RUN })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await clock.advance(300)
  seen.late = never
  seen.feed = 'late'
  await clock.advance(300)
  const stuck = feedCalls(seen).length
  const connects = seen.connects
  // Given up at 30 s: no call is stacked on the hung server, and no connect comes before the 5 s wait.
  await clock.advance(31_000)
  expect(feedCalls(seen).length).toBe(stuck)
  expect(seen.connects).toBe(connects)
  // After the wait the pane connects afresh, then pulls.
  await clock.advance(5_000)
  expect(seen.connects).toBe(connects + 1)
  expect(feedCalls(seen).length).toBe(stuck + 1)
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
  // The Agent call runs until the test lets it finish. Left hanging, the kit rejects it once the test ends.
  let finish: (() => void) | null = null
  on('tool.call', () => new Promise<{ result: never }>(resolve => { finish = () => resolve({ result: {} as never }) }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  let done = false
  const running = $.tool.call({ tool: 'Agent', prompt: 'Review the auth module', description: 'review auth' }).finally(() => { done = true })
  await until(() => seen.opens === 1 && finish !== null)
  expect(done).toBe(false)
  finish!()
  expect((await running).result).toEqual({})
})

for (const [what, pin] of [['a number', 42], ['an object', { toString: 1, valueOf: 1 }], ['an unknown agent', 'a-gone']] as const) {
  test(`a stored pin that is ${what} counts as no pin, and the pane draws normally`, async ($, on) => {
    const seen = engine(on)
    on('state.get', (_, e) => ({ value: { value: String(e.key) === 'panePinned' ? pin : undefined, version: 0 } }))
    const clock = mock.clock(on, { now: FIVE_AT.mid })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.command.run({ command: 'omnis', args: 'pane', ...RUN })
    await clock.settle()
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(rasterText(await ui.find({ type: 'Raster', key: 'top' })).join('\n')).toContain('architect')
    const buttons = await ui.findAll({ type: 'Button' })
    expect(buttons).toHaveLength(6)
    expect(buttons.every(b => b.props.variant === undefined)).toBe(true)
    expect(feedCalls(seen).length).toBeGreaterThan(0)
    await ui.unmount()
  })
}

test('off the terminal a grid becomes Svg source, or the summary as text when the Svg is too big or the surface has none', () => {
  const grid = new Grid(40, 10, 0x0b0f17, 0xe6edf3)
  expect(svgSource(grid, 'auth refactor', true)).toContain('<svg')
  expect(svgSource(grid, 'auth refactor', true, 50)).toBeNull()
  expect(svgSource(grid, 'auth refactor', false)).toBeNull()
})
