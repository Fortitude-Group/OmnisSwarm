/** /omnis export gif [swarm] (spec section 4): asks the server for a GIF and toasts its path when it is written. */
import type { EngineInterface } from 'claude-code'
import { isValidSwarmId } from '../core/events.ts'
import { EXPORT_TOOL, REPLAY_TOOL } from '../core/recording.ts'
import { parseReplayReply } from '../core/replay-reply.ts'
import type { Sub } from './commands.ts'
import type { Host } from './pane-runtime.ts'
import { hostOf, readStyle, rt } from './pane-runtime.ts'
import type { CallResult } from './pane-pull.ts'

const USAGE = 'Usage: /omnis export gif [swarm].'
const TOAST_MS = 12_000
/** A real export can take tens of seconds; past five minutes the server is taken to be stuck. */
export const EXPORT_TIMEOUT_MS = 5 * 60_000
const TIMEOUT_TEXT = `GIF export failed: the server did not answer in ${EXPORT_TIMEOUT_MS / 60_000} minutes.`
/** The probe for the most recent swarm id is a plain read of the log. */
const PROBE_TIMEOUT_MS = 15_000

/** The reply's whole text: a replay page is JSON of up to 40,000 bytes and must be parsed uncut. */
const fullText = (result: CallResult): string => {
  const block = result.content[0]
  return block !== undefined && block.type === 'text' && typeof block.text === 'string' ? block.text : ''
}
/** Short enough for a toast. */
const textOf = (result: CallResult): string => fullText(result).slice(0, 300)

/** One call raced against a timer: the result, 'timeout', or 'failed' when the call rejected. */
function callWithin(host: Host, ms: number, server: string, tool: string, args: Record<string, unknown>): Promise<CallResult | 'timeout' | 'failed'> {
  return new Promise(resolve => {
    const timer = host.after(ms, () => resolve('timeout'))
    host.call(server, tool, args).then(
      result => { timer.cancel(); resolve(result) },
      () => { timer.cancel(); resolve('failed') },
    )
  })
}

export const exportSub: Sub | null = {
  name: 'export',
  describe: '/omnis export gif [swarm] saves a GIF of a swarm',
  hint: 'export gif [swarm]',
  usage: USAGE,
}

/** `words` are the lower-cased words after /omnis, export first. */
export async function exportCommand($: EngineInterface, words: readonly string[]): Promise<string | null> {
  if (words[1] !== 'gif' || words.length > 3 || (words[2] !== undefined && !isValidSwarmId(words[2]))) return USAGE
  const host = rt.host ?? hostOf($)
  const server = rt.server ?? (await host.connect().catch(() => null))
  if (server === null) return 'The swarm server is not connected yet; try again in a moment.'
  let swarm = words[2] ?? null
  if (swarm === null) {
    const probe = await callWithin(host, PROBE_TIMEOUT_MS, server, REPLAY_TOOL, { since: 0 })
    if (probe === 'timeout') return 'The swarm server did not answer in time; try again in a moment.'
    if (probe === 'failed') return 'The swarm log could not be read.'
    const reply = probe.isError ? null : parseReplayReply(fullText(probe))
    if (reply === null) return 'The swarm log could not be read.'
    if (reply.kind === 'none') return 'No recorded swarm here yet.'
    swarm = reply.swarm
  }
  const style = await readStyle($)
  const name = swarm
  // Not awaited: the render takes seconds, and the answer comes as a toast.
  void callWithin(host, EXPORT_TIMEOUT_MS, server, EXPORT_TOOL, { swarm: name, style })
    .then(result => {
      if (result === 'timeout') return $.ui.toast(TIMEOUT_TEXT, { timeoutMs: TOAST_MS })
      if (result === 'failed') return $.ui.toast('GIF export failed: the server did not answer.', { timeoutMs: TOAST_MS })
      return $.ui.toast(result.isError ? `GIF export failed: ${textOf(result)}` : textOf(result) || 'GIF saved.', { timeoutMs: TOAST_MS })
    })
    .catch(() => undefined)
  return `Rendering ${name} to a GIF; the path follows when it is done.`
}
