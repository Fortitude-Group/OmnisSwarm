/** The graph: nodes, links, comets, tool pulses and file clashes on the pixel and dot layers, then labels in cells. Pure. */
import { LEAD, type AgentState, type SwarmState } from '../core/fold.ts'
import type { AgentStats, Clash } from '../core/stats.ts'
import { Dots, Pixels, compose, toDots } from './canvas.ts'
import { desaturate, mix, quantise, scale } from './color.ts'
import { clipText } from './format.ts'
import { arc, blink, comet, fadeIn, flash, ghost, glow, hashUnit } from './fx.ts'
import { type Grid, type Part, cp } from './grid.ts'
import { type Edge, orderAgents, structuralEdges } from './layout.ts'
import { ACCENT, CANVAS, GLYPH, GRAPH, KIND, LINK, MOTION, RASTER_MAX, STATUS, TEXT, contextColor, modelColor, statusGlyph } from './tokens.ts'
import type { Point, Rect, View } from './types.ts'

export type GraphInput = {
  state: SwarmState
  stats: Readonly<Record<string, AgentStats>>
  positions: Readonly<Record<string, Point>>
  clashes: readonly Clash[]
  view: View
  now: number
  /** The time effects are drawn at: now less the arrival lag, so a comet starts at its sender. */
  tEff: number
  /** The swarm's structural edges, when the caller has them cached; otherwise worked out each frame. */
  edges?: readonly Edge[]
}

type Node = { id: string; p: Point; r: number; fill: number; s: AgentStats; a: AgentState }
type Rim = { color: number; k: number; flare: boolean } | null

/** Positions beyond this are treated as garbage; it keeps every loop below bounded. */
const FAR = 100_000
const MAX_STEPS = 4096

const WHITE = 0xffffff
const LABEL_MAX = 12

/** Node radius in pixels: grows with the log of total tokens, inside the graph's own limit. */
export function nodeRadius(tokens: number, maxRadius: number): number {
  const t = Number.isFinite(tokens) ? Math.max(0, tokens) : tokens > 0 ? 1e12 : 0
  const cap = Number.isNaN(maxRadius) ? GRAPH.minRadius : Math.max(GRAPH.minRadius, maxRadius)
  const r = GRAPH.minRadius + 0.9 * Math.log10(1 + t / 1000)
  return Math.max(GRAPH.minRadius, Math.min(GRAPH.maxRadius, cap, r))
}

/** Running: the model colour. Waiting: dimmer. Done: fades to a ghost. Failed: red. Everything fades in from the canvas. */
export function nodeColor(s: AgentStats, a: AgentState, now: number): number {
  const base = s.placeholder ? TEXT.faint : modelColor(s.model)
  let c = base
  if (s.status === 'failed') c = STATUS.failed
  else if (s.status === 'done') c = mix(base, mix(desaturate(base, 0.7), CANVAS, 0.55), quantise(ghost(a.finishedAt, now), 6))
  else if (s.status === 'waiting') c = scale(base, 0.72)
  return mix(CANVAS, c, quantise(fadeIn(a.startedAt, now), 8))
}

/** The largest node radius for these centres: about 0.4 of the gap to the nearest neighbour, so dense layers shrink. */
export function radiusCap(points: readonly Point[], area: Rect): number {
  const sorted = [...points].sort((p, q) => p.x - q.x || p.y - q.y)
  let nearest = Number.POSITIVE_INFINITY
  for (let i = 0; i < sorted.length; i++) {
    // Once the gap is below this the cap sits at its floor, so the exact value no longer matters.
    if (nearest <= GRAPH.minRadius / 0.4) break
    for (let j = i + 1; j < sorted.length && sorted[j]!.x - sorted[i]!.x < nearest; j++) {
      nearest = Math.min(nearest, Math.hypot(sorted[j]!.x - sorted[i]!.x, sorted[j]!.y - sorted[i]!.y))
    }
  }
  const fit = Math.max(GRAPH.minRadius, (area.h * 2) / 7)
  return Math.min(GRAPH.maxRadius, fit, Math.max(GRAPH.minRadius, 0.4 * nearest))
}

/**
 * The bend for an arc from a to b: GRAPH.linkBend, raised (up to GRAPH.linkBendMax) until the arc's peak clears every
 * obstacle between the ends. A quadratic arc with its control point over the midpoint sits 2t(1-t) x bend x length off the
 * line at the fraction t along it.
 */
export function bendFor(a: Point, b: Point, obstacles: readonly { p: Point; reach: number }[]): number {
  const len = Math.hypot(b.x - a.x, b.y - a.y)
  if (!(len > 0)) return GRAPH.linkBend
  const ux = (b.x - a.x) / len
  const uy = (b.y - a.y) / len
  let bend: number = GRAPH.linkBend
  for (let pass = 0; pass < 2; pass++) {
    for (const o of obstacles) {
      const ox = o.p.x - a.x
      const oy = o.p.y - a.y
      const t = (ox * ux + oy * uy) / len
      if (!(t > 0 && t < 1)) continue
      const side = -ox * uy + oy * ux
      const k = 2 * t * (1 - t) * len
      if (Math.abs(bend * k - side) < o.reach) bend = Math.max(bend, (side + o.reach) / k)
    }
  }
  return Math.min(GRAPH.linkBendMax, bend)
}

export function lastEditAt(state: SwarmState, path: string): number {
  const edits = Object.hasOwn(state.edits, path) ? state.edits[path]! : []
  return edits.reduce((latest, e) => Math.max(latest, e.at), Number.NEGATIVE_INFINITY)
}

/** A clash flashes for MOTION.clashFlashMs after its latest edit; its dashed line stays while it is live. */
export const clashActive = (state: SwarmState, clash: Clash, now: number): boolean =>
  flash(lastEditAt(state, clash.path), now, MOTION.clashFlashMs) > 0

/** The node's centre moved by (-cx, -cy) pixels, for an area whose top left was clipped off. */
function posOf(positions: Readonly<Record<string, Point>>, id: string, cx: number, cy: number): Point | null {
  const p = Object.hasOwn(positions, id) ? positions[id] : undefined
  return p !== undefined && Math.abs(p.x) <= FAR && Math.abs(p.y) <= FAR ? { x: p.x - cx, y: p.y - cy } : null
}

/** The segment from a to b with `ra` and `rb` cut off the ends, so lines stop at node edges; null when they overlap. */
function trimmed(a: Point, b: Point, ra: number, rb: number): [Point, Point] | null {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  if (len <= ra + rb) return null
  const ux = dx / len
  const uy = dy / len
  return [{ x: a.x + ux * ra, y: a.y + uy * ra }, { x: b.x - ux * rb, y: b.y - uy * rb }]
}

/** The strongest live pulse per agent: its colour and how far it has faded. */
function pulseRims(view: View, tEff: number): Map<string, NonNullable<Rim>> {
  const out = new Map<string, NonNullable<Rim>>()
  for (const p of view.pulses) {
    const k = quantise(flash(p.at, tEff, p.isError ? MOTION.errorPulseMs : MOTION.pulseMs), 4)
    if (k <= 0 || (out.get(p.agent)?.k ?? 0) >= k) continue
    out.set(p.agent, { color: p.isError ? STATUS.failed : KIND[p.kind], k, flare: true })
  }
  return out
}

function paintNode(px: Pixels, n: Node, glowK: number, ring: { fill: number; color: number } | null, rim: Rim): void {
  const reach = n.r + GRAPH.ringPx + GRAPH.glowPx + 1
  for (let y = Math.floor(n.p.y - reach); y <= Math.ceil(n.p.y + reach); y++) {
    for (let x = Math.floor(n.p.x - reach); x <= Math.ceil(n.p.x + reach); x++) {
      const dx = x + 0.5 - n.p.x
      const dy = y + 0.5 - n.p.y
      const d = Math.hypot(dx, dy)
      if (d <= n.r) {
        px.set(x, y, mix(n.fill, WHITE, quantise(1 - d / n.r, 4) * 0.28))
        if (rim !== null && d > n.r - 1) px.blend(x, y, rim.color, rim.k)
      } else if (ring !== null && d <= n.r + GRAPH.ringPx) {
        let angle = Math.atan2(dx, -dy)
        if (angle < 0) angle += 2 * Math.PI
        px.set(x, y, angle / (2 * Math.PI) <= ring.fill ? ring.color : mix(CANVAS, TEXT.faint, 0.35))
      } else if (d <= n.r + GRAPH.ringPx + GRAPH.glowPx) {
        if (glowK > 0) {
          const k = quantise(1 - (d - n.r) / (GRAPH.ringPx + GRAPH.glowPx), 5) * glowK
          px.light(x, y, n.fill, k * 0.8)
        }
        // One pixel band outside the ring, so a flicker the same hue as the node still shows.
        if (rim !== null && rim.flare && d > n.r + GRAPH.ringPx && d <= n.r + GRAPH.ringPx + 1) px.light(x, y, rim.color, 0.6 * rim.k)
      }
    }
  }
}

/** Dots along `path` (t from 0 to 1), about two to each pixel of `length`. */
function dotPath(dots: Dots, path: (t: number) => Point, length: number, color: number): void {
  const steps = Math.min(MAX_STEPS, Math.max(2, Math.ceil(length * 2)))
  for (let i = 0; i <= steps; i++) {
    const d = toDots(path(i / steps))
    dots.dot(d.x, d.y, color)
  }
}

/** Cells holding a node's disc or ring: labels keep clear of them. */
function solidCells(area: Rect, nodes: readonly Node[]): Uint8Array {
  const solid = new Uint8Array(area.w * area.h)
  for (const n of nodes) {
    const reach = n.r + GRAPH.ringPx
    const y0 = Math.max(0, Math.floor((n.p.y - reach) / 2))
    const y1 = Math.min(area.h - 1, Math.floor((n.p.y + reach) / 2))
    const x0 = Math.max(0, Math.floor(n.p.x - reach))
    const x1 = Math.min(area.w - 1, Math.floor(n.p.x + reach))
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) solid[y * area.w + x] = 1
  }
  return solid
}

function labels(grid: Grid, area: Rect, nodes: readonly Node[]): void {
  const used = new Uint8Array(area.w * area.h)
  const solid = solidCells(area, nodes)
  for (const n of nodes) {
    const row = Math.max(0, Math.min(area.h - 1, Math.floor((n.p.y + n.r + GRAPH.ringPx) / 2) + 1))
    const isLead = n.id === LEAD
    const status = statusGlyph(n.s.status, n.s.placeholder)
    const statusColor = STATUS[n.s.status]
    const nameColor = n.s.status === 'failed' ? STATUS.failed : n.s.status === 'running' ? TEXT.primary : TEXT.dim
    const name = clipText(n.s.name, LABEL_MAX)
    // Each part is [text, colour]. The lead reads `◆ lead ▶`: its glyph is the mark, so the status follows the name.
    const stuck: Part[] = n.s.stuck ? [[` ${GLYPH.stuck}`, STATUS.warn]] : []
    const full: Part[] = isLead
      ? [[GLYPH.lead, ACCENT], [` ${name}`, nameColor], [` ${status}`, statusColor], ...stuck]
      : [[status, statusColor], [` ${name}`, nameColor], ...stuck]
    const short: Part[] = isLead ? [[GLYPH.lead, ACCENT], [status, statusColor]] : [[status, statusColor]]
    for (const parts of [full, short]) {
      const cells = parts.flatMap(([text, color]) => [...text].map(ch => [ch, color] as const))
      if (cells.length > area.w) continue
      const x0 = Math.max(0, Math.min(area.w - cells.length, Math.round(n.p.x - cells.length / 2)))
      // The span and one cell either side must be free of other labels and of node pixels.
      const from = Math.max(0, x0 - 1)
      const to = Math.min(area.w - 1, x0 + cells.length)
      let clear = true
      for (let x = from; x <= to && clear; x++) if (used[row * area.w + x] === 1 || solid[row * area.w + x] === 1) clear = false
      if (!clear) continue
      // Lines that run through the padded span are cleared to blanks; the cell keeps its background.
      for (let x = from; x <= to; x++) {
        const g = grid.glyph(area.x + x, area.y + row)
        if (g > 0x2800 && g <= 0x28ff) grid.set(area.x + x, area.y + row, 0x20, grid.fg(area.x + x, area.y + row))
      }
      cells.forEach(([ch, color], i) => {
        used[row * area.w + x0 + i] = 1
        grid.set(area.x + x0 + i, area.y + row, cp(ch), color)
      })
      break
    }
  }
}

export function drawGraph(grid: Grid, full: Rect, input: GraphInput): void {
  const { state, stats, positions, clashes, view, now, tEff } = input
  if (![full.x, full.y, full.w, full.h].every(v => !Number.isNaN(v))) return
  // A negative origin clips the area; the positions move left and up by what was cut off.
  const x = Math.floor(full.x)
  const y = Math.floor(full.y)
  const cutX = Math.max(0, -x)
  const cutY = Math.max(0, -y)
  const area: Rect = {
    x: Math.max(0, x),
    y: Math.max(0, y),
    w: Math.floor(Math.min(full.w - cutX, grid.columns - Math.max(0, x), RASTER_MAX.columns)),
    h: Math.floor(Math.min(full.h - cutY, grid.rows - Math.max(0, y), RASTER_MAX.rows)),
  }
  if (area.w < 1 || area.h < 1) return
  const px = new Pixels(area.w, area.h * 2, CANVAS)
  const dots = new Dots(area.w, area.h)
  const placed: { a: AgentState; p: Point; s: AgentStats }[] = []
  for (const a of orderAgents(state)) {
    const p = posOf(positions, a.id, cutX, cutY * 2)
    const s = Object.hasOwn(stats, a.id) ? stats[a.id]! : null
    if (p !== null && s !== null) placed.push({ a, p, s })
  }
  const maxR = radiusCap(placed.map(n => n.p), area)
  const nodes = new Map<string, Node>()
  for (const { a, p, s } of placed) {
    const room = Math.min(p.y, area.h * 2 - 2 - p.y, p.x, area.w - p.x) - GRAPH.ringPx - 0.5
    const r = s.placeholder ? GRAPH.minRadius : nodeRadius(s.tokens.total, Math.min(maxR, Math.max(GRAPH.minRadius, room)))
    nodes.set(a.id, { id: a.id, p, r, fill: nodeColor(s, a, now), s, a })
  }
  const segment = (from: string, to: string, gap = 1): [Point, Point] | null => {
    const a = nodes.get(from)
    const b = nodes.get(to)
    return a === undefined || b === undefined ? null : trimmed(a.p, b.p, a.r + gap, b.r + gap)
  }
  const obstacles = [...nodes.values()].map(n => ({ id: n.id, p: n.p, reach: n.r + GRAPH.ringPx + 1 }))
  const bends = new Map<string, number>()
  const bendOf = (from: string, to: string, seg: [Point, Point]): number => {
    const key = `${from} ${to}`
    const known = bends.get(key)
    if (known !== undefined) return known
    const bend = bendFor(seg[0], seg[1], obstacles.filter(o => o.id !== from && o.id !== to))
    bends.set(key, bend)
    return bend
  }
  const recency = (lastAt: number): number => quantise(flash(lastAt, tEff, MOTION.linkFadeMs), 5)

  // 1. Busy links as dim pixel arcs, under the nodes.
  for (const link of Object.values(state.links)) {
    if (link.count < GRAPH.linkThick[1]) continue
    const seg = segment(link.from, link.to, 0.5)
    if (seg === null) continue
    const path = arc(seg[0], seg[1], bendOf(link.from, link.to, seg))
    const steps = Math.min(MAX_STEPS, Math.max(2, Math.ceil(Math.hypot(seg[1].x - seg[0].x, seg[1].y - seg[0].y))))
    const color = mix(LINK.idle, LINK.active, recency(link.lastAt))
    for (let i = 0; i <= steps; i++) {
      const p = path(i / steps)
      px.blend(p.x, p.y, color, 0.45)
    }
  }

  // 2. Nodes, with glow, context ring and rim.
  const rims = pulseRims(view, tEff)
  const flashing = new Set<string>()
  for (const c of clashes) if (clashActive(state, c, now) && blink(now, MOTION.clashBlinkMs)) for (const id of c.agents) flashing.add(id)
  for (const n of nodes.values()) {
    const seed = hashUnit(n.id)
    const rim: Rim = flashing.has(n.id) ? { color: LINK.clash, k: 0.9, flare: false }
      : rims.get(n.id) ?? (n.s.stuck ? { color: STATUS.warn, k: quantise(0.3 + 0.6 * glow(now, seed), 4), flare: false } : null)
    const fill = n.s.contextFill
    const glowK = n.s.status === 'running' ? quantise(0.45 + 0.55 * glow(now, seed), 5) : 0
    paintNode(px, n, glowK, fill !== null && n.r >= 2.2 ? { fill, color: contextColor(fill) } : null, rim)
  }

  // 3. The swarm's shape: faint dotted edges.
  for (const e of input.edges ?? structuralEdges(state, state.swarm.topology)) {
    const seg = segment(e.from, e.to)
    if (seg !== null) dots.line(toDots(seg[0]), toDots(seg[1]), mix(CANVAS, TEXT.faint, 0.6), 2)
  }

  // 4. Message links as arcs: brighter for a while after each message, doubled once busy.
  for (const link of Object.values(state.links)) {
    const seg = segment(link.from, link.to)
    if (seg === null) continue
    // A quiet link shows only while recent and fades out; a busy one stays and settles back to idle.
    const rec = recency(link.lastAt)
    const busy = link.count >= GRAPH.linkThick[0]
    if (!busy && rec <= 0) continue
    const color = busy ? mix(LINK.idle, LINK.active, rec) : mix(CANVAS, LINK.active, rec)
    const length = Math.hypot(seg[1].x - seg[0].x, seg[1].y - seg[0].y)
    const bend = bendOf(link.from, link.to, seg)
    dotPath(dots, arc(seg[0], seg[1], bend), length, color)
    if (busy) dotPath(dots, arc(seg[0], seg[1], bend + GRAPH.busyArcOffset), length, color)
  }

  // 5. File clashes: a dashed red line between the agents editing the same file.
  for (const c of clashes) {
    for (let i = 0; i + 1 < c.agents.length; i++) {
      const seg = segment(c.agents[i]!, c.agents[i + 1]!)
      if (seg !== null) dots.line(toDots(seg[0]), toDots(seg[1]), LINK.clash, 3)
    }
  }

  // 6. Comets along the arcs of recent messages: every trail first, every head last, so a head is never painted over.
  const heads: Point[] = []
  for (const item of state.feed) {
    if (item.kind !== 'message' || item.to === undefined) continue
    const seg = segment(item.agent, item.to)
    if (seg === null) continue
    for (const spark of comet(arc(seg[0], seg[1], bendOf(item.agent, item.to, seg)), item.at, tEff)) {
      if (spark.k === 1) heads.push(spark.p)
      else {
        const d = toDots(spark.p)
        dots.dot(d.x, d.y, mix(CANVAS, LINK.active, quantise(spark.k, 4)))
      }
    }
  }
  for (const p of heads) {
    const d = toDots(p)
    dots.dot(d.x, d.y, LINK.comet)
    dots.dot(d.x + 1, d.y, LINK.comet)
    px.light(p.x, p.y, LINK.active, 0.35)
  }

  compose(grid, area, px, dots)
  labels(grid, area, [...nodes.values()])
}
