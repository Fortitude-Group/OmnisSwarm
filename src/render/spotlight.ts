/** The spotlight: who to show (the busiest agent, held for a while, or the pinned one) and the card drawn for them. Pure. */
import { TOOL_KINDS } from '../core/events.ts'
import type { AgentState, SwarmState } from '../core/fold.ts'
import { agentStatus, type AgentStats } from '../core/stats.ts'
import { clipText, fmtDuration, fmtPercent, fmtTokens, fmtUsd } from './format.ts'
import { guardWords } from './guard-badge.ts'
import { type Grid, type Part, writeParts, writeRight } from './grid.ts'
import { CANVAS_RAISED, GLYPH, KIND, KIND_LETTER, SPOTLIGHT_HOLD_MS, STATUS, TEXT, contextColor, modelColor, routedFamilies, statusGlyph } from './tokens.ts'
import type { Pulse, Rect, Spot } from './types.ts'

const SCORE_WINDOW_MS = 30_000
const PULSE_WINDOW_MS = 10_000
const PULSE_SCORE = 50
const LOWER_EIGHTH = 0x2581
const FULL = 0x2588
const LIGHT_SHADE = 0x2591
const BAR_CELLS = 10
const SPARK_CELLS = 16

export function busiest(state: SwarmState, pulses: readonly Pulse[], now: number): string | null {
  let best: string | null = null
  let bestScore = -1
  let bestAt = Number.NEGATIVE_INFINITY
  for (const a of Object.values(state.agents)) {
    if (a.placeholder) continue
    let score = agentStatus(a, now) === 'running' ? 1 : 0
    for (const s of a.samples) if (s.at <= now && now - s.at <= SCORE_WINDOW_MS) score += s.output
    for (const p of pulses) if (p.guard !== true && p.agent === a.id && p.at <= now && now - p.at <= PULSE_WINDOW_MS) score += PULSE_SCORE
    if (score > bestScore || (score === bestScore && a.lastActivity > bestAt)) {
      best = a.id
      bestScore = score
      bestAt = a.lastActivity
    }
  }
  return best
}

/** A valid pin wins. Otherwise the current agent is held for SPOTLIGHT_HOLD_MS, then the spotlight follows the busiest. */
export function chooseSpotlight(prev: Spot | null, pinned: string | null, state: SwarmState, pulses: readonly Pulse[], now: number): Spot | null {
  const real = (id: string | null): id is string => id !== null && Object.hasOwn(state.agents, id) && !state.agents[id]!.placeholder
  if (real(pinned)) return prev !== null && prev.id === pinned ? prev : { id: pinned, since: now }
  const held = prev !== null && real(prev.id) ? prev : null
  if (held !== null && now - held.since < SPOTLIGHT_HOLD_MS) return held
  const next = busiest(state, pulses, now)
  if (next === null) return held
  return held !== null && held.id === next ? held : { id: next, since: now }
}

/** A one-row bar chart of `values`, newest on the right, scaled to its own maximum, one colour; zero or missing values draw a faint baseline. */
export function sparkline(grid: Grid, x: number, y: number, width: number, values: readonly number[], color: number, bg?: number): void {
  const shown = values.slice(-width)
  const max = Math.max(0, ...shown)
  const offset = width - shown.length
  for (let i = 0; i < width; i++) {
    const v = i < offset ? 0 : (shown[i - offset] ?? 0)
    const level = v <= 0 || max <= 0 ? 0 : Math.max(1, Math.round((v / max) * 8))
    const fg = level === 0 ? TEXT.faint : color
    grid.set(x + i, y, level === 0 ? LOWER_EIGHTH : 0x2580 + level, fg, bg)
  }
}

const SEP: Part = [' · ', TEXT.faint]

export function drawSpotlight(grid: Grid, area: Rect, s: AgentStats, a: AgentState, now: number, compact: boolean): void {
  if (area.h < 1 || area.w < 4) return
  const bg = CANVAS_RAISED
  grid.fill(area.x, area.y, area.w, area.h, bg)
  const x = area.x + 1
  const maxX = area.x + area.w - 1
  const color = modelColor(s.model)
  const status: Part[] = [[`${statusGlyph(s.status, s.placeholder)} ${s.status}`, STATUS[s.status]], SEP, [fmtDuration(s.lifetimeMs), TEXT.dim]]
  const fill = s.contextFill
  const fillPart: Part = [fmtPercent(fill), fill === null ? TEXT.dim : contextColor(fill)]
  // No agent.usage yet (spec section 11): tokens and cost show a dash, not zero. The model arrives with the first usage.
  const noUsage = s.model === null
  const tok = (n: number): string => (noUsage ? '–' : fmtTokens(n))
  const usd = noUsage ? '–' : fmtUsd(s.costUsd)
  const usdColor = noUsage ? TEXT.dim : TEXT.primary
  const width = (parts: readonly Part[]): number => parts.reduce((n, [text]) => n + [...text].length, 0)
  // pane.md 13.5: when a router answered with another model family, the requested one (dim) → the answering one.
  // Every other colour stays the answering model's. The badge and the saving are each drawn whole or not at all.
  const families = routedFamilies(s)
  const badge: Part[] = families === null ? [] : [[families.asked, TEXT.dim], [' → ', TEXT.faint], [families.answered, color]]
  // A delta that rounds to $0.000 says nothing, so it shows no saving at all.
  const raw = families === null ? 0 : (s.route?.deltaUsd ?? 0)
  const delta = Math.abs(raw) < 0.0005 ? 0 : raw
  const saving: Part[] = delta > 0
    ? [[' · saves ', TEXT.dim], [fmtUsd(delta), STATUS.running], [' vs requested', TEXT.dim]]
    : delta < 0 ? [[' · costs ', TEXT.dim], [fmtUsd(-delta), STATUS.warn], [' more vs requested', TEXT.dim]] : []
  const fits = (from: number, parts: readonly Part[], limit: number): boolean => from + width(parts) <= limit

  if (compact) {
    const who: Part[] = [[`${GLYPH.dot} `, color], [clipText(s.name, 24), TEXT.primary]]
    const after: Part[] = badge.length > 0 && fits(x, [...who, SEP, ...badge], maxX) ? [SEP, ...badge] : []
    writeParts(grid, x, area.y, [
      ...who, ...after, [' ', TEXT.dim], ...status, SEP,
      [`${tok(s.tokens.total)} tok`, TEXT.dim], SEP, [usd, usdColor], [' · ctx ', TEXT.faint], fillPart,
    ], maxX, bg)
    return
  }

  const row = (i: number) => area.y + i
  const rows = area.h
  // 0: who
  const leftMax0 = Math.max(x, maxX - width(status) - 2)
  const who0: Part[] = [[`${GLYPH.dot} `, color], [clipText(s.name, 32), TEXT.primary], SEP, [clipText(s.role, 24), TEXT.dim], SEP]
  const model: Part[] = s.model === null
    ? [['model –', TEXT.dim]]
    : badge.length === 0 ? [[s.model, color]] : fits(x, [...who0, ...badge], leftMax0) ? badge : []
  writeParts(grid, x, row(0), model.length > 0 ? [...who0, ...model] : who0.slice(0, -1), leftMax0, bg)
  writeRight(grid, row(0), status, x, maxX, bg)
  // 1: tokens and cost
  if (rows > 1) {
    const t = s.tokens
    const right1: Part[] = [[usd, usdColor], ...(fits(x, [[usd, usdColor], ...saving], maxX) ? saving : [])]
    const leftMax1 = Math.max(x, maxX - width(right1) - 2)
    writeParts(grid, x, row(1), [
      ['tokens ', TEXT.dim], [`in ${tok(t.input)}`, TEXT.primary], ['  ', TEXT.dim], [`out ${tok(t.output)}`, TEXT.primary],
      ['  cache ', TEXT.dim], [`r ${tok(t.cacheRead)} w ${tok(t.cacheWrite5m + t.cacheWrite1h)}`, TEXT.primary],
      ['  = ', TEXT.dim], [tok(t.total), TEXT.primary],
    ], leftMax1, bg)
    writeRight(grid, row(1), right1, x, maxX, bg)
  }
  // 2: context bar and cache hit rate
  if (rows > 2) {
    let cx = writeParts(grid, x, row(2), [['context ', TEXT.dim]], maxX, bg)
    const filled = fill === null ? 0 : Math.round(fill * BAR_CELLS)
    for (let i = 0; i < BAR_CELLS && cx + i < maxX; i++) {
      grid.set(cx + i, row(2), i < filled ? FULL : LIGHT_SHADE, i < filled && fill !== null ? contextColor(fill) : TEXT.faint, bg)
    }
    cx += BAR_CELLS
    writeParts(grid, cx, row(2), [[' ', TEXT.dim], fillPart, ['  cache hit ', TEXT.dim], [fmtPercent(s.cacheHitRate), TEXT.primary]], maxX, bg)
  }
  // 3: speed and tokens sparklines
  if (rows > 3) {
    let cx = writeParts(grid, x, row(3), [['speed ≈ ', TEXT.dim], [s.speedTps === null ? '–' : `${Math.round(s.speedTps)} tok/s`, TEXT.primary], [' ', TEXT.dim]], maxX, bg)
    if (cx + SPARK_CELLS < maxX) {
      sparkline(grid, cx, row(3), SPARK_CELLS, s.speedSeries, color, bg)
      cx += SPARK_CELLS
      cx = writeParts(grid, cx, row(3), [['  tokens ', TEXT.dim]], maxX, bg)
      if (cx + SPARK_CELLS < maxX) sparkline(grid, cx, row(3), SPARK_CELLS, a.samples.map(sample => sample.output), color, bg)
    }
  }
  // 4: tool activity by kind, errors, stuck
  if (rows > 4) {
    const parts: Part[] = [['tools ', TEXT.dim]]
    for (const k of TOOL_KINDS) parts.push([`${KIND_LETTER[k]} `, KIND[k]], [`${s.tools[k]}  `, s.tools[k] > 0 ? TEXT.primary : TEXT.dim])
    parts.push([' errors ', TEXT.dim], [String(s.errors), s.errors > 0 ? STATUS.failed : TEXT.dim])
    if (s.stuck) parts.push(['  ', TEXT.dim], [`${GLYPH.stuck} stuck`, STATUS.warn])
    const end = writeParts(grid, x, row(4), parts, maxX, bg)
    const words = guardWords(a, now)
    if (words !== null && maxX - [...words].length >= end + 2) writeRight(grid, row(4), [[words, STATUS.warn]], end + 2, maxX, bg)
  }
  // 5: files, messages, clashes
  if (rows > 5) {
    const right: Part[] = [[`msgs ↓${s.messagesIn} ↑${s.messagesOut}`, TEXT.dim]]
    if (s.clashes.length > 0) {
      const path = s.clashes[0]!
      const blocked = s.blockedClashes.includes(path)
      // The same 32 cells either way: ' (blocked)' takes 10 of them from the path.
      right.push(['  ', TEXT.dim], [`${GLYPH.clash} clash ${clipText(path, blocked ? 22 : 32)}${blocked ? ' (blocked)' : ''}`, STATUS.failed])
    }
    const start = writeRight(grid, row(5), right, x, maxX, bg)
    const limit = Math.max(x, start - 1)
    const cx = writeParts(grid, x, row(5), [['files ', TEXT.dim], [String(s.files.length), TEXT.primary]], limit, bg)
    const room = limit - (cx + 2)
    if (s.files.length > 0 && room > 0) writeParts(grid, cx, row(5), [['  ', TEXT.dim], [clipText(s.files.slice(-2).join(', '), room), TEXT.dim]], limit, bg)
  }
}
