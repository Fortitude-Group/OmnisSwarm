/**
 * The budget guard (spec section 2): folds what this session's recorder lands, warns, nudges an agent past its
 * time-box or budget, and blocks the lead's new Agent calls past the swarm budget. It never stops work: a failure in
 * here fails open. Pure thresholds and words are in core/budget.ts.
 */
import type { EngineInterface, On, PluginOptions, Timer } from 'claude-code'
import {
  blockReason, effective, evaluate, isBlocked, limitsFrom, mainText, nudgeText, parseBudget, swarmCost, toastText, warnLevel,
  type BudgetPatch, type GuardAction, type Limits,
} from '../core/budget.ts'
import { makeEvent, type SwarmEvent } from '../core/events.ts'
import { emptyState, fold, LEAD, type SwarmState } from '../core/fold.ts'
import type { RecordBody } from '../core/recording.ts'
import type { ViewBudget } from '../render/types.ts'
import { record, type RecordObserver } from './recorder.ts'

export const TICK_MS = 15_000
const SWARM_INIT_TOOL = /^mcp__.+__omnis_swarm_init$/
const SWARM_END_TOOL = /^mcp__.+__omnis_swarm_end$/
const TOAST_MS = 8_000
/** omnis_swarm_init's replies (src/mcp/tools.ts), read from the end, where a swarm name can't reach. */
const STARTED_REPLY = /" started as [a-z0-9._-]+ \([a-z-]+\)\.$/
const RENAMED_REPLY = /\) now names the running session swarm [a-z0-9._-]+\.$/

/** What the guard needs from the engine, bound from `$` at session.start. */
type GuardHost = {
  now: () => Promise<number>
  every: (ms: number, fn: () => void) => Timer
  toast: (text: string) => void
  sendTo: (agentId: string, text: string) => Promise<{ isDelivered: boolean; reason?: string }>
  tellMain: (text: string) => Promise<unknown>
  record: (body: RecordBody) => Promise<void>
}

type Guard = {
  defaults: Limits
  host: GuardHost | null
  state: SwarmState | null
  /** The session cost when this swarm began, and the latest one seen. */
  baseUsd: number | null
  sessionUsd: number | null
  /** A budget from an omnis_swarm_init that may land in a swarm the guard has not seen yet. */
  nextBudget: BudgetPatch | null
  /** The pending budget came from /omnis budget, so no omnis_swarm_init has recorded it: record it when its swarm begins. */
  nextRecord: boolean
  timer: Timer | null
  /**
   * $.clock.now() minus Date.now(), read when the host is bound. The recorder stamps events with Date.now(), but the
   * guard's "now" is $.clock.now() only (a test's mock clock moves that and not Date.now()). Each check maps its clock
   * reading into the recorder's time by this offset, which is about 0 in a live session.
   */
  offset: Promise<number>
  /** A check is waiting on the clock; another asked meanwhile runs after it, so two can't fire the same stage. */
  checking: boolean
  again: boolean
}

const freshGuard = (defaults: Limits): Guard => ({
  defaults, host: null, state: null, baseUsd: null, sessionUsd: null, nextBudget: null, nextRecord: false, timer: null, offset: Promise.resolve(0), checking: false, again: false,
})
/** Module state; a hot reload starts it over (and may warn once more about an agent it had already warned about). */
let g: Guard = freshGuard(limitsFrom({}))

function hostOf($: EngineInterface): GuardHost {
  return {
    now: () => $.clock.now(),
    every: (ms, fn) => $.clock.every(ms, fn),
    toast: text => {
      try {
        $.ui.toast(text, { timeoutMs: TOAST_MS })
      } catch {
        // No toast stack (a headless session): the event in the log says it.
      }
    },
    sendTo: (agentId, text) => $.session.send({ to: { agentId }, text }),
    tellMain: text => $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } }),
    record: body => record($, body),
  }
}

const limits = (): Limits => (g.state === null ? g.defaults : effective(g.defaults, g.state))
const cost = (): number => (g.state === null ? 0 : swarmCost(g.state, g.baseUsd))
const nameOf = (id: string): string => g.state?.agents[id]?.name ?? id

/** Applies one event to the guard's own state, as the fold would; the swarm id is the state's. */
function apply(body: RecordBody, ts: string): void {
  if (g.state === null) return
  fold(g.state, makeEvent({ type: body.type, swarm: g.state.swarm.id, src: 'recorder', data: body.data, ...(body.agent !== undefined && { agent: body.agent }), now: new Date(ts) }) as SwarmEvent)
}

/** A different swarm: start over from `baseUsd` (the session cost seen before its first event), carrying a pending init budget into it. */
function enter(swarm: string, baseUsd: number | null): void {
  g.state = emptyState(swarm)
  g.baseUsd = baseUsd
  if (g.nextBudget !== null) {
    const body: RecordBody = { type: 'budget.set', data: g.nextBudget }
    apply(body, new Date(Date.now()).toISOString())
    if (g.nextRecord) send(body)
    g.nextBudget = null
    g.nextRecord = false
  }
}

/** Ends the guard's swarm: nothing is timed or blocked until the next swarm's first event. */
function leave(): void {
  g.state = null
  g.nextBudget = null
  g.nextRecord = false
  syncTimer()
}

/** omnis_swarm_init named the running implicit swarm: the same swarm goes on, so its state stays and only the budget changes. */
function renamed(patch: BudgetPatch): void {
  if (g.state === null) {
    // Not seen yet: the budget waits for its first event. The server has recorded it, so the guard won't.
    g.nextBudget = patch
    g.nextRecord = false
    return
  }
  apply({ type: 'budget.set', data: patch }, new Date(Date.now()).toISOString())
  void check()
}

const running = (): boolean => g.state !== null && Object.values(g.state.agents).some(a => a.id !== LEAD && !a.placeholder && a.finishedAt === null)

/** The timer runs only while an agent is running, at most every TICK_MS. */
function syncTimer(): void {
  const want = g.host !== null && running()
  if (want && g.timer === null) g.timer = g.host!.every(TICK_MS, () => void check())
  if (!want && g.timer !== null) {
    g.timer.cancel()
    g.timer = null
  }
}

/** Records a guard event the check has already folded. */
function send(body: RecordBody): void {
  void g.host?.record(body).catch(() => undefined)
}

async function nudge(host: GuardHost, a: Extract<GuardAction, { kind: 'nudge' }>, lim: Limits): Promise<void> {
  const state = g.state
  // Taken now: an omnis_swarm_end during the send forgets the agents.
  const name = nameOf(a.agent)
  let delivered = false
  let reason: string | undefined
  try {
    const sent = await host.sendTo(a.agent, nudgeText(lim))
    delivered = sent.isDelivered
    reason = sent.isDelivered ? undefined : String(sent.reason ?? '').slice(0, 80)
  } catch (err) {
    reason = err instanceof Error ? err.message.slice(0, 80) : 'the send failed'
  }
  // The engine's reason is untrusted text: no control characters reach the log or the main conversation.
  const clean = reason === undefined || reason === '' ? undefined : reason.replace(/[\p{Cc}\p{Cf}]/gu, ' ')
  // Recorded only into the swarm it was sent in: after omnis_swarm_end a record would start a new implicit swarm.
  if (g.state !== null && g.state === state) void host.record({ type: 'guard.nudged', agent: a.agent, data: { limit: a.limit, value: a.value, threshold: a.threshold, delivered, ...(clean !== undefined && { reason: clean }) } }).catch(() => undefined)
  void host.tellMain(mainText(name, a, lim, delivered, clean)).catch(() => undefined)
}

/** The body each stage records. A nudge's own event waits for the send's answer, so it is folded as undelivered meanwhile. */
function bodyOf(a: GuardAction): RecordBody {
  if (a.kind === 'warn') return { type: 'guard.warned', agent: a.agent, data: { limit: a.limit, value: a.value, threshold: a.threshold } }
  if (a.kind === 'swarm-warn') return { type: 'guard.warned', data: { limit: 'swarmCost', value: a.value, threshold: a.threshold } }
  if (a.kind === 'block') return { type: 'guard.blocked', data: { value: a.value, threshold: a.threshold } }
  return { type: 'guard.nudged', agent: a.agent, data: { limit: a.limit, value: a.value, threshold: a.threshold, delivered: false } }
}

/** One evaluation: the clock is read, every stage is folded straight after, then acted on. A throw loses this check only. */
async function checkOnce(): Promise<void> {
  const host = g.host
  if (host === null || g.state === null) return
  try {
    const now = (await host.now()) - (await g.offset)
    if (g.host !== host || g.state === null) return
    const lim = limits()
    const actions = evaluate(g.state, lim, cost(), now)
    const ts = new Date(Date.now()).toISOString()
    for (const a of actions) apply(bodyOf(a), ts)
    for (const a of actions) {
      host.toast(toastText(a, a.kind === 'warn' || a.kind === 'nudge' ? nameOf(a.agent) : '', lim))
      if (a.kind === 'nudge') void nudge(host, a, lim)
      else send(bodyOf(a))
    }
  } catch {
    // Fail open.
  }
}

/** Runs one check at a time; a check asked for while one waits runs once more after it, on the newer state. */
async function check(): Promise<void> {
  if (g.checking) {
    g.again = true
    return
  }
  g.checking = true
  try {
    do {
      g.again = false
      await checkOnce()
    } while (g.again)
  } finally {
    g.checking = false
    syncTimer()
  }
}

/** The recorder's session.start ran: bind the host. A top-level function, so the validator lets $ reach it. */
export function guardStarted($: EngineInterface): void {
  g.timer?.cancel()
  g.timer = null
  const host = hostOf($)
  g.host = host
  // Read in a then, so a clock that throws at once gives offset 0 instead of throwing into the recorder.
  g.offset = Promise.resolve().then(host.now).then(t => t - Date.now(), () => 0)
  syncTimer()
}

export const guardObserver: RecordObserver = {
  recorded: (body, ts, swarm) => {
    // The guard's own events were folded when it sent them.
    if (body.type === 'guard.warned' || body.type === 'guard.nudged' || body.type === 'guard.blocked' || body.type === 'budget.set') return
    // A new swarm's base is the cost seen before this event, so a measure that opens the swarm still counts.
    const before = g.sessionUsd
    if (body.type === 'session.measure' && typeof body.data.costUsd === 'number') g.sessionUsd = body.data.costUsd
    if (g.state === null || g.state.swarm.id !== swarm) enter(swarm, before)
    apply(body, ts)
    if (body.type === 'agent.usage' || body.type === 'session.measure' || body.type === 'agent.started' || body.type === 'agent.finished') void check()
  },
}

export function guardView(): { limits: Limits; swarmUsd: number; swarm: string | null; pendingUsd: number | null } {
  return { limits: limits(), swarmUsd: cost(), swarm: g.state?.swarm.id ?? null, pendingUsd: g.state === null ? (g.nextBudget?.swarmUsd ?? null) : null }
}

/** The header's budget figures; null unless the guard's swarm is the one the pane shows. */
export function viewBudget(shownSwarm: string | null): ViewBudget | null {
  if (g.state === null || g.state.swarm.id !== shownSwarm) return null
  const lim = limits()
  const swarmUsd = cost()
  return { swarmUsd, limit: lim.swarmUsd, warn: warnLevel(lim, 'swarmUsd'), blocked: isBlocked(lim, swarmUsd) }
}

/**
 * /omnis budget <usd>: 'now' records budget.set and checks again (a raised limit lifts the block at once); 'next' keeps it
 * for the next swarm when none is running; null before the guard is bound. Stamped on the guard's clock, as the checks are.
 */
export async function setSwarmBudget(usd: number): Promise<'now' | 'next' | null> {
  const host = g.host
  if (host === null) return null
  const ts = new Date((await host.now()) - (await g.offset)).toISOString()
  if (g.host !== host) return null
  if (g.state === null) {
    g.nextBudget = { ...g.nextBudget, swarmUsd: usd }
    g.nextRecord = true
    return 'next'
  }
  const body: RecordBody = { type: 'budget.set', data: { swarmUsd: usd } }
  apply(body, ts)
  send(body)
  void check()
  return 'now'
}

/** A tool reply's text: core's joined text blocks, else the text blocks of an MCP result a hook answered with. */
function replyText(result: { text?: unknown; result?: unknown }): string {
  if (typeof result.text === 'string') return result.text
  const content = (result.result as { content?: unknown } | undefined)?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(b => (typeof b === 'object' && b !== null && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('')
}

const failed = (result: { isError?: boolean; deny?: unknown }): boolean => result.isError === true || result.deny !== undefined

export function registerBudgetGuard(on: On, options: PluginOptions): void {
  g.timer?.cancel()
  g = freshGuard(limitsFrom(options))

  // Matched: guard.ts holds the one unmatched tool.check. Only the lead's real Agent calls are refused.
  on('tool.check', { tool: 'Agent' }, ($, e, next) =>
    e.agentId === undefined && e.tool_use_id !== undefined && g.state !== null && isBlocked(limits(), cost())
      ? { decision: 'deny' as const, reason: blockReason(limits()) }
      : next(e),
  ).catch((_$, e, next) => next(e))

  // A swarm boundary: init may carry a budget; end lets the block go.
  on('tool.call', { tool: [SWARM_INIT_TOOL, SWARM_END_TOOL] }, async ($, e, next) => {
    const result = await next(e)
    try {
      if (!failed(result)) {
        if (SWARM_END_TOOL.test(String(e.tool))) leave()
        else {
          const parsed = parseBudget((e as unknown as { budget?: unknown }).budget)
          const reply = replyText(result)
          if (STARTED_REPLY.test(reply)) {
            leave()
            if (parsed.ok) g.nextBudget = parsed.patch
          } else if (RENAMED_REPLY.test(reply) && parsed.ok) renamed(parsed.patch)
        }
      }
    } catch {
      // The guard keeps its last state.
    }
    return result
  }).catch((_$, e, next) => next(e))
}
