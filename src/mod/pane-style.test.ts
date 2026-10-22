import { expect, mock, test } from 'claude-code/testing'
import { PANE, RUN, engine, opened, rasterText } from './test-engine.ts'
import { FIVE_AT } from '../../tests/fixtures/swarm-five.ts'

// pane.md 12.1: /omnis pane style robot|globe, one pane-wide setting kept in $.state as the pin is.

test('/omnis pane style robot draws robots at once, is kept in state, and globe brings the globes back', async ($, on) => {
  const { seen, ui } = await opened($, on)
  const graphOf = async (): Promise<string> => rasterText(await ui.find({ type: 'Raster', key: 'top' })).slice(2).join('\n')
  const globes = await graphOf()
  const before = seen.invalidates
  expect((await $.command.run({ command: 'omnis', args: 'pane style robot', ...RUN })).text).toBe('Swarm pane style: robots.')
  expect(seen.invalidates).toBeGreaterThan(before)
  // ui.render reads the style back from $.state, so a remount drawing robots shows the write landed.
  await ui.unmount()
  const robotUi = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const robots = rasterText(await robotUi.find({ type: 'Raster', key: 'top' })).slice(2).join('\n')
  expect(robots).not.toBe(globes)
  for (const name of ['architect', 'coder-1', 'tester', 'reviewer']) expect(robots).toContain(name)
  expect((await $.command.run({ command: 'omnis', args: 'pane style globe', ...RUN })).text).toBe('Swarm pane style: globes.')
  await robotUi.unmount()
  const globeUi = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(rasterText(await globeUi.find({ type: 'Raster', key: 'top' })).slice(2).join('\n')).not.toBe(robots)
  await globeUi.unmount()
})

test('/omnis pane style with no style or an unknown one gets the usage', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (const args of ['pane style', 'pane style robots', 'pane style tv', 'pane style robot now']) {
    expect((await $.command.run({ command: 'omnis', args, ...RUN })).text).toMatch(/^Usage: .*style robot\|globe/)
  }
})

for (const [what, style] of [['a number', 42], ['an object', { toString: 1 }], ['an unknown word', 'robots']] as const) {
  test(`a stored style that is ${what} draws exactly the globes that no stored style does`, async ($, on) => {
    engine(on)
    let stored: unknown
    on('state.get', (_, e) => ({ value: { value: String(e.key) === 'paneStyle' ? stored : undefined, version: 0 } }))
    const clock = mock.clock(on, { now: FIVE_AT.mid })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.command.run({ command: 'omnis', args: 'pane', ...RUN })
    await clock.settle()
    // The graph rows under the header, as each mount draws them (ui.render reads the stored style every time).
    const graphWith = async (value: unknown): Promise<string> => {
      stored = value
      const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
      const text = rasterText(await ui.find({ type: 'Raster', key: 'top' })).slice(2).join('\n')
      await ui.unmount()
      return text
    }
    const globes = await graphWith(undefined)
    expect(globes).toContain('architect')
    expect(await graphWith(style)).toBe(globes)
    // The comparison can tell the styles apart: a stored 'robot' draws something else.
    expect(await graphWith('robot')).not.toBe(globes)
  })
}
