/**
 * The robot node style (pane.md section 12): sizes and boxes, the look for an agent's state, and the painting. Every
 * rule here reads the skin contract (sprites.ts), never a pixel of one skin. Pure.
 */
import type { AgentState } from '../core/fold.ts'
import type { ToolKind } from '../core/events.ts'
import type { AgentStats } from '../core/stats.ts'
import type { Dots, Pixels } from './canvas.ts'
import { add, clamp01, desaturate, mix, quantise, scale } from './color.ts'
import { FULL_MOTION, fadeIn, flash, ghost, glow, hashUnit, type Motion } from './fx.ts'
import { ROBOT, ROBOT_SIZES, activeSkin, composite, type Arms, type Eyes, type RobotSize, type Skin } from './sprites.ts'
import { CANVAS, KIND, LINK, MOTION, STATUS, TEXT, contextColor, modelColor } from './tokens.ts'
import type { Point, View } from './types.ts'

export type PaneStyle = 'globe' | 'robot'
/** What the robot owns on the canvas: hop headroom, the sprite, then the bar row. Never moves during a hop. */
export type Box = { size: RobotSize; left: number; top: number; w: number; h: number }

const WHITE = 0xffffff
const RANK: Record<RobotSize, number> = { S: 0, M: 1, L: 2 }

/** The tone of `base` in an agent's state: waiting dimmer, done a ghost, failed `failed`, all faded in from the canvas. */
export function stateTone(base: number, s: AgentStats, a: AgentState, now: number, motion: Readonly<Motion>, failed: number): number {
  let c = base
  if (s.status === 'failed') c = failed
  else if (s.status === 'done') {
    const k = motion.slowFades ? quantise(ghost(a.finishedAt, now), 6) : a.finishedAt !== null && now >= a.finishedAt ? 1 : 0
    c = mix(base, mix(desaturate(base, 0.7), CANVAS, 0.55), k)
  } else if (s.status === 'waiting') c = scale(base, ROBOT.waitingTone)
  return mix(CANVAS, c, motion.fadeIn ? quantise(fadeIn(a.startedAt, now), 8) : now >= a.startedAt ? 1 : 0)
}

/** pane.md 12.3: the size step for a globe radius. */
export const sizeFor = (r: number): RobotSize => (r >= ROBOT.size.L.fromR ? 'L' : r >= ROBOT.size.M.fromR ? 'M' : 'S')

export function boxAt(p: Point, size: RobotSize, skin: Skin = activeSkin()): Box {
  const s = skin.sprites[size]
  const h = ROBOT.size[size].headroom + s.h + 1
  return { size, left: Math.round(p.x - s.w / 2), top: Math.round(p.y - h / 2), w: s.w, h }
}

/**
 * How far from `from` toward `to` the line stays inside `box` grown by 1 px (pixel edges left - 1 to left + w + 1), so
 * links stop at the robot's box rather than its globe radius.
 */
export function boxReach(box: Box, from: Point, to: Point): number {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const len = Math.hypot(dx, dy)
  if (!(len > 0)) return 0
  const exit = (d: number, p: number, lo: number, hi: number): number => (d > 0 ? (hi - p) / d : d < 0 ? (lo - p) / d : Number.POSITIVE_INFINITY)
  const t = Math.min(exit(dx, from.x, box.left - 1, box.left + box.w + 1), exit(dy, from.y, box.top - 1, box.top + box.h + 1))
  return Math.max(0, t) * len
}

/** Clears the braille dots in every cell the box touches. */
export function clearBoxDots(dots: Dots, box: Box): void {
  const y0 = Math.max(0, Math.floor(box.top / 2))
  const y1 = Math.min(dots.rows - 1, Math.floor((box.top + box.h - 1) / 2))
  const x0 = Math.max(0, box.left)
  const x1 = Math.min(dots.columns - 1, box.left + box.w - 1)
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) dots.bits[y * dots.columns + x] = 0
}

/** Whether any two boxes, each grown by 1 px on every side, overlap. A sweep along x, so sparse graphs are near linear. */
export function anyOverlap(boxes: readonly Box[]): boolean {
  const sorted = [...boxes].sort((a, b) => a.left - b.left)
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]!
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j]!
      if (b.left - 1 > a.left + a.w) break
      if (b.top - 1 <= a.top + a.h && a.top - 1 <= b.top + b.h) return true
    }
  }
  return false
}

/** The legibility guard for robots: even the smallest boxes would overlap, so the tree shows instead. */
export function robotCrowded(positions: Readonly<Record<string, Point>>): boolean {
  const boxes: Box[] = []
  for (const p of Object.values(positions)) if (Number.isFinite(p.x) && Number.isFinite(p.y)) boxes.push(boxAt(p, 'S'))
  return anyOverlap(boxes)
}

/**
 * pane.md 12.3, bucket rule: each node's size from its radius (placeholders S), no node bigger than the largest size
 * at which no two boxes overlap, then each stepped down while its box would leave the canvas.
 */
export function fitBoxes(nodes: readonly { id: string; p: Point; r: number; placeholder: boolean }[], width: number, height: number): Map<string, Box> {
  const own = nodes.map(n => (n.placeholder ? 'S' : sizeFor(n.r)))
  const at = (cap: RobotSize): Box[] => nodes.map((n, i) => boxAt(n.p, RANK[own[i]!] > RANK[cap] ? cap : own[i]!))
  let boxes = at('S')
  for (const cap of ['L', 'M'] as const) {
    const tried = at(cap)
    if (!anyOverlap(tried)) {
      boxes = tried
      break
    }
  }
  const leaves = (b: Box): boolean => b.top < 0 || b.left < 0 || b.left + b.w - 1 >= width || b.top + b.h - 1 > height - 3
  const out = new Map<string, Box>()
  nodes.forEach((n, i) => {
    let b = boxes[i]!
    while (b.size !== 'S' && leaves(b)) b = boxAt(n.p, ROBOT_SIZES[RANK[b.size] - 1]!)
    out.set(n.id, b)
  })
  return out
}

/** The live tool wave (step 3, 2 or 1) and error flash (step 4 down to 1) per agent; 0 when none. */
export type RobotPulse = { wave: number; kind: ToolKind; error: number }

/**
 * Each agent's newest live tool pulse and error pulse, as steps: the window cut into 3 (tool) or 4 (error) equal steps,
 * counting down. Degraded, a pulse does not step: a tool is held arms up and an error red, for at least a frame.
 */
export function robotPulses(view: View, tEff: number, motion: Readonly<Motion>): Map<string, RobotPulse> {
  const out = new Map<string, RobotPulse & { waveAt: number; errorAt: number }>()
  for (const p of view.pulses) {
    if (p.coalesced === true || !Number.isFinite(p.at)) continue
    const ms = p.isError ? MOTION.errorPulseMs : MOTION.pulseMs
    const steps = p.isError ? 4 : 3
    const age = tEff - p.at
    // pane.md 12.5 names steps N..1 over the window (`q3(flash)` 3, 2, 1), so a step is ceil(flash x N), not quantise().
    const step = motion.pulseFade ? Math.ceil(flash(p.at, tEff, ms) * steps) : age >= 0 && age < Math.max(ms, motion.pulseHoldMs) ? steps : 0
    if (step <= 0) continue
    const cur = out.get(p.agent) ?? { wave: 0, kind: 'other' as ToolKind, error: 0, waveAt: -Infinity, errorAt: -Infinity }
    if (p.isError && p.at >= cur.errorAt) Object.assign(cur, { error: step, errorAt: p.at })
    if (!p.isError && p.at >= cur.waveAt) Object.assign(cur, { wave: step, kind: p.kind, waveAt: p.at })
    out.set(p.agent, cur)
  }
  return out
}

export type Look = {
  body: number
  eye: number
  eyes: Eyes
  arms: Arms
  armColor: number | null
  lift: number
  glow: { color: number; k: number } | null
  wH: number
  outline: { color: number; k: number } | null
  /** `hot`: the amber or red of a filled bar from 70%, ghosted with a done robot. */
  bar: { fill: number | null; tone: number; hot: number } | null
}

/** Whether a waiting agent's eyes are shut for its blink at `now`. */
export function blinkClosed(id: string, now: number): boolean {
  const t = (now + hashUnit(id) * ROBOT.blinkMs) / ROBOT.blinkMs
  return t - Math.floor(t) < ROBOT.blinkClosedMs / ROBOT.blinkMs
}

/** When the next blink starts or ends for any waiting agent (pane.md 12.5): the loop draws one frame there. */
export function nextBlinkAt(stats: Readonly<Record<string, AgentStats>>, now: number): number | null {
  let next: number | null = null
  for (const [id, s] of Object.entries(stats)) {
    if (s.placeholder || s.status !== 'waiting') continue
    const t = (now + hashUnit(id) * ROBOT.blinkMs) % ROBOT.blinkMs
    const phase = t < 0 ? t + ROBOT.blinkMs : t
    const at = now + (phase < ROBOT.blinkClosedMs ? ROBOT.blinkClosedMs - phase : ROBOT.blinkMs - phase)
    if (next === null || at < next) next = at
  }
  return next
}

export type LookInput = {
  id: string; r: number; size: RobotSize; s: AgentStats; a: AgentState; now: number; motion: Readonly<Motion>
  pulse: RobotPulse | undefined; clash: boolean; still: boolean
}

/** pane.md 12.2 and 12.5: body, eyes, arms, lift, glow, outline and bar for one agent's state at `now`. */
export function robotLook(i: LookInput): Look {
  const { s, a, now, size } = i
  const skin = activeSkin()
  const motion = i.still ? { ...FULL_MOTION, breathe: false, slowFades: false, clashBlink: false, fadeIn: false, pulseFade: false } : i.motion
  const pulse = i.still ? undefined : i.pulse
  const seed = hashUnit(i.id)
  const range = ROBOT.size[size]
  const wH = 1 + Math.round(2 * clamp01((i.r - range.rLo) / (range.rHi - range.rLo)))
  const hasCross = skin.sprites[size].eyes.cross !== undefined
  const model = modelColor(s.model)
  const hotOf = (fill: number | null): number => {
    const c = contextColor(fill ?? 0)
    return s.status === 'done' ? stateTone(c, s, a, now, motion, c) : c
  }
  if (s.placeholder) {
    const body = mix(CANVAS, TEXT.faint, motion.fadeIn ? quantise(fadeIn(a.startedAt, now), 8) : now >= a.startedAt ? 1 : 0)
    return { body, eye: CANVAS, eyes: 'closed', arms: 'down', armColor: null, lift: 0, glow: null, wH, outline: null, bar: null }
  }
  const failed = s.status === 'failed'
  const settled = failed || s.status === 'done'
  const error = pulse?.error ?? 0
  const wave = settled ? 0 : (pulse?.wave ?? 0)
  const redStep = error === 4 || error === 2

  let eyes: Eyes = 'open'
  if (failed) eyes = 'cross'
  else if (s.status === 'done') eyes = a.finishedAt === null || now >= a.finishedAt ? 'closed' : 'open'
  else if (error > 0 && hasCross) eyes = 'cross'
  else if (s.status === 'waiting' && motion.breathe && blinkClosed(i.id, now)) eyes = 'closed'

  const fade = (c: number): number => mix(CANVAS, c, motion.fadeIn ? quantise(fadeIn(a.startedAt, now), 8) : now >= a.startedAt ? 1 : 0)
  let glowOf: Look['glow'] = null
  if (s.status === 'running') glowOf = { color: fade(model), k: motion.breathe ? quantise(0.45 + 0.55 * glow(now, seed), 5) : 0.7 }
  else if (failed) glowOf = { color: fade(STATUS.failed), k: ROBOT.failedGlowK }
  if (redStep) glowOf = { color: STATUS.failed, k: 1 }

  const stuckK = motion.breathe ? quantise(0.3 + 0.6 * glow(now, seed), 4) : 0.6
  const outline = i.clash ? { color: LINK.clash, k: ROBOT.outlineK }
    : redStep ? { color: STATUS.failed, k: ROBOT.outlineK }
      : s.stuck ? { color: STATUS.warn, k: stuckK } : null

  const lift = s.status !== 'running' ? 0 : motion.breathe
    ? range.hop[Math.floor(10 * frac(now / MOTION.glowPeriodMs + seed + 0.5)) % 10]!
    : 1
  return {
    body: stateTone(skin.bodyColor, s, a, now, motion, ROBOT.dead),
    eye: failed ? STATUS.failed : CANVAS,
    eyes,
    arms: wave === 3 || wave === 1 ? 'up' : 'down',
    armColor: wave > 0 && error === 0 ? KIND[pulse!.kind] : null,
    lift,
    glow: glowOf,
    wH,
    outline,
    bar: { fill: s.contextFill, tone: stateTone(model, s, a, now, motion, model), hot: hotOf(s.contextFill) },
  }
}

const frac = (t: number): number => (Number.isFinite(t) ? t - Math.floor(t) : 0)

/** Paints one robot in its box: halo and outline round the trunk, then the sprite, then the context bar. */
export function paintRobot(px: Pixels, box: Box, look: Look): void {
  const s = activeSkin().sprites[box.size]
  const cells = composite(s, look.eyes, look.arms)
  const sx = box.left
  const sy = box.top + ROBOT.size[box.size].headroom - look.lift
  const solid = (x: number, y: number): boolean => y >= 0 && y < s.h && x >= 0 && x < s.w && cells[y]![x] !== '.'
  if (look.glow !== null || look.outline !== null) {
    const [x0, y0, x1, y1] = s.body
    const wH = look.wH
    for (let y = -wH; y <= s.haloRows; y++) {
      for (let x = x0 - wH; x <= x1 + wH; x++) {
        if (solid(x, y)) continue
        const dx = x < x0 ? x0 - x : x > x1 ? x - x1 : 0
        const dy = y < y0 ? y0 - y : y > y1 ? y - y1 : 0
        const d = Math.ceil(Math.hypot(dx, dy) - 0.25)
        if (d < 1 || d > wH) continue
        let c = px.get(sx + x, sy + y)
        if (look.glow !== null) c = add(c, look.glow.color, 0.8 * quantise(1 - d / (wH + 1), 5) * look.glow.k)
        if (look.outline !== null && d === 1) c = mix(c, look.outline.color, look.outline.k)
        px.set(sx + x, sy + y, c)
      }
    }
  }
  const shade: Record<string, number> = { B: look.body, L: look.body, A: look.armColor ?? look.body, E: look.eye, D: scale(look.body, 0.8), H: mix(look.body, WHITE, 0.2) }
  for (let y = 0; y < s.h; y++) {
    const row = cells[y]!
    for (let x = 0; x < s.w; x++) {
      const ch = row[x]!
      if (ch !== '.') px.set(sx + x, sy + y, shade[ch] ?? look.body)
    }
  }
  if (look.bar !== null) {
    const [x0, , x1] = s.body
    const n = x1 - x0 + 1
    const fill = look.bar.fill
    const track = mix(CANVAS, look.bar.tone, 0.35)
    const y = box.top + box.h - 1
    for (let i = 0; i < n; i++) {
      const on = fill !== null && (i + 0.5) / n <= fill
      px.set(sx + x0 + i, y, !on ? track : fill! >= 0.7 ? look.bar.hot : look.bar.tone)
    }
  }
}
