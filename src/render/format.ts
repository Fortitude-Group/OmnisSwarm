/** Short, fixed-width number formats for the pane. Every money figure is approximate and says so. Pure. */

const DASH = '–'

export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  const r = Math.round(n)
  if (r < 1000) return String(r)
  if (r < 9950) return `${(r / 1000).toFixed(1)}k`
  const k = Math.round(r / 1000)
  if (k < 1000) return `${k}k`
  if (r < 9_950_000) return `${(r / 1_000_000).toFixed(1)}M`
  return `${Math.round(r / 1_000_000)}M`
}

export function fmtUsd(x: number | null): string {
  if (x === null || !Number.isFinite(x) || x < 0) return DASH
  if (x === 0) return '≈$0'
  if (x < 0.01) return Number(x.toFixed(3)) >= 0.01 ? '≈$0.01' : `≈$${x.toFixed(3)}`
  if (x < 99.995) return `≈$${x.toFixed(2)}`
  return `≈$${Math.round(x)}`
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms)) return DASH
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${pad2(s % 60)}s`
  return `${Math.floor(m / 60)}h${pad2(m % 60)}m`
}

/** How long ago, in one unit. */
export function fmtAge(ms: number): string {
  if (!Number.isFinite(ms)) return DASH
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`
}

/** A 0..1 fraction as a whole percentage. */
export const fmtPercent = (fraction: number | null): string =>
  fraction === null || !Number.isFinite(fraction) ? DASH : `${Math.round(fraction * 100)}%`

/** At most `max` code points, the first one an ellipsis when cut: a path keeps its file name. */
export function clipTail(s: string, max: number): string {
  if (Number.isNaN(max)) return ''
  const chars = Array.from(s)
  if (chars.length <= max) return s
  if (max <= 0) return ''
  return `…${chars.slice(chars.length - max + 1).join('')}`
}

/** At most `max` code points, the last one an ellipsis when cut. */
export function clipText(s: string, max: number): string {
  if (Number.isNaN(max)) return ''
  const chars = Array.from(s)
  if (chars.length <= max) return s
  if (max <= 0) return ''
  return `${chars.slice(0, max - 1).join('')}…`
}
