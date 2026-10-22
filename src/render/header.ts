/** The header (two rows: the swarm and its totals, then tasks and memory) and the one-line summary. Pure. */
import type { SwarmState } from '../core/fold.ts'
import type { SwarmTotals } from '../core/stats.ts'
import { clipText, fmtPercent, fmtTokens, fmtUsd } from './format.ts'
import { type Grid, type Part, writeParts, writeRight } from './grid.ts'
import { ACCENT, CANVAS_RAISED, GLYPH, GUARD, REPLAY, STATUS, TEXT, contextColor } from './tokens.ts'
import type { Rect, ReplayNote, ViewBudget } from './types.ts'

const SEP: Part = [' · ', TEXT.faint]
/** The goal is shown only whole, or when at least this many cells of it fit. */
const MIN_GOAL = 12

/**
 * What the pane has to say about the last read. `notes` sit right-aligned on row 1, in priority order and before the
 * goal; `short` is the one-word form for a one-row header and the summary line. `wordmark`: the GIF's `OmnisSwarm`
 * at the right end of row 0 (13.4); never set in the pane.
 */
export type HeaderNotes = { notes: readonly Part[]; short: Part | null; budget?: ViewBudget | null; overBudget?: number; replay?: ReplayNote | null; wordmark?: boolean }
const NO_NOTES: HeaderNotes = { notes: [], short: null }

const cost = (t: SwarmTotals): string => `${fmtUsd(t.costUsd)}${t.costPartial ? '+' : ''}`
const BLOCKED: Part = [' BLOCKED ', GUARD.blockedBadge.fg, GUARD.blockedBadge.bg]
/** Row 0's cost group: unchanged below the warn level; from it the figure in warn (failed from the limit), then `/$limit`. */
function costGroup(t: SwarmTotals, b: ViewBudget | null | undefined): Part[] {
  if (b === null || b === undefined || !(b.swarmUsd >= b.warn)) return [SEP, [cost(t), TEXT.primary]]
  return [SEP, [`${fmtUsd(b.swarmUsd)}${t.costPartial ? '+' : ''}`, b.swarmUsd >= b.limit ? STATUS.failed : STATUS.warn], [`/$${b.limit}`, TEXT.dim]]
}
const ctxPart = (t: SwarmTotals): Part =>
  t.contextPercent === null ? ['–', TEXT.dim] : [fmtPercent(t.contextPercent / 100), contextColor(t.contextPercent / 100)]
const width = (parts: readonly Part[]): number => parts.reduce((n, [text]) => n + [...text].length, 0)

/** The replay clock (§13.3): mm:ss under an hour, h:mm:ss from one. */
export const fmtClock = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

const STOP_NOTE: Part = ['/omnis replay stop', TEXT.dim]
const WORDMARK: readonly Part[] = [['Omnis', ACCENT], ['Swarm', TEXT.primary]]
const bgOf = (hn: HeaderNotes): number => (hn.replay ? REPLAY.raised : CANVAS_RAISED)

/**
 * The replay's badge and clock at the start of row 0 (§13.3), from the grid's left edge. The badge always shows; the
 * clock always on the two-row header (`keepClock`), elsewhere only whole. Returns where the usual row 0 starts.
 */
function drawReplayLead(grid: Grid, x: number, y: number, r: ReplayNote, limit: number, bg: number, keepClock: boolean): number {
  const badge: Part = [` REPLAY ${Math.round(r.speed)}${GLYPH.times} `, REPLAY.badge.fg, REPLAY.badge.bg]
  const clock: Part[] = [[` ${fmtClock(r.clockMs)}`, TEXT.primary], [` / ${fmtClock(r.totalMs)}`, TEXT.dim], ...(r.ended ? [[' end', TEXT.dim] as Part] : [])]
  const end = writeParts(grid, x, y, [badge], limit, bg)
  if (!keepClock && end + width(clock) > limit) return end + 1
  return writeParts(grid, end, y, clock, limit, bg) + 2
}

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
  const bg = bgOf(hn)
  grid.fill(area.x, area.y, area.w, Math.min(area.h, 2), bg)
  const x = area.x + 1
  const maxX = area.x + area.w - 1
  const replay = hn.replay ?? null
  const gaps: Part[] = state.gaps > 0 ? [[`${GLYPH.gap} ${state.gaps} gap${state.gaps === 1 ? '' : 's'}`, STATUS.warn]] : []
  // Right-aligned on row 0: the short degraded note (one-row header only), then the gaps marker, then the GIF's wordmark.
  const blocked = hn.budget?.blocked === true
  const right: Part[] = [
    ...(area.h < 2 && hn.short !== null ? [hn.short, ...(gaps.length > 0 || blocked ? [SEP] : [])] : []),
    ...(area.h < 2 && blocked ? [BLOCKED, ...(gaps.length > 0 ? [[' ', TEXT.dim] as Part] : [])] : []),
    ...gaps,
  ]
  if (hn.wordmark === true) right.push(...(right.length > 0 ? [SEP] : []), ...WORDMARK)
  const limit = right.length === 0 ? maxX : maxX - width(right) - 1
  const groups: Part[][] = [
    ...(area.h < 2 ? [] : [[SEP, [state.swarm.topology, TEXT.dim]] as Part[]]),
    [SEP, [`${totals.agents} agents`, TEXT.primary], [` ${totals.running}${GLYPH.running}`, totals.running > 0 ? STATUS.running : TEXT.dim]],
    costGroup(totals, hn.budget),
    [SEP, ['ctx ', TEXT.dim], ctxPart(totals)],
    [SEP, [`${fmtTokens(totals.tokens)} tok`, TEXT.dim]],
    [SEP, [`${fmtUsd(totals.burnPerMin)}/min`, TEXT.dim]],
  ]
  if (totals.sessionCostUsd !== null) groups.push([SEP, [`cc $${totals.sessionCostUsd.toFixed(2)}`, TEXT.dim]])
  if (state.swarm.endedAt !== null) groups.push([SEP, ['ended', TEXT.dim]])
  // A replay's badge and clock come first and are never dropped on the two-row header (§13.3).
  const x0 = replay === null ? x : drawReplayLead(grid, area.x, area.y, replay, area.h < 2 ? limit : maxX, bg, area.h >= 2)
  // The name always shows (clipped if it must be); every other figure only whole.
  const first = writeParts(grid, x0, area.y, [[`${GLYPH.lead} `, ACCENT], [state.swarm.name, TEXT.primary]], limit, bg)
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
  const build = (hint: boolean): Part[] => {
    const groups1: Part[][] = [
      // The stop hint is a pane command; the GIF (wordmark) has nothing to stop.
      ...(replay?.ended === true && hn.wordmark !== true ? [[STOP_NOTE]] : []),
      ...(blocked ? [[BLOCKED, [' new agents', TEXT.dim], ...(hint ? [SEP, ['/omnis budget <usd>', TEXT.dim] as Part] : [])] as Part[]] : []),
      ...hn.notes.map((n): Part[] => [n]),
      ...(hn.overBudget !== undefined && hn.overBudget > 0 ? [[[`${hn.overBudget} over budget`, STATUS.warn]] as Part[]] : []),
    ]
    return groups1.flatMap((g, i): Part[] => (i === 0 ? g : [SEP, ...g]))
  }
  // The hint is dropped whole when the notes do not fit with it; the badge stays.
  const full = build(true)
  const right1: Part[] = width(full) <= maxX - end - 3 ? full : build(false)
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
  const bg = bgOf(hn)
  grid.fill(area.x, area.y, area.w, 1, bg)
  const maxX = area.x + area.w
  const gaps: Part[] = state.gaps > 0 ? [[` ${GLYPH.gap} ${state.gaps}`, STATUS.warn]] : []
  const blocked = hn.budget?.blocked === true
  const right: Part[] = [...(hn.short !== null ? [hn.short] : []), ...(blocked ? [BLOCKED] : []), ...gaps]
  const limit = right.length === 0 ? maxX : maxX - width(right) - 1
  const [name, ...rest] = shortLine(state, totals)
  // A replay's badge first, then its clock if it fits whole (§13.3).
  const x0 = hn.replay ? drawReplayLead(grid, area.x, area.y, hn.replay, limit, bg, false) : area.x + 1
  const first = writeParts(grid, x0, area.y, [[name!, TEXT.primary]], limit, bg)
  writeGroups(grid, first, area.y, rest.map((g): Part[] => [[g, TEXT.primary]]), limit, bg)
  if (right.length > 0) writeRight(grid, area.y, right, area.x + 1, maxX, bg)
}
