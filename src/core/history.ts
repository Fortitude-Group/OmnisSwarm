/** Outcome rows for model hints (spec 2026-10-25 section 2): one per finished subagent, from the folded state. Pure. */
import { LEAD, type AgentState, type SwarmState } from './fold.ts'

/** Roles and models a row may carry. Colons allow plugin agent types such as `plugin:agent`. */
export const ROLE = /^[A-Za-z0-9._:-]{1,64}$/
const PROJECT = /^[0-9a-f]{16}$/
const MAX_ID = 130
const MAX_NUMBER = 1e6
const CLEAN_GATES: ReadonlySet<string> = new Set(['passed', 'none'])

export type HistoryRow = { v: 1; id: string; role: string; model: string; clean: boolean; costUsd: number; minutes: number; at: string; project: string }

/** Answered, never stuck, never asked to wrap up, and every task it held ended done with its gate passed, none or not run. */
export function isClean(s: SwarmState, a: AgentState): boolean {
  if (a.outcome !== 'answer' || a.stuckBy !== undefined) return false
  if (a.guard !== undefined && (a.guard.timeAct !== null || a.guard.costAct !== null)) return false
  for (const t of Object.values(s.tasks)) {
    if (t.assignee === null || (t.assignee !== a.name && t.assignee !== a.id)) continue
    if (t.state !== 'done') return false
    if (t.gate !== null && !CLEAN_GATES.has(t.gate.result)) return false
  }
  return true
}

/** One row per finished subagent with a known model and a valid role. None for a bad project key. */
export function rowsFromState(s: SwarmState, project: string): HistoryRow[] {
  if (!PROJECT.test(project)) return []
  const rows: HistoryRow[] = []
  for (const a of Object.values(s.agents)) {
    if (a.id === LEAD || a.placeholder || a.finishedAt === null || a.model === null) continue
    if (!ROLE.test(a.role) || !ROLE.test(a.model)) continue
    const id = `${s.swarm.id}/${a.id}`
    if (id.length > MAX_ID) continue
    rows.push({
      v: 1, id, role: a.role, model: a.model, clean: isClean(s, a),
      costUsd: Math.round(a.costUsd * 100) / 100,
      minutes: Math.round(Math.max(0, a.activeMs) / 60_000),
      at: new Date(a.finishedAt).toISOString(), project,
    })
  }
  return rows
}

const count = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= MAX_NUMBER
const str = (x: unknown): x is string => typeof x === 'string'

/** A stored row, or null for anything that fails a check. Extra fields are dropped. */
export function parseRow(line: string): HistoryRow | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const { id, role, model, clean, costUsd, minutes, at, project } = r
  if (r.v !== 1 || !str(id) || id.length === 0 || id.length > MAX_ID) return null
  if (!str(role) || !ROLE.test(role) || !str(model) || !ROLE.test(model) || typeof clean !== 'boolean') return null
  if (!count(costUsd) || !count(minutes) || !str(at) || Number.isNaN(Date.parse(at)) || !str(project) || !PROJECT.test(project)) return null
  return { v: 1, id, role, model, clean, costUsd, minutes, at, project }
}

export const rowLine = (r: HistoryRow): string => `${JSON.stringify(r)}\n`
