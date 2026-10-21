/** Motion maths at a given time: fades, glow, flashes, comets and the layout glide. Deterministic: no randomness. Pure. */
import { clamp01 } from './color.ts'
import { MOTION } from './tokens.ts'
import type { Point, Tween } from './types.ts'

export const easeOutCubic = (t: number): number => 1 - (1 - clamp01(t)) ** 3

export const easeInOut = (t: number): number => {
  const k = clamp01(t)
  return k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2
}

/** 0 at start, 1 once MOTION.fadeInMs has passed. */
export const fadeIn = (startedAt: number, now: number): number => easeOutCubic((now - startedAt) / MOTION.fadeInMs)

/** 0 while running, rising to 1 over MOTION.ghostMs after finishing. */
export const ghost = (finishedAt: number | null, now: number): number =>
  finishedAt === null ? 0 : clamp01((now - finishedAt) / MOTION.ghostMs)

/** A slow 0..1 breath, offset per agent by `seed` so neighbours don't pulse in step. */
export const glow = (now: number, seed: number): number => 0.5 + 0.5 * Math.sin(2 * Math.PI * (now / MOTION.glowPeriodMs + seed))

/** 1 at `at`, falling to 0 over `ms`; 0 before `at`. */
export function flash(at: number, now: number, ms: number): number {
  const age = now - at
  return age < 0 || age > ms ? 0 : 1 - age / ms
}

export const blink = (now: number, ms: number): boolean => Math.floor(now / ms) % 2 === 0

/** A stable 0..1 number for a string (FNV-1a). */
export function hashUnit(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h / 0x100000000
}

export const lerpPoint = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })

/**
 * A gentle curve from a to b (a quadratic Bezier), bowed to the left of the direction of travel by `bend` times the
 * distance. The reverse direction bows the other way, so a pair of links reads as two.
 */
export function arc(a: Point, b: Point, bend: number): (t: number) => Point {
  const cx = (a.x + b.x) / 2 - (b.y - a.y) * bend
  const cy = (a.y + b.y) / 2 + (b.x - a.x) * bend
  return t => {
    const u = 1 - t
    return { x: u * u * a.x + 2 * u * t * cx + t * t * b.x, y: u * u * a.y + 2 * u * t * cy + t * t * b.y }
  }
}

export type Spark = { p: Point; k: number }

/**
 * A message's comet along `path` (t from 0 at the sender to 1 at the receiver): the head (k = 1) runs the path over
 * MOTION.cometMs, and MOTION.trailDots dots trail it over MOTION.trailMs with falling k. After the head lands the trail
 * sweeps in; then nothing is left.
 */
export function comet(path: (t: number) => Point, at: number, now: number): Spark[] {
  const age = now - at
  if (age < 0 || age > MOTION.cometMs + MOTION.trailMs) return []
  const head = age / MOTION.cometMs
  const gap = MOTION.trailMs / MOTION.cometMs / MOTION.trailDots
  const out: Spark[] = []
  for (let i = 0; i <= MOTION.trailDots; i++) {
    const t = head - i * gap
    if (t < 0 || t > 1) continue
    out.push({ p: path(easeInOut(t)), k: i === 0 ? 1 : 1 - i / (MOTION.trailDots + 1) })
  }
  return out
}

/** Positions part way from `t.from` to `target`, eased over MOTION.tweenMs. A node with no old position starts where it ends. */
export function tween(target: Readonly<Record<string, Point>>, t: Tween | null, now: number): Record<string, Point> {
  const k = t === null ? 1 : easeOutCubic((now - t.at) / MOTION.tweenMs)
  const out: Record<string, Point> = {}
  for (const [id, p] of Object.entries(target)) {
    const from = t !== null && Object.hasOwn(t.from, id) ? t.from[id]! : p
    out[id] = k >= 1 ? p : lerpPoint(from, p, k)
  }
  return out
}
