/** The header (two rows: the swarm and its totals, then tasks and memory) and the one-line summary. Pure. */
import type { SwarmState } from '../core/fold.ts'
import type { SwarmTotals } from '../core/stats.ts'
import { clipText, fmtPercent, fmtTokens, fmtUsd } from './format.ts'
import { type Grid, type Part, writeParts, writeRight } from './grid.ts'
import { ACCENT, CANVAS_RAISED, GLYPH, STATUS, TEXT, contextColor } from './tokens.ts'
import type { Rect } from './types.ts'

const SEP: Part = [' · ', TEXT.faint]
/** The goal is shown only whole, or when at least this many cells of it fit. */
const MIN_GOAL = 12

/**
 * What the pane has to say about the last read. `notes` sit right-aligned on row 1, in priority order and before the
 * goal; `short` is the one-word form for a one-row header and the summary line.
 */
export type HeaderNotes = { notes: readonly Part[]; short: Part | null }
const NO_NOTES: HeaderNotes = { notes: [], short: null }

const cost = (t: SwarmTotals): string => `${fmtUsd(t.costUsd)}${t.costPartial ? '+' : ''}`
const ctxPart = (t: SwarmTotals): Part =>
  t.contextPercent === null ? ['–', TEXT.dim] : [fmtPercent(t.contextPercent / 100), contextColor(t.contextPercent / 100)]
const width = (parts: readonly Part[]): number => parts.reduce((n, [text]) => n + [...text].length, 0)

/** Draws groups left to right, each whole or not at all, stopping at the first that does not fit before `limit`. */
function writeGroups(grid: Grid, x: number, y: number, groups: readonly (readonly Part[])[], limit: number, bg: number): number {
  let cx = x
  for (const g of groups) {
    if (cx + width(g) > limit) break
    cx = writeParts(grid, cx, y, g, limit, bg)
  }
  return cx
}

export function drawHeader(grid: Grid, area: Rect, state: SwarmState, totals: SwarmTotals, hn: HeaderNotes = NO_NOTES): void {
  if (area.h < 1) return
  const bg = CANVAS_RAISED
  grid.fill(area.x, area.y, area.w, Math.min(area.h, 2), bg)
  const x = area.x + 1
  const maxX = area.x + area.w - 1
  const gaps: Part[] = state.gaps > 0 ? [[`${GLYPH.gap} ${state.gaps} gap${state.gaps === 1 ? '' : 's'}`, STATUS.warn]] : []
  // Right-aligned on row 0: the short degraded note (one-row header only), then the gaps marker.
  const right: Part[] = [...(area.h < 2 && hn.short !== null ? [hn.short, ...(gaps.length > 0 ? [SEP] : [])] : []), ...gaps]
  const limit = right.length === 0 ? maxX : maxX - width(right) - 1
  const groups: Part[][] = [
    ...(area.h < 2 ? [] : [[SEP, [state.swarm.topology, TEXT.dim]] as Part[]]),
    [SEP, [`${totals.agents} agents`, TEXT.primary], [` ${totals.running}${GLYPH.running}`, totals.running > 0 ? STATUS.running : TEXT.dim]],
    [SEP, [cost(totals), TEXT.primary]],
    [SEP, ['ctx ', TEXT.dim], ctxPart(totals)],
    [SEP, [`${fmtTokens(totals.tokens)} tok`, TEXT.dim]],
    [SEP, [`${fmtUsd(totals.burnPerMin)}/min`, TEXT.dim]],
  ]
  if (totals.sessionCostUsd !== null) groups.push([SEP, [`cc $${totals.sessionCostUsd.toFixed(2)}`, TEXT.dim]])
  if (state.swarm.endedAt !== null) groups.push([SEP, ['ended', TEXT.dim]])
  // The name always shows (clipped if it must be); every other figure only whole.
  const first = writeParts(grid, x, area.y, [[`${GLYPH.lead} `, ACCENT], [state.swarm.name, TEXT.primary]], limit, bg)
  writeGroups(grid, first, area.y, groups, limit, bg)
  if (right.length > 0) writeRight(grid, area.y, right, x, maxX, bg)
  if (area.h < 2) return
  const t = totals.tasks
  const second: Part[] = [
    ['tasks ', TEXT.dim], [`${t.pending} pending`, TEXT.primary], SEP, [`${t.active} active`, t.active > 0 ? STATUS.running : TEXT.primary], SEP,
    [`${t.done} done`, TEXT.primary], SEP, [`${t.failed} failed`, t.failed > 0 ? STATUS.failed : TEXT.primary], SEP,
    [`memory ${Object.keys(state.memory).length}`, TEXT.dim],
  ]
  if (totals.clashes > 0) second.push(SEP, [`${GLYPH.clash} ${totals.clashes} clash${totals.clashes === 1 ? '' : 'es'}`, STATUS.failed])
  const end = writeParts(grid, x, area.y + 1, second, maxX, bg)
  // Right of the tasks, in priority order: the notes, then the goal if all of it or MIN_GOAL cells of it fit.
  const right1: Part[] = hn.notes.flatMap((n, i): Part[] => (i === 0 ? [n] : [SEP, n]))
  const avail = maxX - end - 3 - width(right1) - (right1.length > 0 ? width([SEP]) : 0)
  const goal = state.swarm.goal
  if (goal !== null && goal !== '' && ([...goal].length <= avail || avail >= MIN_GOAL)) {
    if (right1.length > 0) right1.push(SEP)
    right1.push([clipText(goal, avail), TEXT.dim])
  }
  if (right1.length > 0 && end + 3 < maxX) writeRight(grid, area.y + 1, right1, end + 3, maxX, bg)
}

const shortLine = (state: SwarmState, totals: SwarmTotals): string[] => [
  `${GLYPH.lead} ${state.swarm.name}`,
  ` · ${totals.agents} agents ${totals.running}${GLYPH.running}`,
  ` · ${cost(totals)}`,
  ` · ctx ${ctxPart(totals)[0]}`,
]

/** The one-line summary, also the words an Svg says for readers that cannot see it. */
export const summaryText = (state: SwarmState, totals: SwarmTotals): string => shortLine(state, totals).join('')

export function drawSummary(grid: Grid, area: Rect, state: SwarmState, totals: SwarmTotals, hn: HeaderNotes = NO_NOTES): void {
  if (area.h < 1) return
  grid.fill(area.x, area.y, area.w, 1, CANVAS_RAISED)
  const maxX = area.x + area.w
  const gaps: Part[] = state.gaps > 0 ? [[` ${GLYPH.gap} ${state.gaps}`, STATUS.warn]] : []
  const right: Part[] = [...(hn.short !== null ? [hn.short] : []), ...gaps]
  const limit = right.length === 0 ? maxX : maxX - width(right) - 1
  const [name, ...rest] = shortLine(state, totals)
  const first = writeParts(grid, area.x + 1, area.y, [[name!, TEXT.primary]], limit, CANVAS_RAISED)
  writeGroups(grid, first, area.y, rest.map((g): Part[] => [[g, TEXT.primary]]), limit, CANVAS_RAISED)
  if (right.length > 0) writeRight(grid, area.y, right, area.x + 1, maxX, CANVAS_RAISED)
}
