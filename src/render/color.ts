/** Colour maths on 0xRRGGBB numbers. There is no alpha in a terminal cell: fades blend toward the canvas. Pure. */

/** The terminal's own colour (foreground or background), as the Raster encodes it. Never blend it. */
export const DEFAULT = 0x01000000

export const clamp01 = (t: number): number => (Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0)

const byte = (v: number): number => Math.max(0, Math.min(255, Math.round(v)))
const ch = (c: number, shift: number): number => (c >>> shift) & 255

export const rgb = (r: number, g: number, b: number): number => ((byte(r) << 16) | (byte(g) << 8) | byte(b)) >>> 0

export function mix(a: number, b: number, t: number): number {
  const k = clamp01(t)
  return rgb(ch(a, 16) * (1 - k) + ch(b, 16) * k, ch(a, 8) * (1 - k) + ch(b, 8) * k, ch(a, 0) * (1 - k) + ch(b, 0) * k)
}

export const scale = (c: number, k: number): number => rgb(ch(c, 16) * k, ch(c, 8) * k, ch(c, 0) * k)

/** Light adds: the base keeps its colour and the light is laid over it, so a glow stays bright rather than muddy. */
export const add = (base: number, light: number, k: number): number =>
  rgb(ch(base, 16) + ch(light, 16) * k, ch(base, 8) + ch(light, 8) * k, ch(base, 0) + ch(light, 0) * k)

export function desaturate(c: number, k: number): number {
  const grey = 0.299 * ch(c, 16) + 0.587 * ch(c, 8) + 0.114 * ch(c, 0)
  return mix(c, rgb(grey, grey, grey), k)
}

export const hex = (c: number): string => `#${(c & 0xffffff).toString(16).padStart(6, '0')}`

export function luminance(c: number): number {
  const lin = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(ch(c, 16)) + 0.7152 * lin(ch(c, 8)) + 0.0722 * lin(ch(c, 0))
}

/** WCAG contrast ratio, 1 to 21. */
export function contrast(a: number, b: number): number {
  const x = luminance(a)
  const y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

/** Snaps t to one of `steps` levels, so ramps reuse a few colours and a frame stays under its pair budget. */
export const quantise = (t: number, steps: number): number =>
  steps <= 1 ? clamp01(t) : Math.round(clamp01(t) * (steps - 1)) / (steps - 1)
