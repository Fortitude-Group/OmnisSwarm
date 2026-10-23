// src/mod/commands.test.ts
import { expect, mock, test } from 'claude-code/testing'
import { COMMAND_DESCRIPTION, COMMAND_HINT, USAGE } from './commands.ts'
import { FIVE_AT } from '../../tests/fixtures/swarm-five.ts'
import { engine, RUN, KIT } from './test-engine.ts'

test('the /omnis text is what it was before the split', KIT, async () => {
  expect(COMMAND_DESCRIPTION).toBe('OmnisSwarm: /omnis pane shows the live swarm pane, /omnis pane close hides it, /omnis pane style robot|globe picks the node style, /omnis budget shows or sets the swarm budget, /omnis replay [swarm] [speed] replays a recorded swarm, /omnis export gif [swarm] saves a GIF of a swarm, /omnis report writes a report of the current swarm')
  expect(COMMAND_HINT).toBe('pane [close | style robot|globe] | budget [usd] | replay [swarm] [speed] | replay stop | export gif [swarm] | report')
  expect(USAGE).toBe('Usage: /omnis pane, /omnis pane close, or /omnis pane style robot|globe. Usage: /omnis budget shows the limits; /omnis budget <usd> sets the swarm budget (above 0, at most 1000). Usage: /omnis replay [swarm] [speed 1-60], or /omnis replay stop. Usage: /omnis export gif [swarm]. Usage: /omnis report writes a report of the current swarm.')
})

test('an unknown subcommand answers the usage, and pane still opens', KIT, async ($, on) => {
  const clock = mock.clock(on, { now: FIVE_AT.mid })
  const seen = engine(on)
  await $.session.start({ cwd: '/project', surface: null, isInteractive: true })
  expect((await $.command.run({ command: 'omnis', args: 'nonsense', ...RUN })).text).toBe(USAGE)
  expect((await $.command.run({ command: 'omnis', args: 'pane', ...RUN })).text).toBe('Swarm pane open.')
  await clock.settle()
  expect(seen.opens).toBe(1)
})
