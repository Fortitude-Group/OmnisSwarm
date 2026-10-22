/**
 * Every robot size x state on one canvas, for the robot goldens (pane.md 12.8) and scripts/preview.ts. Rows are S, M
 * and L; columns are SHEET_STATES in order. Each robot is drawn by robotLook and paintRobot, as the graph draws it.
 */
import { foldAll, type AgentState } from '../../src/core/fold.ts'
import { agentStats, type AgentStats } from '../../src/core/stats.ts'
import { Dots, Pixels, compose } from '../../src/render/canvas.ts'
import { FULL_MOTION, hashUnit, motionFor, type Motion } from '../../src/render/fx.ts'
import { Grid } from '../../src/render/grid.ts'
import { boxAt, paintRobot, robotLook, type Box, type Look, type RobotPulse } from '../../src/render/robot.ts'
import type { RobotSize } from '../../src/render/sprites.ts'
import { CANVAS, MOTION } from '../../src/render/tokens.ts'
import { FIVE_AT, FIVE_SWARM, fiveAgentEvents } from '../fixtures/swarm-five.ts'

export const SHEET_STATES = [
  'running', 'hop-top', 'wave-up', 'wave-down', 'error-red', 'error-off', 'waiting', 'blink', 'done', 'failed', 'stuck', 'clash',
  'placeholder', 'degraded', 'still',
] as const
export type SheetState = (typeof SHEET_STATES)[number]
export const SHEET_SIZES: readonly RobotSize[] = ['S', 'M', 'L']
/** A radius in each size step, and a context fill per row that shows the bar's plain, amber and red thresholds. */
export const SHEET_R: Record<RobotSize, number> = { S: 2.2, M: 3.4, L: 5.0 }
const FILL: Record<RobotSize, number> = { S: 0.3, M: 0.75, L: 0.95 }
const CELL_W = 18
const CELL_H = 20
const T = FIVE_AT.idle

/** A time near `base` at which agent `id` is in hop slot `slot` and not blinking. */
export function nowForSlot(id: string, slot: number, base = T): number {
  const period = MOTION.glowPeriodMs
  const want = (slot + 0.5) / 10 - hashUnit(id) - 0.5
  const offset = ((want % 1) + 1) % 1
  return Math.floor(base / period) * period + offset * period
}

/** A time at which a waiting agent `id` is half way through its blink. */
export const nowInBlink = (id: string, base = T): number => {
  const ms = 6000
  const phase = (((base + hashUnit(id) * ms) % ms) + ms) % ms
  return base - phase + 100
}

export type SheetCell = { id: string; r: number; size: RobotSize; s: AgentStats; a: AgentState; now: number; motion: Readonly<Motion>; pulse: RobotPulse | undefined; clash: boolean; still: boolean }

/** The agent, time and pulses for one sheet cell: a sonnet agent long past its fade-in, varied per state. */
export function sheetCell(state: SheetState, size: RobotSize): SheetCell {
  const swarm = foldAll(FIVE_SWARM, fiveAgentEvents())
  const id = `robot-${size}-${state}`
  const base = agentStats(swarm, 'a-cod1', T)!
  const agent = swarm.agents['a-cod1']!
  const status = state === 'waiting' || state === 'blink' ? 'waiting' : state === 'done' ? 'done' : state === 'failed' ? 'failed' : 'running'
  const s: AgentStats = { ...base, id, status, placeholder: state === 'placeholder', stuck: state === 'stuck', contextFill: FILL[size] }
  const a: AgentState = { ...agent, id, startedAt: T - 60_000, finishedAt: status === 'done' || status === 'failed' ? T - 30_000 : null }
  let now = nowForSlot(id, 0)
  if (state === 'hop-top') now = nowForSlot(id, 7)
  if (state === 'blink') now = nowInBlink(id)
  // Half a period from its blink, so a waiting robot's eyes are open.
  if (state === 'waiting') now = nowInBlink(id) + 3000
  const wave = state === 'wave-up' ? 3 : state === 'wave-down' ? 2 : 0
  const error = state === 'error-red' ? 4 : state === 'error-off' ? 3 : 0
  const pulse: RobotPulse | undefined = wave + error > 0 ? { wave, kind: 'edit', error } : undefined
  return {
    id, r: state === 'placeholder' ? 1.6 : SHEET_R[size], size: state === 'placeholder' ? 'S' : size, s, a, now,
    motion: state === 'degraded' ? motionFor(4) : FULL_MOTION, pulse, clash: state === 'clash', still: state === 'still',
  }
}

export const lookOf = (c: SheetCell): Look => robotLook(c)

/** The box a sheet cell's robot is drawn in, centred in its cell. */
export const sheetBox = (col: number, row: number, size: RobotSize): Box => boxAt({ x: col * CELL_W + CELL_W / 2, y: row * CELL_H + CELL_H / 2 }, size)

export function robotSheet(): Grid {
  const px = new Pixels(CELL_W * SHEET_STATES.length, CELL_H * SHEET_SIZES.length, CANVAS)
  SHEET_SIZES.forEach((size, row) => SHEET_STATES.forEach((state, col) => {
    const c = sheetCell(state, size)
    paintRobot(px, sheetBox(col, row, c.size), lookOf(c))
  }))
  const grid = new Grid(px.width, px.height / 2, CANVAS)
  compose(grid, { x: 0, y: 0, w: grid.columns, h: grid.rows }, px, new Dots(grid.columns, grid.rows))
  return grid
}
