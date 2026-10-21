/** The timeline: one row per agent showing its current run across the swarm's lifetime; running rows grow live. Pure. */
import type { SwarmState } from '../core/fold.ts'
import { agentStatus } from '../core/stats.ts'
import { desaturate, mix, scale } from './color.ts'
import { clipText, fmtDuration } from './format.ts'
import { type Grid, cp, writeParts, writeRight } from './grid.ts'
import { orderAgents } from './layout.ts'
import { CANVAS, GLYPH, STATUS, TEXT, modelColor, statusGlyph } from './tokens.ts'
import type { Rect } from './types.ts'

const FULL = 0x2588
/** Left-aligned blocks, one eighth to seven eighths wide. */
const LEFT_EIGHTHS = [0x2588, 0x258f, 0x258e, 0x258d, 0x258c, 0x258b, 0x258a, 0x2589] as const
const AXIS = cp('─')
const CORNER = cp('└')

function bar(grid: Grid, x0: number, y: number, from: number, to: number, color: number): void {
  const a = Math.floor(from)
  const full = Math.floor(to)
  const frac = Math.round((to - full) * 8)
  for (let x = a; x < full; x++) grid.set(x0 + x, y, FULL, color)
  if (frac >= 8) grid.set(x0 + full, y, FULL, color)
  else if (frac > 0) grid.set(x0 + full, y, LEFT_EIGHTHS[frac]!, color)
  else if (full === a) grid.set(x0 + a, y, LEFT_EIGHTHS[1], color)
}

export function drawTimeline(grid: Grid, area: Rect, state: SwarmState, now: number): void {
  if (area.h < 2 || area.w < 20) return
  const agents = orderAgents(state).filter(a => !a.placeholder)
  const labelW = Math.min(14, Math.floor(area.w / 4))
  const x0 = area.x + labelW + 1
  const width = area.x + area.w - 1 - x0
  if (width < 4) return
  const start = state.swarm.startedAt ?? Math.min(now, ...agents.map(a => a.startedAt))
  const span = Math.max(1000, now - start)
  const toX = (t: number): number => ((Math.max(start, Math.min(now, t)) - start) / span) * (width - 1)
  const rows = Math.min(agents.length, area.h - 1)
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
    bar(grid, x0, y, from, to, color)
    if (status === 'running') grid.set(x0 + Math.min(width - 1, Math.floor(to)), y, FULL, mix(color, 0xffffff, 0.35))
    if (status === 'failed') grid.set(x0 + Math.min(width - 1, Math.floor(to) + 1), y, cp(GLYPH.failed), STATUS.failed)
  }
  const axisY = area.y + area.h - 1
  grid.set(x0 - 1, axisY, CORNER, TEXT.faint)
  for (let x = 0; x < width; x++) grid.set(x0 + x, axisY, AXIS, TEXT.faint)
  writeParts(grid, x0, axisY, [['0s', TEXT.dim]], x0 + width)
  writeRight(grid, axisY, [[fmtDuration(span), TEXT.dim]], x0 + 3, x0 + width)
  if (agents.length > rows) writeParts(grid, area.x + 1, axisY, [[`… +${agents.length - rows}`, TEXT.dim]], x0 - 1)
}
