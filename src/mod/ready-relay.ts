/**
 * Tells the lead what a subagent's close unblocked (spec 2.3). The server's reply to omnis_task_update goes to the
 * subagent, so when a subagent's successful call carries a "Now ready:" line, that line is appended to main. Observe-only:
 * the reply passes through unchanged, and any failure here is ignored.
 */
import type { On } from 'claude-code'
import { agentLabel } from './agent-name.ts'

const TASK_UPDATE = /^mcp__.+__omnis_task_update$/
const TASK_ID = /^t[0-9]{1,6}$/
const READY_LINE = /^Now ready: .+$/m
const MAX_LINE = 600

/** A tool reply's text: core's joined text blocks, else the text blocks of an MCP result a hook answered with. */
function replyText(result: { text?: unknown; result?: unknown }): string {
  if (typeof result.text === 'string') return result.text
  const content = (result.result as { content?: unknown } | undefined)?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(b => (typeof b === 'object' && b !== null && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('\n')
}

export function registerReadyRelay(on: On): void {
  on('tool.call', { tool: TASK_UPDATE }, async ($, e, next) => {
    const result = await next(e)
    try {
      const agent = e.agentId
      if (agent === undefined || result.isError === true || result.deny !== undefined) return result
      const line = READY_LINE.exec(replyText(result))?.[0]
      if (line === undefined) return result
      const raw = e as unknown as { id?: unknown; input?: { id?: unknown } }
      const id = raw.input?.id ?? raw.id
      if (typeof id !== 'string' || !TASK_ID.test(id)) return result
      const name = await agentLabel($, agent)
      const text = `[OmnisSwarm] ${name} closed ${id}. ${line.slice(0, MAX_LINE)}`
      await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } }).catch(() => undefined)
    } catch {
      // Observe-only: a missed relay costs the lead one line.
    }
    return result
  }).catch((_$, e, next) => next(e))
}
