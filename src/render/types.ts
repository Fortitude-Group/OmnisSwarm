/** Shapes shared by the render units and the pane. Pure types, plus two tiny constructors. */
import type { ToolKind } from '../core/events.ts'
import type { Grid } from './grid.ts'

/** A position on the graph's pixel canvas: one pixel is one cell wide and half a cell tall. */
export type Point = { x: number; y: number }
/** A box of cells. */
export type Rect = { x: number; y: number; w: number; h: number }
export type Size = { columns: number; rows: number }
export type SizeStep = 'full' | 'noTimeline' | 'compactSpotlight' | 'tree' | 'summary'
/** A tool start, or a tool end that failed, as the pane saw it arrive; or, with `guard`, a guard.warned or guard.nudged (the drop flash). */
/** `coalesced`: set once when the pulse arrives (see markPulses): it came too soon after the agent's last flicker, so it is not drawn. */
export type Pulse = { agent: string; kind: ToolKind; at: number; isError: boolean; coalesced?: boolean; guard?: true }
/** Who the spotlight is on, and since when (it holds each agent for SPOTLIGHT_HOLD_MS). */
export type Spot = { id: string; since: number }
/** Node positions to glide from, after the layout changed at `at`. */
export type Tween = { from: Readonly<Record<string, Point>>; at: number }

/** What the pane knows beyond the swarm state: the pin, the spotlight, recent pulses, how late events arrive, the glide. */
export type View = {
  pinned: string | null
  spotlight: Spot | null
  pulses: readonly Pulse[]
  lagMs: number
  tween: Tween | null
  /** How nodes are drawn, pane-wide: globes unless robots were chosen (pane.md 12.1). */
  style?: 'globe' | 'robot'
  /** Nothing moves where this frame goes (the Svg): robots draw their still frame (pane.md 12.6). */
  still?: boolean
  budget?: ViewBudget | null
}

/** The budget guard's figures for the header (pane.md 13.2); filled by the pane, absent in replays and GIFs. */
export type ViewBudget = { swarmUsd: number; limit: number; warn: number; blocked: boolean }

/**
 * A replay on screen (pane.md 13.3): its speed, the log time since the swarm's first event, the swarm's own length
 * (no gap cutting), and whether it has played to the end.
 */
export type ReplayNote = { speed: number; clockMs: number; totalMs: number; ended: boolean }

export type Chip = { id: string; label: string; color: number; pinned: boolean }

/**
 * One drawn frame. `top` is the header and graph, `bottom` the spotlight, timeline and feed, with the chip row between.
 * `treeKey` changes only when the element tree must be redrawn; `nodesKey` when the node set or layout changed.
 */
export type Frame = {
  step: SizeStep
  top: Grid
  bottom: Grid | null
  chips: Chip[]
  treeKey: string
  nodesKey: string
  positions: Record<string, Point>
  fps: number
  spotlight: string | null
  /** The one-line summary: the Svg's words for readers that cannot see it. */
  alt: string
  /** When the loop must draw one frame whatever its rate: a robot's blink starts or ends (pane.md 12.5). */
  wakeAt?: number
}

export const emptyView = (): View => ({ pinned: null, spotlight: null, pulses: [], lagMs: 0, tween: null })

export const rect = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w: Math.max(0, w), h: Math.max(0, h) })
