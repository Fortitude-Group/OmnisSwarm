/**
 * The spawn hold (docs/superpowers/specs/2026-11-15-spawn-hold-design.md): when several agents of one type and model
 * start together, the first goes at once and the rest wait at agent.spawn until its first response starts, so they
 * read the prompt cache it wrote instead of each writing their own. Different types never wait on each other, and no
 * wait outlasts HOLD_MAX_MS. A wait is spent in omnis_wait calls, which the engine doesn't charge to the hook's 10 s
 * budget. Every failure lets the agent start.
 */
import type { EngineInterface, On, PluginOptions } from 'claude-code'
import { WAIT_TOOL } from '../core/recording.ts'
import { record } from './recorder.ts'
import { connectServer } from './server.ts'
import { SpawnHolds, holdSettingFrom, type HoldEnd, type HoldOutcome, type Ticket } from './spawn-holds.ts'
import { TURN_ENDS } from './turn-ends.ts'

/** How long each omnis_wait call asks for. A release ends the wait at once, so this only sets how often time-outs are checked. */
export const WAIT_MS = 1000
/** Without the server, the hold sleeps on its own budget in these steps, and lets go with BUDGET_SPARE_MS of it left. */
const FALLBACK_MS = 250
const BUDGET_SPARE_MS = 2500
/** And never sleeps longer than this in all, whatever the budget reads. */
const FALLBACK_MAX_MS = 7000
const ROLE_MAX = 64

/** Module state; a hot reload forgets every hold, which only costs a cache write. */
let holds = new SpawnHolds()

const keyOf = (type: string, model: string | undefined): string => `${type}\n${model ?? ''}`
const roleOf = (type: string): string => Array.from(type.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim()).slice(0, ROLE_MAX).join('') || 'unknown'

/** The clock, or null when it can't be read: the hold then stands aside. */
async function nowOf($: EngineInterface): Promise<number | null> {
  try {
    const t = await $.clock.now()
    return Number.isFinite(t) ? t : null
  } catch {
    return null
  }
}

function recordEnd($: EngineInterface, end: HoldEnd | null): void {
  if (end === null) return
  void record($, { type: 'spawn.held', data: { role: end.role, phase: 'end', count: end.count, ms: Math.round(end.ms), why: end.why } })
}

/**
 * Waits until the ticket is settled, the dispatch is aborted, or (without the server) the hook's own budget runs low.
 * Answers how the hold ended for this spawn, or null when it stopped waiting on its own.
 */
async function waitOut($: EngineInterface, t: Ticket, signal: AbortSignal, budget: { readonly remainingMs: number }): Promise<HoldOutcome | null> {
  const got: { o: HoldOutcome | null } = { o: null }
  const settled = t.done.then(o => {
    got.o = o
  })
  let server: string | null = null
  try {
    server = await connectServer($)
  } catch {
    server = null
  }
  let sleptSince: number | null = null
  while (got.o === null && !signal.aborted) {
    const now = await nowOf($)
    if (now === null) break
    for (const end of holds.expire(now)) recordEnd($, end)
    if (got.o !== null) break
    if (server !== null) {
      const ok = await Promise.race([
        $.mcp.call(server, WAIT_TOOL, { ms: WAIT_MS }).then(r => r.isError !== true, () => false),
        settled.then(() => true),
      ])
      if (!ok) server = null
    } else {
      sleptSince ??= now
      if (budget.remainingMs < BUDGET_SPARE_MS || now - sleptSince >= FALLBACK_MAX_MS) break
      await Promise.race([$.clock.sleep(FALLBACK_MS, { signal }).catch(() => undefined), settled])
    }
  }
  if (got.o === null) t.cancel()
  return got.o
}

export function registerSpawnHold(on: On, options: PluginOptions): void {
  holds = new SpawnHolds()
  if (holdSettingFrom((options as Readonly<Record<string, unknown>>).cacheHold) === 'off') return

  // A fork shares its parent's context, not its type's, so it is never held; the matcher also keeps this hook apart from
  // the recorder's unmatched one and the run report's.
  on('agent.spawn', { fork: false }, async ($, e, next) => {
    if (e.resume !== undefined || e.isTeammate === true) return next(e)
    const key = keyOf(e.subagentType, e.model)
    const arrived = await nowOf($)
    if (arrived === null) return next(e)
    const ends: HoldEnd[] = []
    const turn = holds.arrive(key, roleOf(e.subagentType), arrived, ends)
    for (const end of ends) recordEnd($, end)
    let lead = turn.kind === 'lead'
    if (turn.kind === 'hold') {
      if (turn.first) void record($, { type: 'spawn.held', data: { role: roleOf(e.subagentType), phase: 'start', count: 1, ms: 0 } })
      lead = (await waitOut($, turn, next.signal, next.budget)) === 'lead'
    }
    let id: string | null = null
    try {
      const result = await next(e)
      id = result.deny === undefined && typeof result.agentId === 'string' ? result.agentId : null
      return result
    } finally {
      // A leader that didn't start hands over to the longest-held sibling.
      if (lead) holds.started(key, id, (await nowOf($)) ?? arrived)
      else if (id !== null) holds.track(key, id)
    }
  }).catch((_$, e, next) => next(e))

  // The first chunk of a response from an agent its siblings wait on lets them go. Any other step keeps its group warm.
  on('turn.step', { agentId: /./ }, async function* ($, e, next) {
    const agent = e.agentId
    const stream = next(e)
    if (agent === undefined || !holds.tracks(agent)) return yield* stream
    if (!holds.awaited(agent)) {
      const now = await nowOf($)
      if (now !== null) holds.stepped(agent, now)
      return yield* stream
    }
    let told = false
    for await (const chunk of stream) {
      if (!told) {
        told = true
        const now = await nowOf($)
        if (now !== null) recordEnd($, holds.answered(agent, now))
      }
      yield chunk
    }
    return await stream.result
  })

  on('turn.complete', { reason: TURN_ENDS }, async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined && holds.tracks(e.agentId)) {
      // Without a clock the time limit still lets them go.
      const now = await nowOf($)
      if (now !== null) recordEnd($, holds.finished(e.agentId, now))
    }
    return result
  })
}
