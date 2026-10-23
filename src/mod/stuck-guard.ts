/**
 * The stuck guard (spec section 3): watches each subagent's tool calls, and when one fails five times in a row or runs
 * the same thing four times with no edit going ahead in between, asks it once to step back, tells the lead and records
 * agent.stuck.
 * Observe-only: every hook calls next once and returns its result unchanged.
 */
import type { EngineInterface, On } from 'claude-code'
import type { ToolKind } from '../core/events.ts'
import { INTERNAL_TOOL } from '../core/recording.ts'
import { agentLabel } from './agent-name.ts'
import { cleanText, toolKind, toolSubject, type Fields } from './record-events.ts'
import { record } from './recorder.ts'
import { StuckWatch, nudgeFor, stuckMainText, type StuckHit } from './stuck.ts'
import { TURN_ENDS } from './turn-ends.ts'

/** Module state; a hot reload starts every count over. */
let watch = new StuckWatch()

async function nudge($: EngineInterface, agentId: string, hit: StuckHit): Promise<void> {
  const name = await agentLabel($, agentId)
  let delivered = false
  let reason: string | undefined
  try {
    const sent = await $.session.send({ to: { agentId }, text: nudgeFor(hit) })
    delivered = sent.isDelivered
    reason = sent.isDelivered ? undefined : cleanText(String(sent.reason ?? ''), 80) || undefined
  } catch (err) {
    reason = cleanText(err instanceof Error ? err.message : 'the send failed', 80) || undefined
  }
  void record($, { type: 'agent.stuck', agent: agentId, data: { pattern: hit.pattern, count: hit.count, subject: hit.subject, delivered, ...(reason !== undefined && { reason }) } })
  void $.session.append({ message: { type: 'user', content: [{ type: 'text', text: stuckMainText(name, hit.pattern, delivered, reason) }] } }).catch(() => undefined)
}

/** A subagent's turn ended: its counts start over. */
export function stuckAgentEnded(agentId: string): void {
  watch.forget(agentId)
}

export function registerStuckGuard(on: On): void {
  watch = new StuckWatch()

  // A matcher (subagent calls only) keeps this apart from the recorder's unmatched tool.call hook, which the validator refuses to see twice.
  on('tool.call', { agentId: /./ }, async ($, e, next) => {
    const agent = e.agentId
    const tool = cleanText(String(e.tool), 80)
    const watched = typeof agent === 'string' && tool !== '' && !INTERNAL_TOOL.test(tool)
    let subject = ''
    let kind: ToolKind = 'other'
    if (watched) {
      try {
        subject = toolSubject(tool, e as unknown as Fields)
        kind = toolKind(tool)
        const hit = watch.start(agent, tool, kind, subject)
        if (hit !== null) void nudge($, agent, hit).catch(() => undefined)
      } catch {
        // A miscount costs a nudge, never the call.
      }
    }
    const result = await next(e)
    if (watched) {
      try {
        const hit = watch.end(agent, tool, kind, subject, result.isError === true || result.deny !== undefined)
        if (hit !== null) void nudge($, agent, hit).catch(() => undefined)
      } catch {
        // As above.
      }
    }
    return result
  }).catch((_$, e, next) => next(e))

  on('turn.complete', { reason: TURN_ENDS }, async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) stuckAgentEnded(e.agentId)
    return result
  })
}
