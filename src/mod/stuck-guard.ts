/**
 * The stuck guard (spec section 3): watches each subagent's tool calls, and when one fails five times in a row or runs
 * the same thing four times with no edit going ahead in between, asks it once to step back, tells the lead and records
 * agent.stuck. Hit again in the same run, or finishing while still stuck, it also asks the server for handoff notes
 * (omnis_handoff) and tells the lead where they are. A slow or failing server only costs the notes.
 * Observe-only: every hook calls next once and returns its result unchanged.
 */
import type { EngineInterface, On } from 'claude-code'
import type { HandoffWhy, StuckPattern, ToolKind } from '../core/events.ts'
import { HANDOFF_TOOL, INTERNAL_TOOL } from '../core/recording.ts'
import { agentLabel } from './agent-name.ts'
import { cleanText, toolKind, toolSubject, type Fields } from './record-events.ts'
import { record } from './recorder.ts'
import { connectServer } from './server.ts'
import { HANDOFF_ASK_MS, StuckWatch, handoffMainText, noOpenTaskText, nudgeFor, parseNotes, stuckMainText, type StuckHit } from './stuck.ts'
import { TURN_ENDS } from './turn-ends.ts'

/** Module state; a hot reload starts every count over. */
let watch = new StuckWatch()

const tell = ($: EngineInterface, text: string): Promise<void> =>
  $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } }).then(() => undefined, () => undefined)

/** omnis_handoff's reply text for subagent `agent`, or null when the server fails, answers an error or takes over HANDOFF_ASK_MS. */
async function askHandoff($: EngineInterface, agent: string, why: Exclude<HandoffWhy, 'lead'>): Promise<string | null> {
  try {
    const server = await connectServer($)
    if (server === null) return null
    return await new Promise<string | null>(resolve => {
      const timer = $.clock.after(HANDOFF_ASK_MS, () => resolve(null))
      $.mcp.call(server, HANDOFF_TOOL, { agent, why }).then(
        result => {
          timer.cancel()
          const block = result.content[0]
          resolve(result.isError !== true && block !== undefined && block.type === 'text' && typeof block.text === 'string' ? block.text : null)
        },
        () => {
          timer.cancel()
          resolve(null)
        },
      )
    })
  } catch {
    return null
  }
}

/** Asks for the notes and tells the lead where they are. Nothing is said when the server fails: the worst case is a missing note. */
async function handOn($: EngineInterface, agentId: string, name: string, pattern: StuckPattern, why: Exclude<HandoffWhy, 'lead'>): Promise<void> {
  const text = await askHandoff($, agentId, why)
  const ids = text === null ? null : parseNotes(text)
  if (ids === null) return
  if (ids.length > 0) await tell($, handoffMainText(name, ids, pattern, why))
  else if (why === 'stuck') await tell($, noOpenTaskText(name, pattern))
}

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
  const recorded = record($, { type: 'agent.stuck', agent: agentId, data: { pattern: hit.pattern, count: hit.count, subject: hit.subject, delivered, ...(reason !== undefined && { reason }) } })
  if (hit.again !== true) {
    void tell($, stuckMainText(name, hit.pattern, delivered, reason))
    return
  }
  // Behind agent.stuck, so the note shows the nudge count that includes this hit.
  if (hit.handoff === true) {
    await recorded
    await handOn($, agentId, name, hit.pattern, 'stuck')
  }
}

/** A subagent's turn ended while one of its stuck patterns was still set: write its notes, once. */
async function finished($: EngineInterface, agentId: string, pattern: StuckPattern): Promise<void> {
  const name = await agentLabel($, agentId)
  await handOn($, agentId, name, pattern, 'finished')
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
    const agent = e.agentId
    if (agent !== undefined) {
      try {
        const pattern = watch.stillStuck(agent)
        if (pattern !== null) void finished($, agent, pattern).catch(() => undefined)
      } catch {
        // A missing note, never a failed turn.
      }
      stuckAgentEnded(agent)
    }
    return result
  })
}
