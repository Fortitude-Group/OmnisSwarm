/**
 * Design tokens for the swarm pane: colours, glyphs, motion and size steps. docs/design/pane.md is where these are
 * decided; this file copies its Tokens table. Change a value there first, then here. Pure and mod-safe.
 */
import type { ToolKind } from '../core/events.ts'
import type { AgentStatus, RouteStats } from '../core/stats.ts'

/** The pane paints its own dark canvas, so every colour here is checked against it, on dark and light terminals alike. */
export const CANVAS = 0x0b0f17
export const CANVAS_RAISED = 0x131a26

export const TEXT = { primary: 0xe6edf3, dim: 0x9aa4b2, faint: 0x5c6679 } as const
export const ACCENT = 0xb48cff

/** Model families, Okabe-Ito based, so they stay apart under the common colour-vision deficiencies. */
export const MODEL = { fable: 0xff9fe0, opus: 0x4d8dff, sonnet: 0x4cd07a, haiku: 0xf0e442, other: 0x808794 } as const
export type ModelFamily = keyof typeof MODEL

/** Status colours. Status is never shown by colour alone: each pairs with a GLYPH and a motion. */
export const STATUS = { running: 0x7ee787, waiting: 0x9aa4b2, done: 0x8b98a9, failed: 0xf85149, warn: 0xe69f00 } as const

export const KIND: Readonly<Record<ToolKind, number>> = {
  read: 0x4fd8e8, edit: 0xffc861, bash: 0xc49bff, search: 0xa6e35a, web: 0x6f95ff, agent: 0xff86c2, other: 0x9aa4b2,
}
export const KIND_LETTER: Readonly<Record<ToolKind, string>> = { read: 'r', edit: 'e', bash: 'b', search: 's', web: 'w', agent: 'a', other: 'o' }

export const LINK = { idle: 0x2b3546, active: 0x9ecbff, comet: 0xf5fbff, clash: 0xf85149 } as const
export const FEED_COLOR = { agent: 0x9aa4b2, message: 0x9ecbff, memory: 0xd2a8ff, task: 0xffb86b } as const
export const FEED_MARK = { agent: '•', message: '›', memory: '+', task: '#' } as const

export const GLYPH = {
  running: '▶', waiting: '◌', done: '✓', failed: '✕', lead: '◆', unknown: '?', stuck: '!', clash: '!', gap: '⚠', dot: '●', pinned: '◉', times: '×',
  cheaper: '↓', dearer: '↑',
} as const

/**
 * The budget guard (pane.md 13.1). `drop` is a pale water blue: 10.23:1 on CANVAS, 1.68:1 on terracotta, told apart by hue
 * (22-27 OKLab from the body). The drip is the full drop colour; at 0.7 it vanished. `blockedBadge` is 5.72:1.
 */
export const GUARD = { drop: 0x7cc4ff, dripMix: 1, flashMs: 450, blockedBadge: { fg: CANVAS, bg: STATUS.failed } } as const
/** A replay (pane.md 13.1): `raised` = mix(CANVAS_RAISED, ACCENT, 0.08), `TEXT.primary` 13.10 on it; the badge is 7.43:1. */
export const REPLAY = { raised: 0x202337, badge: { fg: CANVAS, bg: ACCENT } } as const

export const MOTION = {
  fadeInMs: 600, ghostMs: 1500, glowPeriodMs: 2000, cometMs: 900, trailMs: 450, trailDots: 6, linkFadeMs: 3000,
  pulseMs: 450, errorPulseMs: 900, clashFlashMs: 4000, clashBlinkMs: 400, tweenMs: 400,
} as const

export const FPS = { busy: 20, glow: 5, min: 4, tick: 1 } as const

/** Graph geometry in canvas pixels (a half-block pixel is about square). */
export const GRAPH = { minRadius: 1.6, maxRadius: 6, glowPx: 2.5, ringPx: 1.2, linkThick: [5, 20], linkBend: 0.18, linkBendMax: 0.5, busyArcOffset: 0.04 } as const

export const SIZE = {
  summaryBelowRows: 6, summaryBelowColumns: 30, treeBelowRows: 14, treeBelowColumns: 48, compactBelowRows: 22,
  noTimelineBelowRows: 30, graphShare: 0.55, minGraphRows: 8, spotlightRows: 6, timelineMaxRows: 8, minFeedRows: 2,
} as const

export const SPOTLIGHT_HOLD_MS = 5_000
/** omnis_feed is pulled at most 4 times a second. */
export const PULL_MS = 250
export const RASTER_MAX = { columns: 512, rows: 256 } as const
/** Distinct fg/bg pairs per grid; the terminal paints 1024 at once. */
export const PAIR_BUDGET = { top: 700, bottom: 300 } as const

export function modelFamily(model: string | null): ModelFamily {
  if (model === null) return 'other'
  const m = model.toLowerCase()
  if (m.includes('fable') || m.includes('mythos')) return 'fable'
  if (m.includes('opus')) return 'opus'
  if (m.includes('sonnet')) return 'sonnet'
  if (m.includes('haiku')) return 'haiku'
  return 'other'
}

export const modelColor = (model: string | null): number => MODEL[modelFamily(model)]

type Routed = { model: string | null; route: RouteStats | null }

/** pane.md 13.5: a model badge only when both families are known and differ (two Sonnet versions show none). */
export function routedFamilies(s: Routed): { asked: ModelFamily; answered: ModelFamily } | null {
  if (s.route === null || s.model === null) return null
  const asked = modelFamily(s.route.requested)
  const answered = modelFamily(s.model)
  return asked === answered || asked === 'other' || answered === 'other' ? null : { asked, answered }
}

/** The graph label's and tree row's mark after the name: ↓ dim when the answer was cheaper, ↑ amber when dearer. */
export function routeMark(s: Routed): [string, number] | null {
  const d = routedFamilies(s) === null ? 0 : (s.route?.deltaUsd ?? 0)
  return d > 0 ? [GLYPH.cheaper, TEXT.dim] : d < 0 ? [GLYPH.dearer, STATUS.warn] : null
}

export const statusGlyph = (status: AgentStatus, placeholder = false): string => (placeholder ? GLYPH.unknown : GLYPH[status])

/** The context ring and bar: amber from 70%, red from 90%. */
export const contextColor = (fill: number): number => (fill >= 0.9 ? STATUS.failed : fill >= 0.7 ? STATUS.warn : TEXT.dim)
