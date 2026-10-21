/** The small-pane view: the swarm as an indented tree, one agent a row, depth first. Pure. */
import type { SwarmState } from '../core/fold.ts'
import type { AgentStats } from '../core/stats.ts'
import { clipText, fmtTokens, fmtUsd } from './format.ts'
import { type Grid, writeParts } from './grid.ts'
import { orderAgents, parentsOf } from './layout.ts'
import { STATUS, TEXT, modelColor, statusGlyph } from './tokens.ts'
import type { Rect } from './types.ts'

const MAX_INDENT = 8

export function drawTree(grid: Grid, area: Rect, state: SwarmState, stats: Readonly<Record<string, AgentStats>>): void {
  const parents = parentsOf(state)
  const agents = orderAgents(state)
  const kids = new Map<string, string[]>()
  const roots: string[] = []
  for (const a of agents) {
    const p = parents.get(a.id) ?? null
    if (p === null) roots.push(a.id)
    else kids.set(p, [...(kids.get(p) ?? []), a.id])
  }
  const rows: Array<{ id: string; depth: number }> = []
  const seen = new Set<string>()
  const walk = (id: string, depth: number): void => {
    if (seen.has(id)) return
    seen.add(id)
    rows.push({ id, depth })
    for (const k of kids.get(id) ?? []) walk(k, depth + 1)
  }
  for (const r of roots) walk(r, 0)
  for (const a of agents) walk(a.id, 0)
  const room = area.h
  const shown = rows.length > room ? rows.slice(0, Math.max(0, room - 1)) : rows
  const maxX = area.x + area.w - 1
  shown.forEach((row, i) => {
    const s = Object.hasOwn(stats, row.id) ? stats[row.id]! : null
    if (s === null) return
    const nameColor = s.status === 'failed' ? STATUS.failed : s.placeholder ? TEXT.dim : modelColor(s.model)
    writeParts(grid, area.x + 1, area.y + i, [
      ['  '.repeat(Math.min(row.depth, MAX_INDENT)), TEXT.dim],
      [`${statusGlyph(s.status, s.placeholder)} `, STATUS[s.status]],
      [clipText(s.name, 24), nameColor],
      ['  ', TEXT.dim],
      [s.model === null ? '– tok · –' : `${fmtTokens(s.tokens.total)} tok · ${fmtUsd(s.costUsd)}`, TEXT.dim],
    ], maxX)
  })
  if (rows.length > room && room > 0) writeParts(grid, area.x + 1, area.y + room - 1, [[`… ${rows.length - shown.length} more`, TEXT.dim]], maxX)
}
