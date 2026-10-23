/** The event contract every OmnisSwarm writer and reader shares. Pure: no I/O. */

export const SCHEMA_VERSION = 1

export const SOURCES = ['mcp', 'recorder', 'transcripts'] as const
export type Source = (typeof SOURCES)[number]

export const TOPOLOGIES = ['hierarchical', 'mesh', 'star'] as const
export type Topology = (typeof TOPOLOGIES)[number]

export const TASK_STATES = ['pending', 'active', 'done', 'failed'] as const
export type TaskState = (typeof TASK_STATES)[number]

export const TOOL_KINDS = ['read', 'edit', 'bash', 'search', 'web', 'agent', 'other'] as const
export type ToolKind = (typeof TOOL_KINDS)[number]

export const AGENT_OUTCOMES = ['answer', 'aborted', 'failed'] as const
export type AgentOutcome = (typeof AGENT_OUTCOMES)[number]

export const GUARD_LIMITS = ['time', 'agentCost', 'swarmCost'] as const
export type GuardLimit = (typeof GUARD_LIMITS)[number]
/** The highest each budget limit may be set to (spec section 2.3). Minutes, dollars, dollars. */
export const BUDGET_MAX = { agentMinutes: 1440, agentUsd: 1000, swarmUsd: 1000 } as const
export type BudgetKey = keyof typeof BUDGET_MAX
export const BUDGET_KEYS: readonly BudgetKey[] = ['agentMinutes', 'agentUsd', 'swarmUsd']
/** The bound on a guard event's value and threshold. */
export const GUARD_MAX = 1e6
export const STUCK_PATTERNS = ['failing', 'repeating'] as const
export type StuckPattern = (typeof STUCK_PATTERNS)[number]
/** How a clash was handled: refused, or let through with a warning to the lead. */
export const CLASH_MODES = ['block', 'warn'] as const
export type ClashMode = (typeof CLASH_MODES)[number]

export type EventData = {
  'swarm.started': { name: string; topology: Topology; goal?: string; implicit: boolean; session?: string }
  'swarm.ended': { outcome?: string }
  'agent.started': { name: string; role: string; description: string; parent: string }
  'agent.finished': { outcome: AgentOutcome; reason?: string }
  /** `requested`: the model the request named, only when a gateway (OmnisRouter) answered with another. */
  'agent.usage': { model: string; input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number; requested?: string }
  'agent.tool': { phase: 'start' | 'end'; tool: string; kind: ToolKind; subject: string; isError: boolean }
  'message.sent': { to: string; summary: string }
  'memory.put': { key: string; bytes: number; preview: string }
  'task.created': { id: string; title: string; assignee?: string; dependsOn?: string[] }
  'task.updated': { id: string; state: TaskState; assignee?: string; note?: string }
  'session.measure': { contextTokens?: number; contextWindow: number; contextPercent?: number; costUsd?: number }
  'budget.set': { agentMinutes?: number; agentUsd?: number; swarmUsd?: number }
  'guard.warned': { limit: GuardLimit; value: number; threshold: number }
  'guard.nudged': { limit: Exclude<GuardLimit, 'swarmCost'>; value: number; threshold: number; delivered: boolean; reason?: string }
  'guard.blocked': { value: number; threshold: number }
  /** agent: the refused (or warned) agent. path: the recorder's subject for the call. holder: the holding agent's id. */
  'clash.blocked': { path: string; holder: string; mode: ClashMode }
  /** agent: the stuck agent. subject: the last tool call's subject. */
  'agent.stuck': { pattern: StuckPattern; count: number; subject: string; delivered: boolean; reason?: string }
  /** path: the report file, relative to the project. */
  'report.written': { path: string; agents: number; minutes: number; costUsd: number }
}
export type EventType = keyof EventData

export const EVENT_TYPES = [
  'swarm.started', 'swarm.ended', 'agent.started', 'agent.finished', 'agent.usage',
  'agent.tool', 'message.sent', 'memory.put', 'task.created', 'task.updated',
  'session.measure', 'budget.set', 'guard.warned', 'guard.nudged', 'guard.blocked',
  'clash.blocked', 'agent.stuck', 'report.written',
] as const satisfies readonly EventType[]

export type SwarmEvent<K extends EventType = EventType> = {
  [T in K]: { v: number; ts: string; swarm: string; src: Source; type: T; agent?: string; data: EventData[T] }
}[K]

export const LIMITS = { line: 2048, summary: 200, subject: 80, description: 120, preview: 80, reason: 80 } as const

/** Collapses whitespace and cuts to `max` characters, ending in an ellipsis when cut. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

const SWARM_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/

/** Swarm ids become file names: lowercase, safe characters, no `..`, no Windows device names, no trailing dot. */
export const isValidSwarmId = (id: string): boolean =>
  SWARM_ID.test(id) && !id.includes('..') && !id.endsWith('.') && !RESERVED.test(id)

/** Agent, writer and assignee names as the tools accept them. */
export const NAME = /^[A-Za-z0-9._-]{1,64}$/

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** True for a string that is safe to use as a plain-object key. */
export const isSafeKey = (key: string): boolean => key !== '' && !UNSAFE_KEYS.has(key)

export const isOneOf = <T extends string>(values: readonly T[], x: unknown): x is T =>
  typeof x === 'string' && (values as readonly string[]).includes(x)

export function makeEvent<K extends EventType>(input: {
  type: K
  swarm: string
  src: Source
  data: EventData[K]
  agent?: string
  now?: Date
}): SwarmEvent<K> {
  const event = {
    v: SCHEMA_VERSION,
    ts: (input.now ?? new Date()).toISOString(),
    swarm: input.swarm,
    src: input.src,
    type: input.type,
    ...(input.agent !== undefined && { agent: input.agent }),
    data: input.data,
  }
  return event as SwarmEvent<K>
}

const encoder = new TextEncoder()

/** One log line, newline included. Throws RangeError past LIMITS.line bytes. */
export function serialise(event: SwarmEvent): string {
  const line = `${JSON.stringify(event)}\n`
  const bytes = encoder.encode(line).length
  if (bytes > LIMITS.line) throw new RangeError(`event line is ${bytes} bytes, the limit is ${LIMITS.line}`)
  return line
}

export type ParseResult = { ok: true; event: SwarmEvent } | { ok: false; reason: 'json' | 'shape' | 'version' }

/** Agent ids reach names and terminals, so no control, format or whitespace characters. */
const BAD_AGENT = /[\p{Cc}\p{Cf}\s]/u

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)

/** Checks the envelope only. `data` fields are checked defensively by `fold`. */
export function parseLine(line: string): ParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return { ok: false, reason: 'json' }
  }
  if (!isObj(raw) || typeof raw.v !== 'number' || !Number.isInteger(raw.v) || raw.v < 1) return { ok: false, reason: 'shape' }
  if (raw.v > SCHEMA_VERSION) return { ok: false, reason: 'version' }
  const shapeOk =
    typeof raw.ts === 'string' && !Number.isNaN(Date.parse(raw.ts)) &&
    typeof raw.swarm === 'string' && isValidSwarmId(raw.swarm) &&
    isOneOf(SOURCES, raw.src) &&
    isOneOf(EVENT_TYPES, raw.type) &&
    isObj(raw.data) &&
    (raw.agent === undefined || (typeof raw.agent === 'string' && raw.agent.length <= 64 && !BAD_AGENT.test(raw.agent)))
  return shapeOk ? { ok: true, event: raw as SwarmEvent } : { ok: false, reason: 'shape' }
}
