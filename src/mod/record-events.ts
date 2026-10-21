/**
 * Turns Claude Code hook inputs into the event bodies the recorder sends to omnis_record.
 * Pure and mod-safe, and it imports nothing from 'claude-code', so node:test covers it too.
 */
import { LIMITS, NAME, type AgentOutcome, type EventData, type ToolKind } from '../core/events.ts'
import { LEAD } from '../core/fold.ts'
import type { RecordBody } from '../core/recording.ts'

export type Fields = Readonly<Record<string, unknown>>
export type SpawnFacts = { name?: string; subagentType?: string; description?: string; parentAgentId?: string }
export type StepUsage = {
  input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; model: string
}
export type Measure = { context: { tokens?: number; window: number; percent?: number }; cost?: { usd: number }; changed: readonly string[] }

const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu
const MAX_TOKENS = 1e12

/** Joins code points while they fit in `room` UTF-16 units, so a surrogate pair is never split. */
function fit(chars: readonly string[], room: number): string {
  let out = ''
  for (const c of chars) {
    if (out.length + c.length > room) break
    out += c
  }
  return out
}

/** Control and format characters become spaces, whitespace runs collapse, and the result is cut to `max` UTF-16 units, ending in an ellipsis when cut. */
export function cleanText(x: unknown, max: number): string {
  if (typeof x !== 'string') return ''
  const flat = x.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${fit(Array.from(flat), max - 1)}…`
}

/** As cleanText, but a long path keeps its end, the part that tells files apart. */
export function cleanPath(x: unknown, max: number): string {
  const flat = cleanText(x, Number.MAX_SAFE_INTEGER)
  if (flat.length <= max) return flat
  const tail = fit(Array.from(flat).reverse(), max - 1)
  return `…${Array.from(tail).reverse().join('')}`
}

/** The same rule as memory previews in src/mcp/tools.ts (which a mod can't import): token-shaped runs are blanked. */
const SECRETISH = /(ghp_|gho_|github_pat_|sk-|sk_live_|xox[bap]-|AKIA)[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_.-]+|[A-Za-z0-9+/=_-]{32,}/g

export const redact = (x: unknown): string => (typeof x === 'string' ? x.replace(SECRETISH, '[redacted]') : '')

const KINDS: Readonly<Record<string, ToolKind>> = {
  Read: 'read', NotebookRead: 'read',
  Edit: 'edit', MultiEdit: 'edit', Write: 'edit', NotebookEdit: 'edit',
  Bash: 'bash', PowerShell: 'bash', BashOutput: 'bash', KillShell: 'bash',
  Glob: 'search', Grep: 'search', LS: 'search',
  WebFetch: 'web', WebSearch: 'web',
  Agent: 'agent', Task: 'agent', SendMessage: 'agent',
}

export const toolKind = (tool: string): ToolKind => (Object.hasOwn(KINDS, tool) ? KINDS[tool]! : 'other')

/** The path or command a tool call is about, at most LIMITS.subject characters. Never arguments that hold content. */
export function toolSubject(tool: string, args: Fields): string {
  const max = LIMITS.subject
  switch (toolKind(tool)) {
    case 'read':
    case 'edit':
      return cleanPath(args.file_path ?? args.notebook_path, max)
    case 'bash':
      return cleanText(redact(args.command), max)
    case 'search':
      return cleanText(args.pattern ?? args.path, max)
    case 'web':
      return cleanText(redact(args.url ?? args.query), max)
    case 'agent':
      return cleanText(args.description ?? args.to ?? args.name, max)
    default:
      return ''
  }
}

const agentId = (x: unknown): string | null => (typeof x === 'string' && NAME.test(x) ? x : null)
const tokens = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? Math.min(Math.floor(x), MAX_TOKENS) : 0)

/** Who an event belongs to: the lead when the engine gave no agent id, the agent when the recorder saw it spawn, otherwise nobody (an engine fork). */
export function whoOf(id: unknown, seen: ReadonlySet<string>): string | null {
  if (id === undefined) return LEAD
  return typeof id === 'string' && seen.has(id) ? id : null
}

export function agentStarted(spawn: SpawnFacts, id: string): RecordBody<'agent.started'> | null {
  const agent = agentId(id)
  if (agent === null || agent === LEAD) return null
  return {
    type: 'agent.started',
    agent,
    data: {
      name: cleanText(spawn.name, 64),
      role: cleanText(spawn.subagentType, 64) || 'agent',
      description: cleanText(spawn.description, LIMITS.description),
      parent: agentId(spawn.parentAgentId) ?? LEAD,
    },
  }
}

const OUTCOMES: Readonly<Record<string, AgentOutcome>> = { answer: 'answer', aborted: 'aborted', refusal: 'failed', error: 'failed' }

export function agentFinished(reason: string, agent: string): RecordBody<'agent.finished'> {
  const outcome = Object.hasOwn(OUTCOMES, reason) ? OUTCOMES[reason]! : 'failed'
  return { type: 'agent.finished', agent, data: { outcome, reason: cleanText(reason, LIMITS.reason) } }
}

/** turn.step doesn't split cache writes by lifetime, so all of them go in the 5-minute bucket (spec section 7). */
export function agentUsage(usage: StepUsage, agent: string): RecordBody<'agent.usage'> {
  return {
    type: 'agent.usage',
    agent,
    data: {
      model: cleanText(usage.model, 80),
      input: tokens(usage.input_tokens),
      output: tokens(usage.output_tokens),
      cacheRead: tokens(usage.cache_read_input_tokens),
      cacheWrite5m: tokens(usage.cache_creation_input_tokens),
      cacheWrite1h: 0,
    },
  }
}

export function toolEvent(phase: 'start' | 'end', tool: string, args: Fields, agent: string, isError = false): RecordBody<'agent.tool'> {
  return {
    type: 'agent.tool',
    agent,
    data: { phase, tool: cleanText(tool, 80) || 'unknown', kind: toolKind(tool), subject: toolSubject(tool, args), isError },
  }
}

/** A delivered plain-text message, from session.send. A plugin's `{ agentId }` address is read too; a `{ sessionId }` one is not an agent. */
export function messageSent(to: unknown, text: unknown, agent: string): RecordBody<'message.sent'> | null {
  const address = typeof to === 'object' && to !== null && typeof (to as Fields).agentId === 'string' ? (to as Fields).agentId : to
  const name = cleanText(address, 64)
  if (name === '') return null
  return { type: 'message.sent', agent, data: { to: name, summary: cleanText(redact(text), LIMITS.summary) } }
}

/** A protocol SendMessage (`message` an object), from tool.call: the type and approval only, never reason or feedback text. */
export function protocolMessage(args: Fields, agent: string): RecordBody<'message.sent'> | null {
  const message = args.message
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return null
  const fields = message as Fields
  const to = cleanText(args.to, 64)
  if (to === '') return null
  const kind = cleanText(fields.type, 40) || 'protocol'
  const approve = typeof fields.approve === 'boolean' ? ` approve: ${fields.approve ? 'yes' : 'no'}` : ''
  return { type: 'message.sent', agent, data: { to, summary: `[${kind}]${approve}` } }
}

export function sessionMeasure(m: Measure): RecordBody<'session.measure'> | null {
  if (!m.changed.includes('context') && !m.changed.includes('cost')) return null
  const data: EventData['session.measure'] = { contextWindow: tokens(m.context.window) }
  if (typeof m.context.tokens === 'number') data.contextTokens = tokens(m.context.tokens)
  if (typeof m.context.percent === 'number') data.contextPercent = Math.min(100, tokens(m.context.percent))
  const usd = m.cost?.usd
  if (typeof usd === 'number' && Number.isFinite(usd) && usd >= 0) data.costUsd = usd
  return { type: 'session.measure', data }
}
