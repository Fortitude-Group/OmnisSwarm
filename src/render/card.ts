/**
 * The GIF's summary card (pane.md 13.4): 60x14 cells centred over the graph for the clip's last 3 s, the graph dimmed
 * behind it. Every figure comes from the swarm state and CardInfo, never from the clip's frames. Pure.
 */
import type { SwarmState } from '../core/fold.ts'
import { agentStatus, type AgentStatus, type SwarmTotals } from '../core/stats.ts'
import { DEFAULT, mix } from './color.ts'
import { fmtUsd } from './format.ts'
import { Grid, writeParts, type Part } from './grid.ts'
import { fmtClock } from './header.ts'
import { ACCENT, CANVAS, CANVAS_RAISED, GLYPH, MODEL, STATUS, TEXT, modelFamily, type ModelFamily } from './tokens.ts'
import type { Rect } from './types.ts'

export const CARD_W = 60
export const CARD_H = 14

/**
 * `durationMs`: the swarm's wall-clock length (swarmDurationMs), shown on the figure row and in "of work".
 * `clipMs`: the replay part's length, the "in Y s". `endedAt`: when the swarm ended, null if it never did.
 */
export type CardInfo = { durationMs: number; clipMs: number; endedAt: number | null }

/** Start to end, or to the last event when the swarm never ended; 0 when the start is unknown. The one duration figure. */
export function swarmDurationMs(state: SwarmState): number {
  const start = state.swarm.startedAt
  if (start === null) return 0
  const ms = (state.swarm.endedAt ?? state.lastAt) - start
  return Number.isFinite(ms) && ms > 0 ? ms : 0
}

/** 60x14 centred in the graph region (clipped to it when the graph is smaller). */
export function cardRect(graph: Rect): Rect {
  const w = Math.min(CARD_W, graph.w)
  const h = Math.min(CARD_H, graph.h)
  return { x: graph.x + Math.floor((graph.w - w) / 2), y: graph.y + Math.floor((graph.h - h) / 2), w, h }
}

/** `12m 40s`; `1h 05m` from an hour. */
export function fmtDur(ms: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(ms) ? ms / 1000 : 0))
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

const pad2 = (n: number): string => String(n).padStart(2, '0')
/** Times on the card are in the local time zone of the machine drawing it, as the export's file name is. */
const ymd = (ms: number): string => { const d = new Date(ms); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` }
const hhmm = (ms: number): string => { const d = new Date(ms); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}` }

/** The mark (13.4): three nodes and their links, 8x6 pixels. */
const MARK = ['...OO...', '...OO...', '..A..A..', '.A....A.', 'SS....FF', 'SS.AA.FF'] as const
const MARK_KEY: Readonly<Record<string, number>> = { O: MODEL.opus, S: MODEL.sonnet, F: MODEL.fable, A: ACCENT }
const SEP: Part = [' · ', TEXT.faint]
const STATUS_ORDER: readonly AgentStatus[] = ['running', 'done', 'failed', 'waiting']
const FAMILIES = Object.keys(MODEL) as ModelFamily[]

/** The mark as half-blocks, its top-left pixel at card pixel (3, 2): cell rows 1-3, columns 3-10. */
function drawMark(card: Grid): void {
  for (let row = 0; row < MARK.length / 2; row++) {
    for (let x = 0; x < 8; x++) {
      const top = MARK_KEY[MARK[row * 2]![x]!]
      const bottom = MARK_KEY[MARK[row * 2 + 1]![x]!]
      const cx = 3 + x
      const cy = 1 + row
      if (top !== undefined && top === bottom) card.set(cx, cy, 0x2588, top, CANVAS_RAISED)
      else if (top !== undefined) card.set(cx, cy, 0x2580, top, bottom ?? CANVAS_RAISED)
      else if (bottom !== undefined) card.set(cx, cy, 0x2584, bottom, CANVAS_RAISED)
    }
  }
}

function cardGrid(state: SwarmState, totals: SwarmTotals, info: CardInfo): Grid {
  const card = new Grid(CARD_W, CARD_H, CANVAS_RAISED, TEXT.primary)
  const max = CARD_W - 2
  const line = (x: number, y: number, parts: readonly Part[]): number => writeParts(card, x, y, parts, max, CANVAS_RAISED)
  for (let x = 0; x < CARD_W; x++) card.set(x, 0, 0x2580, ACCENT, CANVAS_RAISED)
  drawMark(card)
  line(13, 1, [['Omnis', ACCENT], ['Swarm', TEXT.primary]])
  line(13, 2, [['swarm replay', TEXT.dim]])
  line(3, 5, [
    [state.swarm.name, TEXT.primary], SEP, [state.swarm.topology, TEXT.dim],
    ...(info.endedAt !== null ? [SEP, [`ended ${hhmm(info.endedAt)}`, TEXT.dim] as Part] : []),
  ])

  // Every named agent, the lead included, as the header counts them; the status and model rows add up to the same.
  const agents = Object.values(state.agents).filter(a => !a.placeholder)
  const messages = Object.values(state.links).reduce((n, l) => n + l.count, 0)
  const figures: readonly [string, string][] = [
    [String(agents.length), 'agents'],
    [fmtDur(info.durationMs), 'duration'],
    [`${fmtUsd(totals.costUsd)}${totals.costPartial ? '+' : ''}`, 'cost'],
    [String(messages), 'messages'],
  ]
  figures.forEach(([figure, label], i) => {
    const x = 3 + 14 * i
    writeParts(card, x, 7, [[figure, TEXT.primary]], x + 13, CANVAS_RAISED)
    writeParts(card, x, 8, [[label, TEXT.dim]], x + 13, CANVAS_RAISED)
  })

  const counts = new Map<AgentStatus, number>()
  for (const a of agents) { const s = agentStatus(a, state.lastAt); counts.set(s, (counts.get(s) ?? 0) + 1) }
  const statusParts = STATUS_ORDER.filter(s => (counts.get(s) ?? 0) > 0)
    .flatMap((s, i): Part[] => [...(i > 0 ? [['   ', TEXT.dim] as Part] : []), [GLYPH[s], STATUS[s]], [` ${counts.get(s)} ${s}`, TEXT.dim]])
  line(3, 10, statusParts)

  const byFamily = new Map<ModelFamily, number>()
  for (const a of agents) if (a.model !== null) byFamily.set(modelFamily(a.model), (byFamily.get(modelFamily(a.model)) ?? 0) + 1)
  const modelParts = FAMILIES.filter(f => (byFamily.get(f) ?? 0) > 0)
    .flatMap((f, i): Part[] => [...(i > 0 ? [['   ', TEXT.dim] as Part] : []), [GLYPH.dot, MODEL[f]], [` ${f} ${byFamily.get(f)}`, TEXT.dim]])
  line(3, 11, modelParts)

  const start = state.swarm.startedAt
  line(3, 12, [[`${start !== null ? `${ymd(start)} · ` : ''}${fmtClock(info.durationMs)} of work in ${Math.round(info.clipMs / 1000)} s`, TEXT.dim]])
  return card
}

const fade = (c: number, to: number, t: number): number => (c === DEFAULT ? c : mix(c, to, t))

/**
 * Dims every graph cell outside the card 0.5·k toward CANVAS, then mixes the card k over the dimmed cells beneath
 * (k = 1/3, 2/3, 1 for the fade-in). The bottom grid is not touched.
 */
export function drawCard(top: Grid, graph: Rect, state: SwarmState, totals: SwarmTotals, info: CardInfo, k: number): void {
  const r = cardRect(graph)
  const t = Number.isFinite(k) ? Math.max(0, Math.min(1, k)) : 1
  for (let y = graph.y; y < graph.y + graph.h; y++) {
    for (let x = graph.x; x < graph.x + graph.w; x++) {
      if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) continue
      top.set(x, y, top.glyph(x, y), fade(top.fg(x, y), CANVAS, 0.5 * t), fade(top.bg(x, y), CANVAS, 0.5 * t))
    }
  }
  const card = cardGrid(state, totals, info)
  for (let y = 0; y < r.h; y++) {
    for (let x = 0; x < r.w; x++) {
      const gx = r.x + x
      const gy = r.y + y
      const under = top.bg(gx, gy)
      const base = under === DEFAULT ? CANVAS : under
      const bg = mix(base, card.bg(x, y), t)
      // A blank card cell lets the graph's glyph fade out beneath it until the card is whole; card glyphs fade in.
      if (card.glyph(x, y) === 0x20 && t < 1) {
        const fgUnder = top.fg(gx, gy)
        top.set(gx, gy, top.glyph(gx, gy), mix(fgUnder === DEFAULT ? base : fgUnder, card.bg(x, y), t), bg)
      } else top.set(gx, gy, card.glyph(x, y), mix(base, card.fg(x, y), t), bg)
    }
  }
}
