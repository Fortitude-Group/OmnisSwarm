/** Folds log events into SwarmState. Deterministic and free of I/O. `fold` mutates for speed. */
import {
  AGENT_OUTCOMES, TASK_STATES, TOOL_KINDS, TOPOLOGIES, isOneOf, isSafeKey,
  type AgentOutcome, type SwarmEvent, type TaskState, type ToolKind, type Topology,
} from './events.ts'
import { costOf, type Usage } from './prices.ts'

export const LEAD = 'lead'

/** Names that address the lead in message.sent. */
export const LEAD_ALIASES: readonly string[] = Object.freeze(['main', 'lead', 'team-lead'])

/** Memory keys the fold accepts. Anything else is skipped, never truncated. */
export const MEMORY_KEY = /^[A-Za-z0-9._/-]{1,128}$/

export const MAX_FEED = 200
export const MAX_FILES = 200
export const MAX_SAMPLES = 30
export const MAX_RECENT = 5
export const MAX_EDITS = 10
const SPEND_KEEP_MS = 600_000

export type UsageSample = { at: number; output: number; gapMs: number }

export type AgentState = {
  id: string
  name: string
  role: string
  description: string
  parent: string
  placeholder: boolean
  startedAt: number
  finishedAt: number | null
  runs: number
  activeMs: number
  outcome: AgentOutcome | null
  reason: string | null
  model: string | null
  tokens: Usage
  costUsd: number
  costKnown: boolean
  calls: number
  lastPrompt: number
  samples: UsageSample[]
  tools: Record<ToolKind, number>
  openTools: number
  errors: number
  errorsInRow: number
  files: string[]
  messagesIn: number
  messagesOut: number
  lastActivity: number
}

export type LinkState = { from: string; to: string; count: number; lastAt: number; recent: string[] }
export type MemoryEntry = { writer: string; at: number; bytes: number; preview: string }
export type TaskEntry = {
  id: string; title: string; state: TaskState; assignee: string | null; dependsOn: string[]
  createdAt: number; updatedAt: number; note: string | null
}
export type FeedItem = { at: number; kind: 'agent' | 'message' | 'memory' | 'task'; agent: string; text: string; to?: string }
export type SwarmInfo = {
  id: string; name: string; topology: Topology; goal: string | null; implicit: boolean
  startedAt: number | null; endedAt: number | null; outcome: string | null
}

export type SessionMeasure = {
  contextTokens: number | null
  contextWindow: number | null
  contextPercent: number | null
  costUsd: number | null
  at: number | null
}

export type SwarmState = {
  swarm: SwarmInfo
  session: SessionMeasure
  agents: Record<string, AgentState>
  byName: Record<string, string>
  links: Record<string, LinkState>
  memory: Record<string, MemoryEntry>
  tasks: Record<string, TaskEntry>
  feed: FeedItem[]
  edits: Record<string, { agent: string; at: number }[]>
  spend: { at: number; usd: number }[]
  events: number
  lastAt: number
  gaps: number
}

export function emptyState(id: string): SwarmState {
  return {
    swarm: { id, name: id, topology: 'hierarchical', goal: null, implicit: true, startedAt: null, endedAt: null, outcome: null },
    session: { contextTokens: null, contextWindow: null, contextPercent: null, costUsd: null, at: null },
    agents: {}, byName: {}, links: {}, memory: {}, tasks: {}, feed: [], edits: {}, spend: [],
    events: 0, lastAt: 0, gaps: 0,
  }
}

const zeroUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 })
const zeroTools = (): Record<ToolKind, number> => Object.fromEntries(TOOL_KINDS.map(k => [k, 0])) as Record<ToolKind, number>
const MAX_COUNT = 1e12
const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? Math.min(x, MAX_COUNT) : 0)
/**
 * Makes text safe to draw in a terminal: control and format/bidi characters become spaces, whitespace
 * runs collapse to one space, and the cut is by code point so a surrogate pair is never split.
 */
const text = (x: unknown, max: number): string =>
  typeof x === 'string'
    ? Array.from(x.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim()).slice(0, max).join('').trimEnd()
    : ''
const trim = <T>(list: T[], max: number): void => {
  while (list.length > max) list.shift()
}

function agentOf(state: SwarmState, id: string, at: number, name?: string): AgentState {
  const found = Object.hasOwn(state.agents, id) ? state.agents[id] : undefined
  if (found !== undefined) return found
  const created: AgentState = {
    id, name: name ?? id, role: id === LEAD ? 'lead' : 'unknown', description: '', parent: id === LEAD ? '' : LEAD,
    placeholder: false, startedAt: at, finishedAt: null, runs: 1, activeMs: 0, outcome: null, reason: null, model: null,
    tokens: zeroUsage(), costUsd: 0, costKnown: true, calls: 0, lastPrompt: 0, samples: [],
    tools: zeroTools(), openTools: 0, errors: 0, errorsInRow: 0, files: [], messagesIn: 0, messagesOut: 0,
    lastActivity: at,
  }
  state.agents[id] = created
  if (id === LEAD) state.byName[LEAD] = LEAD
  return created
}

/** SendMessage addresses agents by name; the graph is keyed by id. Unknown names get a placeholder node. */
function resolve(state: SwarmState, rawName: string, at: number): string {
  const stripped = rawName.replace(/\s+\[[^\]\s]+\]$/, '').trim()
  const name = isSafeKey(stripped) ? stripped : 'unknown'
  if (Object.hasOwn(state.agents, name)) return name
  if (LEAD_ALIASES.includes(name)) return agentOf(state, LEAD, at).id
  if (Object.hasOwn(state.byName, name)) return state.byName[name] as string
  const id = `?${name}`
  if (!Object.hasOwn(state.agents, id)) agentOf(state, id, at, name).placeholder = true
  return id
}

/** An agent.started or a tool start from an agent that had finished begins another run. Late usage does not. */
function revive(a: AgentState, at: number): void {
  if (a.outcome === null && a.finishedAt === null) return
  a.outcome = null
  a.reason = null
  a.finishedAt = null
  a.startedAt = at
  a.runs++
}

function feed(state: SwarmState, item: FeedItem): void {
  state.feed.push(item)
  trim(state.feed, MAX_FEED)
}

export function fold(state: SwarmState, e: SwarmEvent): SwarmState {
  const at = Date.parse(e.ts)
  if (Number.isNaN(at)) return state
  state.events++
  if (at > state.lastAt) state.lastAt = at
  if (state.swarm.startedAt === null) state.swarm.startedAt = at
  const who = e.agent !== undefined && isSafeKey(e.agent) ? e.agent : LEAD
  // Events the recorder had to drop since its last call that got through ride on its next event (spec section 6).
  if (e.src === 'recorder') state.gaps += num((e.data as { dropped?: unknown }).dropped)

  switch (e.type) {
    case 'swarm.started': {
      const d = e.data
      const name = text(d.name, 64)
      if (name !== '') state.swarm.name = name
      if (isOneOf(TOPOLOGIES, d.topology)) state.swarm.topology = d.topology
      if (typeof d.goal === 'string') state.swarm.goal = text(d.goal, 200) || null
      state.swarm.implicit = d.implicit === true
      break
    }
    case 'swarm.ended': {
      state.swarm.endedAt = at
      state.swarm.outcome = text(e.data.outcome, 200) || null
      break
    }
    case 'agent.started': {
      const d = e.data
      const a = agentOf(state, who, at)
      revive(a, at)
      a.name = text(d.name, 64) || a.name
      a.role = text(d.role, 64) || a.role
      a.description = text(d.description, 120)
      a.parent = text(d.parent, 64) || LEAD
      if (a.parent === a.id) a.parent = a.id === LEAD ? '' : LEAD
      a.placeholder = false
      a.lastActivity = at
      if (isSafeKey(a.name)) state.byName[a.name] = a.id
      feed(state, { at, kind: 'agent', agent: a.id, text: `${a.name} started` })
      break
    }
    case 'agent.finished': {
      const a = agentOf(state, who, at)
      if (a.finishedAt === null) a.activeMs += Math.max(0, at - a.startedAt)
      a.outcome = isOneOf(AGENT_OUTCOMES, e.data.outcome) ? e.data.outcome : 'failed'
      a.reason = text(e.data.reason, 80) || null
      a.finishedAt = at
      a.lastActivity = at
      feed(state, { at, kind: 'agent', agent: a.id, text: `${a.name} ${a.outcome === 'answer' ? 'finished' : a.outcome}` })
      break
    }
    case 'agent.usage': {
      const d = e.data
      const a = agentOf(state, who, at)
      const usage: Usage = {
        input: num(d.input), output: num(d.output), cacheRead: num(d.cacheRead),
        cacheWrite5m: num(d.cacheWrite5m), cacheWrite1h: num(d.cacheWrite1h),
      }
      const model = text(d.model, 80) || a.model
      if (model !== null && model !== '') a.model = model
      a.tokens.input += usage.input
      a.tokens.output += usage.output
      a.tokens.cacheRead += usage.cacheRead
      a.tokens.cacheWrite5m += usage.cacheWrite5m
      a.tokens.cacheWrite1h += usage.cacheWrite1h
      const usd = a.model === null ? null : costOf(a.model, usage)
      if (usd === null) {
        a.costKnown = false
      } else {
        a.costUsd += usd
        state.spend.push({ at, usd })
        state.spend = state.spend.filter(s => s.at >= at - SPEND_KEEP_MS)
      }
      a.calls++
      a.lastPrompt = usage.input + usage.cacheRead + usage.cacheWrite5m + usage.cacheWrite1h
      a.samples.push({ at, output: usage.output, gapMs: Math.max(0, at - a.lastActivity) })
      trim(a.samples, MAX_SAMPLES)
      a.lastActivity = at
      break
    }
    case 'agent.tool': {
      const d = e.data
      const a = agentOf(state, who, at)
      if (d.phase === 'start') revive(a, at)
      const kind: ToolKind = isOneOf(TOOL_KINDS, d.kind) ? d.kind : 'other'
      const subject = text(d.subject, 80)
      if (d.phase === 'start') {
        a.tools[kind]++
        a.openTools++
        if ((kind === 'read' || kind === 'edit') && subject !== '' && !a.files.includes(subject) && a.files.length < MAX_FILES) {
          a.files.push(subject)
        }
        if (kind === 'edit' && subject !== '' && isSafeKey(subject)) {
          const list = Object.hasOwn(state.edits, subject) ? state.edits[subject]! : (state.edits[subject] = [])
          list.push({ agent: a.id, at })
          trim(list, MAX_EDITS)
        }
      } else {
        a.openTools = Math.max(0, a.openTools - 1)
        if (d.isError === true) {
          a.errors++
          a.errorsInRow++
        } else {
          a.errorsInRow = 0
        }
      }
      a.lastActivity = at
      break
    }
    case 'message.sent': {
      const from = agentOf(state, who, at)
      const to = resolve(state, text(e.data.to, 64) || 'unknown', at)
      const summary = text(e.data.summary, 200)
      const key = `${from.id}->${to}`
      const link = Object.hasOwn(state.links, key)
        ? state.links[key]!
        : (state.links[key] = { from: from.id, to, count: 0, lastAt: at, recent: [] })
      link.count++
      link.lastAt = at
      link.recent.push(summary)
      trim(link.recent, MAX_RECENT)
      from.messagesOut++
      from.lastActivity = at
      const target = Object.hasOwn(state.agents, to) ? state.agents[to] : undefined
      if (target !== undefined) target.messagesIn++
      feed(state, { at, kind: 'message', agent: from.id, to, text: summary })
      break
    }
    case 'memory.put': {
      const key = e.data.key
      if (typeof key !== 'string' || !MEMORY_KEY.test(key) || !isSafeKey(key)) break
      state.memory[key] = { writer: who, at, bytes: num(e.data.bytes), preview: text(e.data.preview, 80) }
      feed(state, { at, kind: 'memory', agent: who, text: `memory.put ${key}` })
      break
    }
    case 'task.created': {
      const d = e.data
      const id = text(d.id, 32)
      if (!isSafeKey(id)) break
      state.tasks[id] = {
        id, title: text(d.title, 120), state: 'pending', assignee: text(d.assignee, 64) || null,
        dependsOn: Array.isArray(d.dependsOn)
          ? d.dependsOn.map(x => text(x, 32)).filter(x => x !== '' && isSafeKey(x)).slice(0, 20)
          : [],
        createdAt: at, updatedAt: at, note: null,
      }
      feed(state, { at, kind: 'task', agent: who, text: `task ${id} created: ${state.tasks[id]!.title}` })
      break
    }
    case 'session.measure': {
      const d = e.data
      const known = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? num(x) : null)
      const window = known(d.contextWindow)
      const percent = known(d.contextPercent)
      const prev = state.session
      const tokens = known(d.contextTokens)
      const cost = known(d.costUsd)
      state.session = {
        contextTokens: tokens ?? prev.contextTokens,
        contextWindow: window === null || window === 0 ? prev.contextWindow : window,
        contextPercent: percent !== null ? Math.min(100, percent) : tokens !== null ? null : prev.contextPercent,
        costUsd: cost ?? prev.costUsd,
        at,
      }
      break
    }
    case 'task.updated': {
      const d = e.data
      const id = text(d.id, 32)
      const task = isSafeKey(id) && Object.hasOwn(state.tasks, id) ? state.tasks[id] : undefined
      if (task === undefined) break
      if (isOneOf(TASK_STATES, d.state)) task.state = d.state
      if (typeof d.assignee === 'string') task.assignee = text(d.assignee, 64) || null
      if (typeof d.note === 'string') task.note = text(d.note, 200)
      task.updatedAt = at
      feed(state, { at, kind: 'task', agent: who, text: `task ${id} → ${task.state}` })
      break
    }
  }
  return state
}

export function foldAll(id: string, events: readonly SwarmEvent[]): SwarmState {
  const state = emptyState(id)
  for (const e of events) fold(state, e)
  return state
}
