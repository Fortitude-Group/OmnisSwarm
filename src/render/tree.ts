/** The small-pane view: the swarm as an indented tree, one agent a row, depth first. Pure. */
import type { SwarmState } from '../core/fold.ts'
import type { AgentStats } from '../core/stats.ts'
import { clipText, fmtTokens, fmtUsd } from './format.ts'
import { dropsFor } from './guard-badge.ts'
import { type Grid, type Part, writeParts } from './grid.ts'
import { orderAgents, parentsOf } from './layout.ts'
import { STATUS, TEXT, modelColor, statusGlyph } from './tokens.ts'
import type { Rect } from './types.ts'

const MAX_INDENT = 8

export function drawTree(grid: Grid, area: Rect, state: SwarmState, stats: Readonly<Record<string, AgentStats>>): void {
  if (area.h < 1) return
  const parents = parentsOf(state)
  const agents = orderAgents(state)
  const has = (id: string): boolean => Object.hasOwn(stats, id)
  let total = 0
  const kids = new Map<string, string[]>()
  const roots: string[] = []
  for (const a of agents) {
    if (has(a.id)) total++
    const p = parents.get(a.id) ?? null
    if (p === null) roots.push(a.id)
    else {
      const list = kids.get(p)
      if (list === undefined) kids.set(p, [a.id])
      else list.push(a.id)
    }
  }
  const room = area.h
  const cap = total > room ? room - 1 : room
  const rows: Array<{ id: string; depth: number }> = []
  const seen = new Set<string>()
  // Explicit stack: a very deep parent chain must not overflow the call stack. Stops once the visible rows are full.
  const stack: Array<{ id: string; depth: number }> = []
  const start = [...roots, ...agents.map(a => a.id)]
  for (const first of start) {
    if (rows.length >= cap) break
    stack.push({ id: first, depth: 0 })
    while (stack.length > 0 && rows.length < cap) {
      const { id, depth } = stack.pop()!
      if (seen.has(id)) continue
      seen.add(id)
      const visible = has(id)
      if (visible) rows.push({ id, depth })
      const list = kids.get(id)
      if (list !== undefined) for (let i = list.length - 1; i >= 0; i--) stack.push({ id: list[i]!, depth: visible ? depth + 1 : depth })
    }
    stack.length = 0
  }
  const maxX = area.x + area.w - 1
  rows.forEach((row, i) => {
    const s = stats[row.id]!
    const agent = state.agents[row.id]
    const nameColor = s.status === 'failed' ? STATUS.failed : s.placeholder ? TEXT.dim : modelColor(s.model)
    writeParts(grid, area.x + 1, area.y + i, [
      ['  '.repeat(Math.min(row.depth, MAX_INDENT)), TEXT.dim],
      [`${statusGlyph(s.status, s.placeholder)} `, STATUS[s.status]],
      [clipText(s.name, 24), nameColor],
      ['  ', TEXT.dim],
      [s.model === null ? '– tok · –' : `${fmtTokens(s.tokens.total)} tok · ${fmtUsd(s.costUsd)}`, TEXT.dim],
      ...(agent !== undefined && dropsFor(agent) > 0 ? [[' over', STATUS.warn] as Part] : []),
    ], maxX)
  })
  if (total > room) writeParts(grid, area.x + 1, area.y + room - 1, [[`… ${total - rows.length} more`, TEXT.dim]], maxX)
}
