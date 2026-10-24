/** The budget guard's limits and thresholds (spec section 2). Pure and mod-safe: the mod and the server both use it. */
import { BUDGET_KEYS, BUDGET_MAX, type BudgetKey } from './events.ts'
import { LEAD, limitText, type AgentState, type SwarmState } from './fold.ts'

export type Limits = Record<BudgetKey, number>
export type BudgetPatch = Partial<Limits>
export type GuardAction =
  | { kind: 'warn'; agent: string; limit: 'time' | 'agentCost'; value: number; threshold: number }
  | { kind: 'nudge'; agent: string; limit: 'time' | 'agentCost'; value: number; threshold: number }
  | { kind: 'swarm-warn'; value: number; threshold: number }
  | { kind: 'block'; value: number; threshold: number }

export const DEFAULT_LIMITS: Limits = { agentMinutes: 30, agentUsd: 5, swarmUsd: 20 }
/** Each warning as a fraction of its act level: 20 of 30 minutes, $3 of $5, $10 of $20. */
export const WARN_AT: Limits = { agentMinutes: 2 / 3, agentUsd: 3 / 5, swarmUsd: 1 / 2 }
/** The plugin.json userConfig field for each limit. */
export const OPTION_KEYS: Record<BudgetKey, string> = { agentMinutes: 'budgetAgentMinutes', agentUsd: 'budgetAgentUsd', swarmUsd: 'budgetSwarmUsd' }

/**
 * The `billing` userConfig field. auto: a subscription once Claude Code reports one of its usage windows, else
 * pay-as-you-go. On a subscription the dollar limits are off (costs are still shown); the time-box stays.
 */
export const BILLING_MODES = ['auto', 'subscription', 'api'] as const
export type BillingMode = (typeof BILLING_MODES)[number]
export const billingFrom = (options: Readonly<Record<string, unknown>>): BillingMode =>
  (BILLING_MODES as readonly unknown[]).includes(options['billing']) ? (options['billing'] as BillingMode) : 'auto'

/** A subscription's usage windows. A gateway's `spend_limit` is pay-as-you-go, so it doesn't count. */
const PLAN_WINDOWS = new Set(['five_hour', 'seven_day'])

/** The 5-hour window's use (0 to 100) when `rateLimits` is a subscription reading, else null. */
export function planReading(rateLimits: unknown): { fiveHour: number | null } | null {
  if (!Array.isArray(rateLimits)) return null
  const windows = rateLimits.filter((r): r is { kind: string; percentUsed?: unknown } =>
    typeof r === 'object' && r !== null && PLAN_WINDOWS.has((r as { kind?: unknown }).kind as string))
  if (windows.length === 0) return null
  const five = windows.find(w => w.kind === 'five_hour')?.percentUsed
  return { fiveHour: typeof five === 'number' && Number.isFinite(five) ? Math.max(0, Math.min(100, five)) : null }
}

const round2 = (n: number): number => Math.round(n * 100) / 100
const valid = (key: BudgetKey, x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0 && x <= BUDGET_MAX[key]

/** userConfig's floors, as plugin.json states them: a time-box of at least a minute, any dollar amount above 0. */
const OPTION_MIN: Limits = { agentMinutes: 1, agentUsd: 0, swarmUsd: 0 }

export function limitsFrom(options: Readonly<Record<string, unknown>>): Limits {
  const out = { ...DEFAULT_LIMITS }
  for (const key of BUDGET_KEYS) {
    const v = options[OPTION_KEYS[key]]
    if (valid(key, v) && v >= OPTION_MIN[key]) out[key] = v
  }
  return out
}

export function parseBudget(x: unknown): { ok: true; patch: BudgetPatch } | { ok: false; error: string } {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return { ok: false, error: 'budget must be an object' }
  const raw = x as Record<string, unknown>
  for (const k of Object.keys(raw)) if (!(BUDGET_KEYS as readonly string[]).includes(k)) return { ok: false, error: `budget has an unknown field ${k.slice(0, 32)}` }
  const patch: BudgetPatch = {}
  for (const key of BUDGET_KEYS) {
    if (raw[key] === undefined) continue
    if (!valid(key, raw[key])) return { ok: false, error: `budget.${key} must be a number above 0 and at most ${BUDGET_MAX[key]}` }
    patch[key] = raw[key] as number
  }
  return Object.keys(patch).length === 0 ? { ok: false, error: 'budget must set at least one of agentMinutes, agentUsd, swarmUsd' } : { ok: true, patch }
}

/** `/omnis budget <usd>`: 30, $30 or 2.50 (at most two decimals), above 0 and at most the ceiling. */
export function parseUsd(word: string): number | null {
  const m = /^\$?(\d{1,4}(?:\.\d{1,2})?)$/.exec(word)
  if (m === null) return null
  const n = Number(m[1])
  return valid('swarmUsd', n) ? n : null
}

export function effective(defaults: Limits, state: SwarmState): Limits {
  const out = { ...defaults }
  for (const key of BUDGET_KEYS) {
    const v = state.budget[key]
    if (v !== null) out[key] = v
  }
  return out
}

export const warnLevel = (limits: Limits, key: BudgetKey): number => round2(limits[key] * WARN_AT[key])

/** Claude Code's session cost since the swarm began; before any session cost has arrived, the agents' own estimates. */
export function swarmCost(state: SwarmState, baseUsd: number | null): number {
  const session = state.session.costUsd
  if (session !== null) return round2(Math.max(0, session - (baseUsd ?? 0)))
  let sum = 0
  for (const a of Object.values(state.agents)) sum += a.costUsd
  return round2(sum)
}

/** A stage fires once its threshold is reached, unless it already fired at that threshold or a higher one. */
const fires = (value: number, threshold: number, fired: number | null): boolean => value >= threshold && (fired === null || fired < threshold)

const NO_GUARD = { timeWarn: null, timeAct: null, costWarn: null, costAct: null }

const timed = (a: AgentState): boolean => a.id !== LEAD && !a.placeholder && a.finishedAt === null

/** `dollars` false (a subscription): only the time-box is checked. */
export function evaluate(state: SwarmState, limits: Limits, swarmUsd: number, now: number, dollars = true): GuardAction[] {
  const out: GuardAction[] = []
  for (const a of Object.values(state.agents)) {
    if (!timed(a)) continue
    const g = a.guard ?? NO_GUARD
    const checks = [
      { limit: 'time' as const, value: round2(Math.max(0, now - a.startedAt) / 60_000), key: 'agentMinutes' as const, warned: g.timeWarn, acted: g.timeAct },
      { limit: 'agentCost' as const, value: round2(a.costUsd), key: 'agentUsd' as const, warned: g.costWarn, acted: g.costAct },
    ]
    for (const c of checks) {
      if (!dollars && c.limit === 'agentCost') continue
      const warn = warnLevel(limits, c.key)
      if (fires(c.value, warn, c.warned)) out.push({ kind: 'warn', agent: a.id, limit: c.limit, value: c.value, threshold: warn })
      if (fires(c.value, limits[c.key], c.acted)) out.push({ kind: 'nudge', agent: a.id, limit: c.limit, value: c.value, threshold: limits[c.key] })
    }
  }
  if (!dollars) return out
  const warn = warnLevel(limits, 'swarmUsd')
  if (fires(swarmUsd, warn, state.guard.warn)) out.push({ kind: 'swarm-warn', value: swarmUsd, threshold: warn })
  if (fires(swarmUsd, limits.swarmUsd, state.guard.block)) out.push({ kind: 'block', value: swarmUsd, threshold: limits.swarmUsd })
  return out
}

export const isBlocked = (limits: Limits, swarmUsd: number): boolean => swarmUsd >= limits.swarmUsd

/** Minutes are floored, so a figure never claims more time than has passed; under ten they keep one decimal. */
const minutes = (value: number): string => (value >= 10 ? `${Math.floor(value)}` : `${Math.floor(value * 10) / 10}`)
const shown = (limit: 'time' | 'agentCost', value: number): string => (limit === 'time' ? `${minutes(value)} min` : `≈$${value.toFixed(2)}`)

export function toastText(a: GuardAction, name: string, limits: Limits): string {
  switch (a.kind) {
    case 'warn':
      return a.limit === 'time'
        ? `${name}: ${shown(a.limit, a.value)}, past its ${limitText('time', a.threshold)} time-box`
        : `${name}: ${shown(a.limit, a.value)}, past its ${limitText('agentCost', a.threshold)} warning`
    case 'nudge':
      return `${name}: ${shown(a.limit, a.value)}, asked to wrap up (${limitText(a.limit, a.threshold)} ${a.limit === 'time' ? 'time-box' : 'budget'})`
    case 'swarm-warn':
      return `Swarm ≈$${a.value.toFixed(2)}, past its ${limitText('swarmCost', a.threshold)} warning`
    case 'block':
      return `Swarm budget ${limitText('swarmCost', limits.swarmUsd)} reached: new agents are blocked. /omnis budget <usd> raises it.`
  }
}

export const nudgeText = (limits: Limits, dollars = true): string =>
  `You're past your time-box (${limits.agentMinutes} min${dollars ? ` / ${limitText('agentCost', limits.agentUsd)}` : ''}). Wrap up what you have, report to main, and stop.`

export function mainText(name: string, a: GuardAction, limits: Limits, delivered: boolean, reason?: string): string {
  const limit = a.kind === 'nudge' ? `${limitText(a.limit, a.threshold)} ${a.limit === 'time' ? 'time-box' : 'budget'}` : `${limitText('swarmCost', limits.swarmUsd)} budget`
  const tail = delivered ? '' : ` The message was not delivered${reason === undefined ? '' : `: ${reason.slice(0, 80)}`}.`
  return `[OmnisSwarm budget guard] ${name} passed its ${limit} and was asked to wrap up and report to you.${tail}`
}

export const blockReason = (limits: Limits): string =>
  `Swarm budget ${limitText('swarmCost', limits.swarmUsd)} reached. Raise it with /omnis budget <usd> or finish with the agents you have.`

/** `plan` set: a subscription, so only the time-box is a limit; `fiveHour` is the 5-hour window's use when known. */
export function budgetText(limits: Limits, swarmUsd: number, plan?: { fiveHour: number | null }): string {
  const usd = (n: number) => limitText('agentCost', n)
  if (plan !== undefined) {
    const window = plan.fiveHour === null ? '' : ` 5-hour window ${plan.fiveHour}% used.`
    return `Budget: on a subscription, so no dollar limits (costs are shown for reference). Each agent ${limits.agentMinutes} min ` +
      `(warns at ${warnLevel(limits, 'agentMinutes')} min). Swarm so far ≈$${swarmUsd.toFixed(2)}.${window} New agents: allowed.`
  }
  return `Budget: each agent ${limits.agentMinutes} min / ${usd(limits.agentUsd)} (warns at ${warnLevel(limits, 'agentMinutes')} min / ${usd(warnLevel(limits, 'agentUsd'))}); ` +
    `swarm ${usd(limits.swarmUsd)} (warns at ${usd(warnLevel(limits, 'swarmUsd'))}). Swarm so far ≈$${swarmUsd.toFixed(2)}. ` +
    `New agents: ${isBlocked(limits, swarmUsd) ? 'blocked' : 'allowed'}.`
}
