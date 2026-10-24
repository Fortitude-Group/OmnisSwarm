/**
 * Turns Claude Code hook inputs into the event bodies the recorder sends to omnis_record.
 * Pure and mod-safe, and it imports nothing from 'claude-code', so node:test covers it too.
 */
import { LIMITS, NAME, isSafeKey, type AgentOutcome, type EventData, type ToolKind } from '../core/events.ts'
import { LEAD } from '../core/fold.ts'
import { sameModel } from '../core/prices.ts'
import type { RecordBody } from '../core/recording.ts'

export type Fields = Readonly<Record<string, unknown>>
export type SpawnFacts = { name?: string; subagentType?: string; description?: string; parentAgentId?: string }
export type StepUsage = {
  input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; model: string
}
export type Measure = { context: { tokens?: number; window: number; percent?: number }; cost?: { usd: number }; changed: readonly string[] }

const CONTROL = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu
const MAX_TOKENS = 1e12
/** The server refuses per-call usage counts above this, so the builder clamps to it. */
const MAX_USAGE = 1e9

/** Hook payloads are untrusted: anything that isn't a plain object reads as an empty one. */
const isObj = (x: unknown): Fields => (typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Fields) : {})

/** Input is cut to a bounded slice before any scan, so a huge payload costs about the same as a small one. */
const room = (max: number): number => max * 4 + 64

/** Joins code points while they fit in `room` UTF-16 units, so a surrogate pair is never split. */
function fit(chars: readonly string[], limit: number): string {
  let out = ''
  for (const c of chars) {
    if (out.length + c.length > limit) break
    out += c
  }
  return out
}

/** Control and format characters become spaces, whitespace runs collapse, and the result is cut to `max` UTF-16 units, ending in an ellipsis when cut. */
export function cleanText(x: unknown, max: number): string {
  if (typeof x !== 'string') return ''
  const flat = x.slice(0, room(max)).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${fit(Array.from(flat), max - 1)}…`
}

/** As cleanText, but a long path keeps its end, the part that tells files apart. */
export function cleanPath(x: unknown, max: number): string {
  if (typeof x !== 'string') return ''
  const flat = x.slice(-room(max)).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const tail = fit(Array.from(flat).reverse(), max - 1)
  return `…${Array.from(tail).reverse().join('')}`
}

/** The same rule as memory previews in src/mcp/tools.ts (which a mod can't import), plus URL credentials and key=value pairs. */
export const SECRETISH = /(ghp_|gho_|github_pat_|sk-|sk_live_|xox[bap]-|AKIA)[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_.-]+|[A-Za-z0-9+/=_-]{32,}/g
const URL_CREDS = /\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@:]+:[^\s/@]+@/gi
const KEY_VALUE = /(token|key|secret|password|passwd|pwd)=[^\s&"']+/gi
const DASH_P = /(\s-p)\S+/g
const REDACT_ROOM = 4096

export function redact(x: unknown): string {
  if (typeof x !== 'string') return ''
  return x
    .slice(0, REDACT_ROOM)
    .replace(URL_CREDS, '$1[redacted]@')
    .replace(KEY_VALUE, '$1=[redacted]')
    .replace(DASH_P, '$1[redacted]')
    .replace(SECRETISH, '[redacted]')
}

/** Clean, then redact, then cut. Format characters are removed rather than spaced, so a zero-width-split token still matches. */
function cleanRedacted(x: unknown, max: number): string {
  if (typeof x !== 'string') return ''
  const joined = x.slice(0, room(max)).replace(/\s/g, ' ').replace(CONTROL, '')
  return cleanText(redact(joined), max)
}

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
export function toolSubject(tool: string, rawArgs: Fields): string {
  const args = isObj(rawArgs)
  const max = LIMITS.subject
  switch (toolKind(tool)) {
    case 'read':
    case 'edit':
      return cleanPath(args.file_path ?? args.notebook_path, max)
    case 'bash':
      return cleanRedacted(args.command, max)
    case 'search':
      return cleanRedacted(args.pattern ?? args.path, max)
    case 'web':
      return cleanRedacted(args.url ?? args.query, max)
    case 'agent':
      return cleanText(args.description ?? args.to ?? args.name, max)
    default:
      return ''
  }
}

const agentId = (x: unknown): string | null => (typeof x === 'string' && NAME.test(x) && isSafeKey(x) ? x : null)
const tokens = (x: unknown, max = MAX_TOKENS): number => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? Math.min(Math.floor(x), max) : 0)

/** Who an event belongs to: the lead when the engine gave no agent id, the agent when the recorder saw it spawn, otherwise nobody (an engine fork). */
export function whoOf(id: unknown, seen: ReadonlySet<string>): string | null {
  if (id === undefined) return LEAD
  return typeof id === 'string' && seen.has(id) ? id : null
}

export function agentStarted(rawSpawn: SpawnFacts, id: string): RecordBody<'agent.started'> | null {
  const spawn = isObj(rawSpawn) as SpawnFacts
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

/**
 * turn.step doesn't split cache writes by lifetime, so all of them go in the 5-minute bucket (spec section 7).
 * `requested` is the model the step's request named. It is kept only when the answer came from another model, which
 * means a gateway such as OmnisRouter routed the call.
 */
export function agentUsage(rawUsage: StepUsage, agent: string, rawRequested?: unknown): RecordBody<'agent.usage'> {
  const usage = isObj(rawUsage) as Partial<StepUsage>
  const model = cleanText(usage.model, 80)
  const requested = cleanText(rawRequested, 80)
  const routed = model !== '' && requested !== '' && !sameModel(requested, model)
  return {
    type: 'agent.usage',
    agent,
    data: {
      model,
      input: tokens(usage.input_tokens, MAX_USAGE),
      output: tokens(usage.output_tokens, MAX_USAGE),
      cacheRead: tokens(usage.cache_read_input_tokens, MAX_USAGE),
      cacheWrite5m: tokens(usage.cache_creation_input_tokens, MAX_USAGE),
      cacheWrite1h: 0,
      ...(routed && { requested }),
    },
  }
}

/** The longest error text the mod sends. The server cleans, redacts and clips again before it writes (src/mcp/tools/record.ts). */
const MAX_ERROR = 160

/** The first text block of an MCP-style result's content, or null. */
function firstText(content: unknown): string | null {
  if (!Array.isArray(content)) return null
  for (const block of content.slice(0, 16)) {
    const b = isObj(block)
    if (b.type === 'text' && typeof b.text === 'string') return b.text
  }
  return null
}

/**
 * Why a call failed, from the tool's own result or the reason a hook refused it, cleaned, redacted and clipped. Empty
 * when there is nothing to say. Only this slice of the result is kept: never the whole result or its input.
 */
export function failureText(raw: { isError?: unknown; deny?: unknown; result?: unknown; text?: unknown }): string {
  const result = isObj(raw)
  if (typeof result.deny === 'string') return cleanRedacted(result.deny, MAX_ERROR)
  const inner = result.result
  const block = firstText(isObj(inner).content)
  const said = block ?? (typeof result.text === 'string' ? result.text : typeof inner === 'string' ? inner : '')
  return cleanRedacted(said, MAX_ERROR)
}

export function toolEvent(phase: 'start' | 'end', tool: string, args: Fields, agent: string, isError = false, error = ''): RecordBody<'agent.tool'> {
  return {
    type: 'agent.tool',
    agent,
    data: {
      phase, tool: cleanText(tool, 80) || 'unknown', kind: toolKind(tool), subject: toolSubject(tool, args), isError,
      ...(phase === 'end' && isError && error !== '' && { error }),
    },
  }
}

/** A delivered plain-text message, from session.send. A plugin's `{ agentId }` address is read too; a `{ sessionId }` one is not an agent. */
export function messageSent(to: unknown, text: unknown, agent: string): RecordBody<'message.sent'> | null {
  const address = typeof to === 'object' && to !== null && typeof (to as Fields).agentId === 'string' ? (to as Fields).agentId : to
  const name = cleanText(address, 64)
  if (name === '') return null
  return { type: 'message.sent', agent, data: { to: name, summary: cleanRedacted(text, LIMITS.summary) } }
}

/** Only these protocol types are named in a summary; any other string is attacker text and becomes `protocol`. */
const PROTOCOL_TYPES: readonly string[] = ['shutdown_request', 'shutdown_response', 'plan_approval_response']

/** A protocol SendMessage (`message` an object), from tool.call: the type and approval only, never reason or feedback text. */
export function protocolMessage(rawArgs: Fields, agent: string): RecordBody<'message.sent'> | null {
  const args = isObj(rawArgs)
  const message = args.message
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return null
  const fields = message as Fields
  const to = cleanText(args.to, 64)
  if (to === '') return null
  const kind = typeof fields.type === 'string' && PROTOCOL_TYPES.includes(fields.type) ? fields.type : 'protocol'
  const approve = typeof fields.approve === 'boolean' ? ` approve: ${fields.approve ? 'yes' : 'no'}` : ''
  return { type: 'message.sent', agent, data: { to, summary: `[${kind}]${approve}` } }
}

export function sessionMeasure(raw: Measure): RecordBody<'session.measure'> | null {
  const m = isObj(raw)
  const changed = Array.isArray(m.changed) ? (m.changed as readonly unknown[]) : []
  if (!changed.includes('context') && !changed.includes('cost')) return null
  const context = isObj(m.context)
  const data: EventData['session.measure'] = { contextWindow: tokens(context.window) }
  if (typeof context.tokens === 'number') data.contextTokens = tokens(context.tokens)
  if (typeof context.percent === 'number') data.contextPercent = Math.min(100, tokens(context.percent))
  const usd = isObj(m.cost).usd
  if (typeof usd === 'number' && Number.isFinite(usd) && usd >= 0) data.costUsd = usd
  return { type: 'session.measure', data }
}
