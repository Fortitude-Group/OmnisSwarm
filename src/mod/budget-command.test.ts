import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { RUN } from './test-engine.ts'

// The kit loads the plugin's own guard; /omnis budget is driven through the command, not by importing the guard.
const USAGE = 'Usage: /omnis budget shows the limits; /omnis budget <usd> sets the swarm budget (above 0, at most 1000).'
const budget = ($: Engine, args: string) => $.command.run({ command: 'omnis', args, ...RUN }).then(r => r.text)

test('/omnis budget with no amount shows the limits', async ($) => {
  expect(await budget($, 'budget')).toBe('Budget: each agent 30 min / $5 (warns at 20 min / $3); swarm $20 (warns at $10). Swarm so far ≈$0.00. New agents: allowed.')
})

test('/omnis budget refuses an amount it cannot read', async ($) => {
  for (const bad of ['abc', '0', '5000', '1e3', '5 6']) expect(await budget($, `budget ${bad}`)).toBe(USAGE)
})

test('/omnis budget 30 before the session has started says so', async ($) => {
  expect(await budget($, 'budget 30')).toBe('The budget guard is not running yet; try again once the session has started.')
})
