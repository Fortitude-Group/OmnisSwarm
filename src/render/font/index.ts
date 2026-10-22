/** The 8x16 bitmap font the rasteriser draws text with: Spleen (BSD 2-Clause) plus our extra.ts. Pure, no Node. */
import { EXTRA } from './extra.ts'
import { REQUIRED_SOURCE } from './required.ts'
import { SPLEEN_CODEPOINTS, SPLEEN_ROWS } from './spleen8x16.ts'

export const FONT_W = 8
export const FONT_H = 16
export const REQUIRED = REQUIRED_SOURCE

let table: Map<number, Uint8Array> | null = null

function build(): Map<number, Uint8Array> {
  const bytes = Uint8Array.from(atob(SPLEEN_ROWS), c => c.charCodeAt(0))
  const out = new Map<number, Uint8Array>()
  SPLEEN_CODEPOINTS.forEach((cp, i) => out.set(cp, bytes.subarray(i * FONT_H, (i + 1) * FONT_H)))
  for (const [key, art] of Object.entries(EXTRA)) {
    out.set(Number(key), Uint8Array.from(art, row => [...row].reduce((n, c, x) => n | (c === '#' ? 0x80 >> x : 0), 0)))
  }
  return out
}

/** The 16 row bytes of a glyph (bit 7 = leftmost pixel), or null when neither Spleen nor extra.ts has it. */
export function glyphRows(cp: number): Uint8Array | null {
  table ??= build()
  return table.get(cp) ?? null
}
