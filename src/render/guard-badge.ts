/** The guard's sweat drop (pane.md §13.2): how many, where, the drip and the flash. Pure. */
import type { AgentState } from '../core/fold.ts'
import type { Motion } from './fx.ts'
import type { RobotSize, SkinSprite } from './sprites.ts'
import { GUARD } from './tokens.ts'
import type { Point, Pulse } from './types.ts'

export type Drops = 0 | 1 | 2

export function dropsFor(a: AgentState): Drops {
  if (a.finishedAt !== null || a.outcome !== null) return 0
  const g = a.guard
  if (g === undefined) return 0
  if (g.timeAct !== null || g.costAct !== null) return 2
  return g.timeWarn !== null || g.costWarn !== null ? 1 : 0
}

export function spriteDrops(s: SkinSprite, drops: Drops): Array<[number, number]> {
  if (drops === 0) return []
  const one = s.sweat.map(([x, y]): [number, number] => [x, y])
  return drops === 1 ? one : [...one, ...one.map(([x, y]): [number, number] => [s.w - 1 - x, y])]
}

/** Slots 2, 3 and 4 of the hop's 10-slot clock put the drip at rows dropBottom + 1, + 2, + 3, skipped past the body. */
export function dripPixels(s: SkinSprite, size: RobotSize, drops: Drops, slot: number): Array<[number, number]> {
  if (drops === 0 || size === 'S' || slot < 2 || slot > 4 || s.sweat.length === 0) return []
  const dropBottom = Math.max(...s.sweat.map(([, y]) => y))
  const y = dropBottom + (slot - 1)
  if (y > s.body[3]) return []
  const out: Array<[number, number]> = [[s.body[2], y]]
  if (drops === 2) out.push([s.body[0], y])
  return out
}

export function globeDrops(p: Point, r: number, ringPx: number, drops: Drops): Array<[number, number]> {
  if (drops === 0) return []
  const k = (r + ringPx + 1.5) * Math.SQRT1_2
  const a = { x: Math.round(p.x + k), y: Math.round(p.y - k) + 1 }
  const one: Array<[number, number]> = r >= 2.2 ? [[a.x + 1, a.y - 2], [a.x, a.y - 1], [a.x + 1, a.y - 1]] : [[a.x, a.y - 1], [a.x, a.y]]
  if (drops === 1) return one
  return [...one, ...one.map(([x, y]): [number, number] => [Math.round(2 * p.x - x), y])]
}

/** §13.2: q3(flash) 3 and 1 white, 2 the drop colour, over GUARD.flashMs, from the agent's newest guard pulse. */
export function flashColour(pulses: readonly Pulse[], agent: string, tEff: number): number | null {
  let at = Number.NEGATIVE_INFINITY
  for (const p of pulses) if (p.guard === true && p.agent === agent && p.at <= tEff && p.at > at) at = p.at
  const age = tEff - at
  if (!(age >= 0 && age < GUARD.flashMs)) return null
  const q = 3 - Math.min(2, Math.floor((age / GUARD.flashMs) * 3))
  return q === 2 ? GUARD.drop : 0xffffff
}

/**
 * `flashColour` for a frame under a motion budget. With pulse fade off the flash is one frame of white held for
 * `pulseHoldMs` (§13.2 "degraded"), so the pulse is read at its own start while it is under that age.
 */
export function guardFlash(pulses: readonly Pulse[], agent: string, tEff: number, motion: Readonly<Motion>): number | null {
  if (motion.pulseFade) return flashColour(pulses, agent, tEff)
  let newest = Number.NEGATIVE_INFINITY
  for (const p of pulses) if (p.guard === true && p.agent === agent && p.at <= tEff && p.at > newest) newest = p.at
  return tEff - newest < Math.max(GUARD.flashMs, motion.pulseHoldMs) ? 0xffffff : null
}
