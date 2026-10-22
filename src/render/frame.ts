/** One frame of the pane: render(state, view, now, size) gives the two grids, the chips and how fast to animate. Pure. */
import type { SwarmState } from '../core/fold.ts'
import { agentStats, fileClashes, swarmTotals, type AgentStats, type Clash } from '../core/stats.ts'
import { luminance, scale } from './color.ts'
import { drawFeed } from './feed.ts'
import { clipText } from './format.ts'
import { FULL_MOTION, motionFor, tween, type Motion } from './fx.ts'
import { clashActive, drawGraph } from './graph.ts'
import { Grid, limitPairs, writeParts, type Part } from './grid.ts'
import { dropsFor } from './guard-badge.ts'
import { drawHeader, drawSummary, summaryText, type HeaderNotes } from './header.ts'
import { layoutNodes, nodesKey, orderAgents, structuralEdges, type Edge } from './layout.ts'
import { planRegions } from './regions.ts'
import { nextBlinkAt, robotCrowded } from './robot.ts'
import { busiest, drawSpotlight } from './spotlight.ts'
import { drawTimeline } from './timeline.ts'
import { CANVAS, CANVAS_RAISED, FPS, GRAPH, MOTION, PAIR_BUDGET, STATUS, TEXT, modelColor } from './tokens.ts'
import { drawTree } from './tree.ts'
import type { Chip, Frame, Point, ReplayNote, Size, View } from './types.ts'

const MAX_LAG_MS = 1_000
const CHIP_LABEL = 14
/** Chip dots are darkened to this relative luminance so they read on light and dark terminal themes alike (pane.md section 2). */
const CHIP_LUMINANCE = 0.18
const lagOf = (view: View): number => Math.max(0, Math.min(MAX_LAG_MS, Number.isFinite(view.lagMs) ? view.lagMs : 0))

/**
 * What the pane knows about the last read beyond the swarm state; both come from the pane model. `wordmark`: the GIF
 * draws `OmnisSwarm` at the end of header row 0 (pane.md 13.4); the pane never sets it.
 */
export type Notes = { degraded?: 'too-large' | 'unreadable' | null; degradedAgents?: number; hiddenFinished?: number; replay?: ReplayNote | null; wordmark?: true }

const chipColors = new Map<number, number>()
/** The model colour scaled down (halving the interval 20 times) until its luminance is at most CHIP_LUMINANCE. */
export function chipColor(c: number): number {
  const known = chipColors.get(c)
  if (known !== undefined) return known
  let out = c
  if (luminance(c) > CHIP_LUMINANCE) {
    let lo = 0
    let hi = 1
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2
      if (luminance(scale(c, mid)) <= CHIP_LUMINANCE) lo = mid
      else hi = mid
    }
    out = scale(c, lo)
  }
  chipColors.set(c, out)
  return out
}

/**
 * pane.md section 6. FPS.busy while a comet, fade-in, pulse or glide is live; FPS.glow while a glow, stuck rim, ghost
 * fade, link fade or clash blink is; otherwise FPS.tick, because ages and live bars follow the clock. A motion the
 * budget has dropped (`motion`) is drawn steady, so it asks for nothing. The pane stops its loop when it is hidden.
 */
export function targetFps(
  state: SwarmState, view: View, nowMs: number, stats: Readonly<Record<string, AgentStats>>, clashes: readonly Clash[], motion: Readonly<Motion> = FULL_MOTION,
): number {
  const t = nowMs - lagOf(view)
  if (motion.comets) for (const item of state.feed) if (item.kind === 'message' && t >= item.at && t - item.at <= MOTION.cometMs + MOTION.trailMs) return FPS.busy
  if (motion.fadeIn) for (const a of Object.values(state.agents)) if (nowMs >= a.startedAt && nowMs - a.startedAt < MOTION.fadeInMs) return FPS.busy
  for (const p of view.pulses) if (t >= p.at && t - p.at <= (p.isError ? MOTION.errorPulseMs : MOTION.pulseMs)) return FPS.busy
  if (motion.glide && view.tween !== null && nowMs - view.tween.at < MOTION.tweenMs) return FPS.busy
  if (motion.breathe) for (const s of Object.values(stats)) if (!s.placeholder && (s.status === 'running' || s.stuck)) return FPS.glow
  if (motion.slowFades) {
    for (const a of Object.values(state.agents)) if (a.finishedAt !== null && nowMs >= a.finishedAt && nowMs - a.finishedAt < MOTION.ghostMs) return FPS.glow
    for (const l of Object.values(state.links)) if (t >= l.lastAt && t - l.lastAt < MOTION.linkFadeMs) return FPS.glow
  }
  if (motion.clashBlink && clashes.some(c => clashActive(state, c, nowMs))) return FPS.glow
  return FPS.tick
}

/** The pane may spend at most a tenth of the main thread on render (pane.md section 6): an interval is at least this many renders. */
const BUDGET_FACTOR = 10

/** The most frames a second the budget allows after a frame that took `renderMs`; unlimited when it took no measurable time. */
export const budgetFps = (renderMs: number): number =>
  Number.isFinite(renderMs) && renderMs > 0 ? 1000 / (BUDGET_FACTOR * renderMs) : Number.POSITIVE_INFINITY

/** The longest frame interval: one freak frame (a long GC pause, a suspended laptop) must not freeze the clock text. */
export const MAX_INTERVAL_MS = 10_000

/**
 * The next frame interval in ms: the target rate's, but at least 10 x the last frame's render time, so render never
 * takes more than 100 ms of a second, and never over MAX_INTERVAL_MS. A frame under the cap falls straight back to
 * the target rate. 0 means stop.
 */
export function frameInterval(fps: number, renderMs: number): number {
  if (!(fps > 0)) return 0
  const spent = Number.isFinite(renderMs) && renderMs > 0 ? renderMs : 0
  return Math.min(MAX_INTERVAL_MS, Math.max(Math.round(1000 / fps), Math.ceil(BUDGET_FACTOR * spent)))
}

/** How much each new render time moves the average the motion cap is set from. */
const RENDER_EWMA = 0.3

/**
 * The render time the motion cap follows: a moving average, so one slow frame does not drop a motion and the mode
 * does not flip frame to frame near a threshold. The frame interval still follows the last frame alone.
 */
export function smoothRenderMs(averageMs: number, sampleMs: number): number {
  const sample = Number.isFinite(sampleMs) && sampleMs > 0 ? sampleMs : 0
  const average = Number.isFinite(averageMs) && averageMs > 0 ? averageMs : 0
  return average + RENDER_EWMA * (sample - average)
}

/**
 * Layout work that depends only on the nodes, cached until they change: order, edges, positions per canvas size.
 * A state object is checked first by its event count (the pane folds events into the same object, and hands the same
 * object back when nothing arrived); otherwise the nodes' key decides, so a fresh state with the same nodes reuses it.
 */
type Sized = { positions: Record<string, Point>; crowded: boolean; robotCrowded?: boolean }
type Shape = { key: string; ids: string[]; edges: Edge[]; sized: Map<string, Sized> }
const shapeOfState = new WeakMap<SwarmState, { events: number; shape: Shape }>()
let lastShape: Shape | null = null

function shapeFor(state: SwarmState): Shape {
  const known = shapeOfState.get(state)
  if (known !== undefined && known.events === state.events) return known.shape
  const key = nodesKey(state)
  if (lastShape === null || lastShape.key !== key) {
    lastShape = { key, ids: orderAgents(state).map(a => a.id), edges: structuralEdges(state, state.swarm.topology), sized: new Map() }
  }
  shapeOfState.set(state, { events: state.events, shape: lastShape })
  return lastShape
}

/** Node centres closer than this (2 x (minRadius + ringPx) + 2, rounded up) overlap, discs and halos. */
const MIN_GAP = Math.ceil(2 * (GRAPH.minRadius + GRAPH.ringPx) + 2)

/** Whether any two node centres are closer than MIN_GAP. Bucketed by MIN_GAP, so it is linear and stops at the first pair. */
function crowded(positions: Readonly<Record<string, Point>>): boolean {
  const buckets = new Map<string, Point[]>()
  const cell = (v: number): number => Math.floor(v / MIN_GAP)
  for (const p of Object.values(positions)) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
    const bx = cell(p.x)
    const by = cell(p.y)
    for (let x = bx - 1; x <= bx + 1; x++) {
      for (let y = by - 1; y <= by + 1; y++) {
        for (const q of buckets.get(x + ',' + y) ?? []) if (Math.hypot(p.x - q.x, p.y - q.y) < MIN_GAP) return true
      }
    }
    const key = bx + ',' + by
    const list = buckets.get(key)
    if (list === undefined) buckets.set(key, [p])
    else list.push(p)
  }
  return false
}

/** The layout for a canvas size, with its crowding verdict; both are computed once and kept with the shape. */
function positionsFor(state: SwarmState, s: Shape, w: number, h: number): Sized {
  const size = `${w}x${h}`
  let entry = s.sized.get(size)
  if (entry === undefined) {
    if (s.sized.size >= 4) s.sized.clear()
    const positions = layoutNodes(state, state.swarm.topology, w, h)
    entry = { positions, crowded: crowded(positions) }
    s.sized.set(size, entry)
  }
  return entry
}

/**
 * The frame at `nowMs`. `capFps` is the budget cap from the last frame's render time (budgetFps); under it the motions
 * pane.md section 6 lists are drawn steady. With no cap, everything moves.
 */
export function render(state: SwarmState, view: View, nowMs: number, size: Size, notes: Notes = {}, capFps = Number.POSITIVE_INFINITY): Frame {
  const motion = motionFor(capFps)
  const clashes = fileClashes(state, nowMs)
  const totals = swarmTotals(state, nowMs, clashes)
  const stats: Record<string, AgentStats> = {}
  for (const id of Object.keys(state.agents)) {
    const s = agentStats(state, id, nowMs, clashes)
    if (s !== null) stats[id] = s
  }
  const cached = shapeFor(state)
  // Placeholders are read fresh: whether a name has been seen is not part of the nodes' key.
  const real = cached.ids.flatMap(id => { const a = state.agents[id]; return a === undefined || a.placeholder ? [] : [a] })
  const realIds = new Set(real.map(a => a.id))
  const regions = planRegions(size, real.length)
  const top = new Grid(regions.top.columns, regions.top.rows, CANVAS, TEXT.primary)

  // A failed read keeps the last good state; say so in the header (warn colour, with a glyph, never colour alone).
  const count = notes.degradedAgents !== undefined && notes.degradedAgents > 0 ? notes.degradedAgents : real.length
  const noteParts: Part[] = []
  if (notes.degraded === 'too-large') noteParts.push([`⚠ Swarm too large to draw (${count} agents)`, STATUS.warn])
  else if (notes.degraded === 'unreadable') noteParts.push(['⚠ Waiting for the swarm…', STATUS.warn])
  if (notes.hiddenFinished !== undefined && notes.hiddenFinished > 0) noteParts.push([`+${notes.hiddenFinished} finished`, TEXT.dim])
  const short: Part | null = notes.degraded === 'too-large' ? ['⚠ too large', STATUS.warn] : notes.degraded === 'unreadable' ? ['⚠ waiting', STATUS.warn] : null
  const overBudget = real.reduce((n, a) => n + (dropsFor(a) > 0 ? 1 : 0), 0)
  const hn: HeaderNotes = { notes: noteParts, short, budget: view.budget ?? null, overBudget, replay: notes.replay ?? null, wordmark: notes.wordmark === true }

  let positions: Record<string, Point> = {}
  const robots = view.style === 'robot'
  let wakeAt: number | null = null
  if (regions.step === 'summary') drawSummary(top, regions.header, state, totals, hn)
  else {
    drawHeader(top, regions.header, state, totals, hn)
    if (regions.tree !== null) drawTree(top, regions.tree, state, stats)
    if (regions.graph !== null) {
      const target = positionsFor(state, cached, regions.graph.w, regions.graph.h * 2)
      positions = tween(target.positions, motion.glide ? view.tween : null, nowMs)
      // Legibility guard: with two node centres closer than the graph can draw apart, show the tree instead. Robots
      // need their smallest boxes, grown by a pixel, to stay apart.
      if (robots) target.robotCrowded ??= robotCrowded(target.positions)
      if (robots ? target.robotCrowded : target.crowded) drawTree(top, regions.graph, state, stats)
      else {
        drawGraph(top, regions.graph, {
          state, stats, positions, clashes, view, now: nowMs, tEff: nowMs - lagOf(view), edges: cached.edges, motion,
          style: robots ? 'robot' : 'globe', still: view.still === true,
        })
        if (robots && motion.breathe && view.still !== true) wakeAt = nextBlinkAt(stats, nowMs)
      }
    }
  }

  const pinned = view.pinned !== null && realIds.has(view.pinned) ? view.pinned : null
  const chosen = view.spotlight?.id ?? null
  const spotlight = pinned ?? (chosen !== null && realIds.has(chosen) ? chosen : busiest(state, view.pulses, nowMs))

  let bottom: Grid | null = null
  if (regions.bottom !== null) {
    bottom = new Grid(regions.bottom.columns, regions.bottom.rows, CANVAS, TEXT.primary)
    const spot = regions.spotlight
    if (spot !== null) {
      const s = spotlight === null ? null : (stats[spotlight] ?? null)
      if (s !== null && spotlight !== null) drawSpotlight(bottom, spot, s, state.agents[spotlight]!, nowMs, regions.step === 'compactSpotlight')
      else {
        bottom.fill(spot.x, spot.y, spot.w, spot.h, CANVAS_RAISED)
        writeParts(bottom, spot.x + 1, spot.y, [['No agents yet.', TEXT.dim]], spot.x + spot.w - 1, CANVAS_RAISED)
      }
    }
    if (regions.timeline !== null) drawTimeline(bottom, regions.timeline, state, nowMs)
    if (regions.feed !== null) drawFeed(bottom, regions.feed, state, nowMs)
  }

  const chips: Chip[] = regions.chips
    ? real.map(a => ({ id: a.id, label: clipText(a.name, CHIP_LABEL), color: chipColor(modelColor(a.model)), pinned: a.id === pinned }))
    : []
  limitPairs(top, PAIR_BUDGET.top)
  if (bottom !== null) limitPairs(bottom, PAIR_BUDGET.bottom)
  const treeKey = [
    regions.step, `${top.columns}x${top.rows}`, bottom === null ? '-' : `${bottom.columns}x${bottom.rows}`,
    ...chips.map(c => `${c.id}:${c.label}:${c.color}:${c.pinned ? 1 : 0}`),
  ].join('|')
  return {
    step: regions.step, top, bottom, chips, treeKey, nodesKey: cached.key, positions,
    fps: targetFps(state, view, nowMs, stats, clashes, motion), spotlight, alt: summaryText(state, totals),
    ...(wakeAt !== null && { wakeAt }),
  }
}
