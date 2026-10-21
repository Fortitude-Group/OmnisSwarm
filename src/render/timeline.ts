/** The timeline: one row per agent showing its current run across the swarm's lifetime; running rows grow live. Pure. */
import type { AgentState, SwarmState } from '../core/fold.ts'
import { agentStatus } from '../core/stats.ts'
import { desaturate, mix, scale } from './color.ts'
import { clipText, fmtDuration } from './format.ts'
import { type Grid, cp, writeParts, writeRight } from './grid.ts'
import { orderAgents } from './layout.ts'
import { CANVAS, GLYPH, STATUS, TEXT, modelColor, statusGlyph } from './tokens.ts'
import type { Rect } from './types.ts'

/** Five-eighths high, so the rows stay apart. */
const BAR = 0x2585
const AXIS = cp('─')
const CORNER = cp('└')

/** The bar's cells, the end rounded to the nearest cell and at least one cell: a quiet body, the last cell at full strength. Returns the last cell. */
function bar(grid: Grid, x0: number, y: number, from: number, to: number, color: number, lastColor: number, maxCell: number): number {
  const a = Math.min(maxCell, Math.round(from))
  const last = Math.min(maxCell, Math.max(a, Math.round(to)))
  const body = mix(CANVAS, color, 0.6)
  for (let x = a; x < last; x++) grid.set(x0 + x, y, BAR, body)
  grid.set(x0 + last, y, BAR, lastColor)
  return last
}

export function drawTimeline(grid: Grid, area: Rect, state: SwarmState, now: number): void {
  if (area.h < 2 || area.w < 20) return
  const ordered = orderAgents(state)
  const limit = area.h - 1
  const agents: AgentState[] = []
  let count = 0
  let earliest = now
  for (const a of ordered) {
    if (a.placeholder) continue
    count++
    if (a.startedAt < earliest) earliest = a.startedAt
    if (agents.length < limit) agents.push(a)
  }
  const labelW = Math.min(14, Math.floor(area.w / 4))
  const x0 = area.x + labelW + 1
  const width = area.x + area.w - 1 - x0
  if (width < 4) return
  const start = state.swarm.startedAt ?? earliest
  const span = Math.max(1000, now - start)
  const toX = (t: number): number => ((Math.max(start, Math.min(now, t)) - start) / span) * (width - 1)
  const rows = agents.length
  for (let i = 0; i < rows; i++) {
    const a = agents[i]!
    const y = area.y + i
    const status = agentStatus(a, now)
    writeParts(grid, area.x + 1, y, [[`${statusGlyph(status)} `, STATUS[status]], [clipText(a.name, labelW - 3), TEXT.dim]], x0 - 1)
    const from = toX(a.startedAt)
    const to = Math.max(from, toX(a.finishedAt ?? now))
    const base = modelColor(a.model)
    const color = status === 'failed' ? STATUS.failed
      : status === 'done' ? mix(desaturate(base, 0.6), CANVAS, 0.45)
      : status === 'waiting' ? scale(base, 0.72) : base
    const edge = status === 'running' ? mix(color, 0xffffff, 0.35) : color
    const last = bar(grid, x0, y, from, to, color, edge, width - 1)
    if (status === 'failed') grid.set(x0 + Math.min(width - 1, last + 1), y, cp(GLYPH.failed), STATUS.failed)
  }
  const axisY = area.y + area.h - 1
  grid.set(x0 - 1, axisY, CORNER, TEXT.faint)
  for (let x = 0; x < width; x++) grid.set(x0 + x, axisY, AXIS, TEXT.faint)
  writeParts(grid, x0, axisY, [['0s', TEXT.dim]], x0 + width)
  writeRight(grid, axisY, [[fmtDuration(span), TEXT.dim]], x0 + 3, x0 + width)
  if (count > rows) writeParts(grid, area.x + 1, axisY, [[`… +${count - rows}`, TEXT.dim]], x0 - 1)
}
