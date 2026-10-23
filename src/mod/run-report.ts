/**
 * The run report's mod side (spec section 4): asks the server for a report when a run goes quiet (no subagent running
 * for QUIET_AFTER_MS after at least one ran since the last report), and on /omnis report. The lead gets the pointer.
 * A swarm that ends writes its own report, so a successful omnis_swarm_end calls the quiet one off.
 */
import type { EngineInterface, On, Timer } from 'claude-code'
import { REPORT_TOOL } from '../core/recording.ts'
import type { Sub } from './commands.ts'
import { connectServer } from './server.ts'
import { TURN_ENDS } from './turn-ends.ts'

export const QUIET_AFTER_MS = 30_000
const SWARM_END_TOOL = /^mcp__.+__omnis_swarm_end$/
const USAGE = 'Usage: /omnis report writes a report of the current swarm.'

export const reportSub: Sub = {
  name: 'report',
  describe: '/omnis report writes a report of the current swarm',
  hint: 'report',
  usage: USAGE,
}

/** Module state; a hot reload forgets the running subagents, so the next run's report waits for its first spawn. */
const run = { live: new Set<string>(), ranSinceReport: false, timer: null as Timer | null }

/**
 * The server's reply text and whether it is an error, or null when the call failed. `quiet`: the server writes only when
 * a subagent has worked since the last report, and answers an error otherwise.
 */
async function askReport($: EngineInterface, quiet: boolean): Promise<{ text: string; isError: boolean } | null> {
  // Cleared before the call, so a spawn while it is in flight is kept; put back when no report was written.
  const had = run.ranSinceReport
  run.ranSinceReport = false
  try {
    const server = await connectServer($)
    if (server === null) {
      run.ranSinceReport ||= had
      return null
    }
    const result = await $.mcp.call(server, REPORT_TOOL, quiet ? { quiet: true } : {})
    const block = result.content[0]
    const text = block !== undefined && block.type === 'text' && typeof block.text === 'string' ? block.text.slice(0, 300) : ''
    if (result.isError === true) run.ranSinceReport ||= had
    return { text, isError: result.isError === true }
  } catch {
    run.ranSinceReport ||= had
    return null
  }
}

async function quiet($: EngineInterface): Promise<void> {
  run.timer = null
  if (run.live.size > 0 || !run.ranSinceReport) return
  const reply = await askReport($, true)
  if (reply === null || reply.isError || reply.text === '') return
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: reply.text }] } })
}

function cancelQuiet(): void {
  run.timer?.cancel()
  run.timer = null
}

/** `words` are the lower-cased words after /omnis, "report" first. */
export async function reportCommand($: EngineInterface, words: readonly string[]): Promise<string | null> {
  if (words.length !== 1) return USAGE
  const reply = await askReport($, false)
  if (reply === null) return 'The swarm server is not connected yet; try again in a moment.'
  return reply.isError ? `No report was written: ${reply.text}` : reply.text
}

/** A subagent's turn ended. Never throws. */
export function runAgentEnded($: EngineInterface, agentId: string): void {
  try {
    if (run.live.delete(agentId) && run.live.size === 0 && run.ranSinceReport && run.timer === null) {
      run.timer = $.clock.after(QUIET_AFTER_MS, () => void quiet($).catch(() => undefined))
    }
  } catch {
    // A missed end costs at most one report.
  }
}

export function registerRunReport(on: On): void {
  cancelQuiet()
  run.live.clear()
  run.ranSinceReport = false

  // A matcher that takes every spawn: the validator refuses a second unmatched hook on an event the recorder also hooks.
  on('agent.spawn', { background: [true, false] }, async ($, e, next) => {
    const result = await next(e)
    try {
      const id = result.deny === undefined ? result.agentId : undefined
      if (typeof id === 'string') {
        run.live.add(id)
        run.ranSinceReport = true
        cancelQuiet()
      }
    } catch {
      // A missed spawn costs at most one report.
    }
    return result
  }).catch((_$, e, next) => next(e))

  // Observe-only: the end call's result goes back unchanged.
  on('tool.call', { tool: SWARM_END_TOOL }, async ($, e, next) => {
    const result = await next(e)
    try {
      if (result.isError !== true && result.deny === undefined) {
        cancelQuiet()
        run.ranSinceReport = false
      }
    } catch {
      // A missed end costs at most one near-empty report, which the server skips anyway.
    }
    return result
  }).catch((_$, e, next) => next(e))

  on('turn.complete', { reason: TURN_ENDS }, async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) runAgentEnded($, e.agentId)
    return result
  })
}
