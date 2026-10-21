/** Per-agent stats and swarm totals worked out from SwarmState. Pure. */
import { TASK_STATES, type TaskState, type ToolKind } from './events.ts'
import type { AgentState, SwarmState } from './fold.ts'
import { priceFor, type Usage } from './prices.ts'

export const RUNNING_WINDOW_MS = 5_000
export const SPEED_WINDOW_MS = 30_000
export const BURN_WINDOW_MS = 300_000
export const CLASH_WINDOW_MS = 600_000
export const STUCK_AFTER = 3
/** An open tool call older than this is assumed to have lost its end event. */
export const STALE_TOOL_MS = 300_000

export type AgentStatus = 'running' | 'waiting' | 'done' | 'failed'

export function agentStatus(a: AgentState, nowMs: number): AgentStatus {
  if (a.outcome !== null) return a.outcome === 'failed' ? 'failed' : 'done'
  const idle = nowMs - a.lastActivity
  return idle <= RUNNING_WINDOW_MS || (a.openTools > 0 && idle <= STALE_TOOL_MS) ? 'running' : 'waiting'
}

export const totalTokens = (u: Usage): number => u.input + u.output + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h

/** The latest call's prompt size against the model's context window. */
export function contextFill(a: AgentState): number | null {
  if (a.model === null || a.calls === 0) return null
  const price = priceFor(a.model)
  return price === null ? null : Math.min(1, a.lastPrompt / price.contextWindow)
}

export function cacheHitRate(a: AgentState): number | null {
  const t = a.tokens
  const prompt = t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h
  return prompt === 0 ? null : t.cacheRead / prompt
}

/** Output tokens per second for each call (≈: the gap includes tool time). */
export const speedSeries = (a: AgentState): number[] =>
  a.samples.filter(s => s.gapMs > 0).map(s => s.output / (s.gapMs / 1000))

/** Output tokens per second over calls in the last SPEED_WINDOW_MS. */
export function speed(a: AgentState, nowMs: number): number | null {
  const recent = a.samples.filter(s => s.gapMs > 0 && nowMs - s.at <= SPEED_WINDOW_MS)
  const seconds = recent.reduce((t, s) => t + s.gapMs, 0) / 1000
  return seconds === 0 ? null : recent.reduce((t, s) => t + s.output, 0) / seconds
}

export type Clash = { path: string; agents: string[] }

/**
 * Paths edited by two or more agents within CLASH_WINDOW_MS of each other.
 * With nowMs, a pair only counts while at least one of its edits is within CLASH_WINDOW_MS of now.
 */
export function fileClashes(state: SwarmState, nowMs?: number): Clash[] {
  const clashes: Clash[] = []
  for (const [path, edits] of Object.entries(state.edits)) {
    const agents = new Set<string>()
    for (let i = 0; i < edits.length; i++) {
      for (let j = i + 1; j < edits.length; j++) {
        const a = edits[i]!
        const b = edits[j]!
        if (a.agent !== b.agent && Math.abs(a.at - b.at) <= CLASH_WINDOW_MS &&
          (nowMs === undefined || nowMs - a.at <= CLASH_WINDOW_MS || nowMs - b.at <= CLASH_WINDOW_MS)) {
          agents.add(a.agent)
          agents.add(b.agent)
        }
      }
    }
    if (agents.size > 0) clashes.push({ path, agents: [...agents].sort() })
  }
  return clashes.sort((x, y) => x.path.localeCompare(y.path))
}

export type AgentStats = {
  id: string
  name: string
  role: string
  model: string | null
  status: AgentStatus
  placeholder: boolean
  lifetimeMs: number
  tokens: Usage & { total: number }
  costUsd: number | null
  contextFill: number | null
  cacheHitRate: number | null
  speedTps: number | null
  speedSeries: number[]
  tools: Record<ToolKind, number>
  files: string[]
  messagesIn: number
  messagesOut: number
  errors: number
  stuck: boolean
  clashes: string[]
}

export function agentStats(state: SwarmState, id: string, nowMs: number, clashes: Clash[] = fileClashes(state, nowMs)): AgentStats | null {
  const a = Object.hasOwn(state.agents, id) ? state.agents[id] : undefined
  if (a === undefined) return null
  return {
    id: a.id,
    name: a.name,
    role: a.role,
    model: a.model,
    status: agentStatus(a, nowMs),
    placeholder: a.placeholder,
    lifetimeMs: (a.finishedAt ?? nowMs) - a.startedAt,
    tokens: { ...a.tokens, total: totalTokens(a.tokens) },
    costUsd: a.costKnown ? a.costUsd : null,
    contextFill: contextFill(a),
    cacheHitRate: cacheHitRate(a),
    speedTps: speed(a, nowMs),
    speedSeries: speedSeries(a),
    tools: { ...a.tools },
    files: [...a.files],
    messagesIn: a.messagesIn,
    messagesOut: a.messagesOut,
    errors: a.errors,
    stuck: a.outcome === null && a.errorsInRow >= STUCK_AFTER,
    clashes: clashes.filter(c => c.agents.includes(a.id)).map(c => c.path),
  }
}

export type SwarmTotals = {
  agents: number
  running: number
  tokens: number
  costUsd: number
  /** True when some usage came from a model missing from the price table. */
  costPartial: boolean
  burnPerMin: number
  busiestLink: { from: string; to: string; count: number } | null
  mostExpensive: string | null
  tasks: Record<TaskState, number>
  clashes: number
}

export function swarmTotals(state: SwarmState, nowMs: number, clashes: Clash[] = fileClashes(state, nowMs)): SwarmTotals {
  const agents = Object.values(state.agents).filter(a => !a.placeholder)
  let tokens = 0
  let cost = 0
  let partial = false
  let running = 0
  let top: AgentState | null = null
  for (const a of agents) {
    tokens += totalTokens(a.tokens)
    cost += a.costUsd
    if (!a.costKnown) partial = true
    if (agentStatus(a, nowMs) === 'running') running++
    if (top === null || a.costUsd > top.costUsd) top = a
  }
  const recentSpend = state.spend.filter(s => s.at <= nowMs && nowMs - s.at <= BURN_WINDOW_MS).reduce((t, s) => t + s.usd, 0)
  let busiest: SwarmTotals['busiestLink'] = null
  for (const link of Object.values(state.links)) {
    if (busiest === null || link.count > busiest.count) busiest = { from: link.from, to: link.to, count: link.count }
  }
  const tasks = Object.fromEntries(TASK_STATES.map(s => [s, 0])) as Record<TaskState, number>
  for (const task of Object.values(state.tasks)) tasks[task.state]++
  return {
    agents: agents.length,
    running,
    tokens,
    costUsd: cost,
    costPartial: partial,
    burnPerMin: recentSpend / (BURN_WINDOW_MS / 60_000),
    busiestLink: busiest,
    mostExpensive: top !== null && top.costUsd > 0 ? top.id : null,
    tasks,
    clashes: clashes.length,
  }
}
