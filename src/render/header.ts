/** The header (two rows: the swarm and its totals, then tasks and memory) and the one-line summary. Pure. */
import type { SwarmState } from '../core/fold.ts'
import type { SwarmTotals } from '../core/stats.ts'
import { fmtPercent, fmtTokens, fmtUsd } from './format.ts'
import { type Grid, type Part, writeParts, writeRight } from './grid.ts'
import { ACCENT, CANVAS_RAISED, GLYPH, STATUS, TEXT, contextColor } from './tokens.ts'
import type { Rect } from './types.ts'

const SEP: Part = [' · ', TEXT.faint]

const cost = (t: SwarmTotals): string => `${fmtUsd(t.costUsd)}${t.costPartial ? '+' : ''}`
const ctxPart = (t: SwarmTotals): Part =>
  t.contextPercent === null ? ['–', TEXT.dim] : [fmtPercent(t.contextPercent / 100), contextColor(t.contextPercent / 100)]

export function drawHeader(grid: Grid, area: Rect, state: SwarmState, totals: SwarmTotals): void {
  if (area.h < 1) return
  const bg = CANVAS_RAISED
  grid.fill(area.x, area.y, area.w, Math.min(area.h, 2), bg)
  const x = area.x + 1
  const maxX = area.x + area.w - 1
  const parts: Part[] = [
    [`${GLYPH.lead} `, ACCENT], [state.swarm.name, TEXT.primary], SEP, [state.swarm.topology, TEXT.dim], SEP,
    [`${totals.agents} agents`, TEXT.primary], [` ${totals.running}${GLYPH.running}`, STATUS.running], SEP,
    [cost(totals), TEXT.primary], SEP, [`${fmtTokens(totals.tokens)} tok`, TEXT.dim], SEP,
    [`${fmtUsd(totals.burnPerMin)}/min`, TEXT.dim], SEP, ['ctx ', TEXT.dim], ctxPart(totals),
  ]
  if (totals.sessionCostUsd !== null) parts.push(SEP, [`cc $${totals.sessionCostUsd.toFixed(2)}`, TEXT.dim])
  if (state.swarm.endedAt !== null) parts.push(SEP, ['ended', TEXT.dim])
  writeParts(grid, x, area.y, parts, maxX, bg)
  if (state.gaps > 0) writeRight(grid, area.y, [[`${GLYPH.gap} ${state.gaps} gaps`, STATUS.warn]], x, maxX, bg)
  if (area.h < 2) return
  const t = totals.tasks
  const second: Part[] = [
    ['tasks ', TEXT.dim], [`${t.pending} pending`, TEXT.primary], SEP, [`${t.active} active`, t.active > 0 ? STATUS.running : TEXT.primary], SEP,
    [`${t.done} done`, TEXT.primary], SEP, [`${t.failed} failed`, t.failed > 0 ? STATUS.failed : TEXT.primary], SEP,
    [`memory ${Object.keys(state.memory).length}`, TEXT.dim],
  ]
  if (totals.clashes > 0) second.push(SEP, [`${GLYPH.clash} ${totals.clashes} clash${totals.clashes === 1 ? '' : 'es'}`, STATUS.failed])
  const end = writeParts(grid, x, area.y + 1, second, maxX, bg)
  if (state.swarm.goal !== null && end + 4 < maxX) writeRight(grid, area.y + 1, [[state.swarm.goal, TEXT.dim]], end + 3, maxX, bg)
}

/** The one-line summary, also the words an Svg says for readers that cannot see it. */
export const summaryText = (state: SwarmState, totals: SwarmTotals): string =>
  `${GLYPH.lead} ${state.swarm.name} · ${totals.agents} agents ${totals.running}${GLYPH.running} · ${cost(totals)} · ctx ${ctxPart(totals)[0]}`

export function drawSummary(grid: Grid, area: Rect, state: SwarmState, totals: SwarmTotals): void {
  if (area.h < 1) return
  grid.fill(area.x, area.y, area.w, 1, CANVAS_RAISED)
  writeParts(grid, area.x + 1, area.y, [[summaryText(state, totals), TEXT.primary]], area.x + area.w, CANVAS_RAISED)
  if (state.gaps > 0) writeRight(grid, area.y, [[` ${GLYPH.gap} ${state.gaps}`, STATUS.warn]], area.x + 1, area.x + area.w, CANVAS_RAISED)
}
