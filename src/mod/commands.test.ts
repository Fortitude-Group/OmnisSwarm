// src/mod/commands.test.ts
import { expect, mock, test } from 'claude-code/testing'
import { COMMAND_DESCRIPTION, COMMAND_HINT, USAGE } from './commands.ts'
import { FIVE_AT } from '../../tests/fixtures/swarm-five.ts'
import { engine, RUN } from './test-engine.ts'

test('the /omnis text is what it was before the split', async () => {
  expect(COMMAND_DESCRIPTION).toBe('OmnisSwarm: /omnis pane shows the live swarm pane, /omnis pane close hides it, /omnis pane style robot|globe picks the node style')
  expect(COMMAND_HINT).toBe('pane [close | style robot|globe]')
  expect(USAGE).toBe('Usage: /omnis pane, /omnis pane close, or /omnis pane style robot|globe.')
})

test('an unknown subcommand answers the usage, and pane still opens', async ($, on) => {
  const clock = mock.clock(on, { now: FIVE_AT.mid })
  const seen = engine(on)
  await $.session.start({ cwd: '/project', surface: null, isInteractive: true })
  expect((await $.command.run({ command: 'omnis', args: 'budget', ...RUN })).text).toBe(USAGE)
  expect((await $.command.run({ command: 'omnis', args: 'pane', ...RUN })).text).toBe('Swarm pane open.')
  await clock.settle()
  expect(seen.opens).toBe(1)
})
