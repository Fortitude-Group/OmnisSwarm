/** /omnis budget: shows the limits, or sets the swarm budget (a budget.set event; spec section 2.3). */
import type { EngineInterface } from 'claude-code'
import { budgetText, isBlocked, parseUsd } from '../core/budget.ts'
import { guardView, setSwarmBudget } from './budget-guard.ts'
import type { Sub } from './commands.ts'

const USAGE = 'Usage: /omnis budget shows the limits; /omnis budget <usd> sets the swarm budget (above 0, at most 1000).'

export const budgetSub: Sub | null = {
  name: 'budget',
  describe: '/omnis budget shows or sets the swarm budget',
  hint: 'budget [usd]',
  usage: USAGE,
}

const usdText = (n: number): string => `$${Number.isInteger(n) ? n : n.toFixed(2)}`

/** `words` are the lower-cased words after /omnis, "budget" first. */
export async function budgetCommand(_$: EngineInterface, words: readonly string[]): Promise<string | null> {
  if (words.length === 1) {
    const v = guardView()
    return budgetText(v.limits, v.swarmUsd) + (v.pendingUsd === null ? '' : ` Next swarm's budget: ${usdText(v.pendingUsd)}.`)
  }
  const usd = words.length === 2 ? parseUsd(words[1]!) : null
  if (usd === null) return USAGE
  const set = await setSwarmBudget(usd)
  if (set === null) return 'The budget guard is not running yet; try again once the session has started.'
  if (set === 'next') return `No swarm is running. The swarm budget will be ${usdText(usd)} for the next swarm.`
  const v = guardView()
  return `Swarm budget set to ${usdText(usd)}. New agents: ${isBlocked(v.limits, v.swarmUsd) ? 'blocked' : 'allowed'}.`
}
