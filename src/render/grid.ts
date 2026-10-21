/**
 * A cell grid for the terminal's Raster: per cell a glyph, a 24-bit foreground and a background, packed as base64 of
 * little-endian u32 triplets [codePoint, fg, bg], row-major. Every glyph passes safeGlyph, because one bad cell makes
 * the engine refuse the whole tree. Base64 is done by hand so this runs in a mod and in Node alike. Pure.
 */
import { DEFAULT, rgb } from './color.ts'
import { RASTER_MAX } from './tokens.ts'

const SPACE = 0x20
const REPLACEMENT = 0x3f
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** East Asian Wide and Fullwidth ranges in the BMP, and the BMP characters drawn as emoji by default. */
const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0x303e],
  [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
]
/** Marks (zero width), controls, format characters, surrogates, private use, unassigned, line and paragraph separators. */
const NOT_A_CELL = /[\p{M}\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u

/** safeGlyph's answer per BMP code point, worked out on first use; 0 means not yet (no answer is 0). */
const glyphs = new Uint16Array(0x10000)

/** The code point if the Raster accepts it (printable, one cell wide, in the BMP), otherwise '?'. */
export function safeGlyph(cp: number): number {
  if (!Number.isInteger(cp) || cp < SPACE || cp > 0xffff) return REPLACEMENT
  const known = glyphs[cp]!
  if (known !== 0) return known
  const out = checkGlyph(cp)
  glyphs[cp] = out
  return out
}

function checkGlyph(cp: number): number {
  if (cp >= 0xd800 && cp <= 0xdfff) return REPLACEMENT
  if (NOT_A_CELL.test(String.fromCharCode(cp))) return REPLACEMENT
  for (const [lo, hi] of WIDE) if (cp >= lo && cp <= hi) return REPLACEMENT
  return cp
}

/** The first code point of `ch`. */
export const cp = (ch: string): number => ch.codePointAt(0) ?? SPACE

/** A whole size of at least 1 and at most `max`; anything that is not a finite number becomes 1. */
const dimension = (n: number, max: number): number => (Number.isFinite(n) ? Math.max(1, Math.min(max, Math.floor(n))) : 1)

export class Grid {
  readonly columns: number
  readonly rows: number
  readonly cells: Uint32Array

  constructor(columns: number, rows: number, bg: number = DEFAULT, fg: number = DEFAULT) {
    this.columns = dimension(columns, RASTER_MAX.columns)
    this.rows = dimension(rows, RASTER_MAX.rows)
    this.cells = new Uint32Array(this.columns * this.rows * 3)
    for (let i = 0; i < this.columns * this.rows; i++) {
      this.cells[i * 3] = SPACE
      this.cells[i * 3 + 1] = fg >>> 0
      this.cells[i * 3 + 2] = bg >>> 0
    }
  }

  #at(x: number, y: number): number {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return -1
    const cx = Math.floor(x)
    const cy = Math.floor(y)
    return cx < 0 || cy < 0 || cx >= this.columns || cy >= this.rows ? -1 : (cy * this.columns + cx) * 3
  }

  /**
   * Writes one cell. Leaves the background as it is when `bg` is not given. Called for nearly every cell drawn, so a
   * whole-number position and an already checked glyph skip the general paths (#at and safeGlyph) for the same answer.
   */
  set(x: number, y: number, codePoint: number, fg: number, bg?: number): void {
    let at: number
    if ((x | 0) === x && (y | 0) === y) {
      if (x < 0 || y < 0 || x >= this.columns || y >= this.rows) return
      at = (y * this.columns + x) * 3
    } else {
      at = this.#at(x, y)
      if (at < 0) return
    }
    const known = (codePoint | 0) === codePoint && codePoint >= SPACE && codePoint <= 0xffff ? glyphs[codePoint]! : 0
    this.cells[at] = known !== 0 ? known : safeGlyph(codePoint)
    this.cells[at + 1] = fg >>> 0
    if (bg !== undefined) this.cells[at + 2] = bg >>> 0
  }

  glyph(x: number, y: number): number {
    const at = this.#at(x, y)
    return at < 0 ? SPACE : this.cells[at]!
  }

  fg(x: number, y: number): number {
    const at = this.#at(x, y)
    return at < 0 ? DEFAULT : this.cells[at + 1]!
  }

  bg(x: number, y: number): number {
    const at = this.#at(x, y)
    return at < 0 ? DEFAULT : this.cells[at + 2]!
  }

  /** Blanks a box of cells to `bg`. */
  fill(x: number, y: number, w: number, h: number, bg: number): void {
    const x0 = Math.max(0, Math.floor(x))
    const y0 = Math.max(0, Math.floor(y))
    const x1 = Math.min(this.columns, x + w)
    const y1 = Math.min(this.rows, y + h)
    const c = bg >>> 0
    for (let cy = y0; cy < y1; cy++) {
      for (let cx = x0; cx < x1; cx++) {
        const at = (cy * this.columns + cx) * 3
        this.cells[at] = SPACE
        this.cells[at + 1] = c
        this.cells[at + 2] = c
      }
    }
  }

  /** Writes text left to right from (x, y): at most `max` cells and never past the edge. Returns the columns advanced. */
  text(x: number, y: number, s: string, fg: number, bg?: number, max = Number.POSITIVE_INFINITY): number {
    let n = 0
    // By code point, as for...of would walk it, without the iterator.
    for (let i = 0; i < s.length;) {
      if (n >= max || x + n >= this.columns) break
      const c = s.codePointAt(i)!
      this.set(x + n, y, c, fg, bg)
      i += c > 0xffff ? 2 : 1
      n++
    }
    return n
  }

  /** The cells as the Raster's base64. Uint32Array is little-endian on every platform Claude Code runs on. */
  encode(): string {
    return toBase64(new Uint8Array(this.cells.buffer, this.cells.byteOffset, this.cells.byteLength))
  }

  toRaster(key: string): { key: string; columns: number; rows: number; cells: string } {
    return { key, columns: this.columns, rows: this.rows, cells: this.encode() }
  }
}

const B64_CODES = Uint8Array.from(B64, ch => ch.charCodeAt(0))
const PAD = 0x3d
/** Characters handed to String.fromCharCode at once: well under any engine's argument limit, and the fastest size measured. */
const CHUNK = 2048

/** Base64 written as character codes into a typed array, then turned into a string a chunk at a time. */
export function toBase64(bytes: Uint8Array): string {
  const n = bytes.length
  const out = new Uint8Array(Math.ceil(n / 3) * 4)
  let o = 0
  let i = 0
  for (; i + 2 < n; i += 3) {
    const v = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    out[o] = B64_CODES[(v >> 18) & 63]!
    out[o + 1] = B64_CODES[(v >> 12) & 63]!
    out[o + 2] = B64_CODES[(v >> 6) & 63]!
    out[o + 3] = B64_CODES[v & 63]!
    o += 4
  }
  if (n - i === 1) {
    const v = bytes[i]! << 16
    out[o] = B64_CODES[(v >> 18) & 63]!
    out[o + 1] = B64_CODES[(v >> 12) & 63]!
    out[o + 2] = PAD
    out[o + 3] = PAD
  } else if (n - i === 2) {
    const v = (bytes[i]! << 16) | (bytes[i + 1]! << 8)
    out[o] = B64_CODES[(v >> 18) & 63]!
    out[o + 1] = B64_CODES[(v >> 12) & 63]!
    out[o + 2] = B64_CODES[(v >> 6) & 63]!
    out[o + 3] = PAD
  }
  let text = ''
  // apply takes the typed array as it is; a spread would walk it through an iterator, several times slower.
  for (let k = 0; k < out.length; k += CHUNK) text += String.fromCharCode.apply(null, out.subarray(k, k + CHUNK) as unknown as number[])
  return text
}

export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let acc = 0
  let bits = 0
  let o = 0
  for (const ch of clean) {
    const v = B64.indexOf(ch)
    if (v < 0) throw new RangeError('not base64')
    acc = ((acc << 6) | v) & 0x3fff
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (acc >> bits) & 255
    }
  }
  return out.subarray(0, o)
}

/** A grid from a Raster's cells, for tests and previews. Throws RangeError when the size does not match. */
export function decodeCells(b64: string, columns: number, rows: number): Grid {
  const bytes = fromBase64(b64)
  if (bytes.length !== columns * rows * 12) throw new RangeError(`cells hold ${bytes.length} bytes, not ${columns * rows * 12}`)
  const words = new Uint32Array(bytes.slice().buffer)
  const grid = new Grid(columns, rows)
  grid.cells.set(words)
  return grid
}

/** Each row's glyphs as a string. */
export function gridText(grid: Grid): string[] {
  const rows: string[] = []
  for (let y = 0; y < grid.rows; y++) {
    let line = ''
    for (let x = 0; x < grid.columns; x++) line += String.fromCodePoint(grid.glyph(x, y))
    rows.push(line)
  }
  return rows
}

/** Whether two grids are the same size and hold the same cells, so a blit of one over the other would change nothing. */
export function sameCells(a: Grid, b: Grid): boolean {
  if (a.columns !== b.columns || a.rows !== b.rows) return false
  const x = a.cells
  const y = b.cells
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false
  return true
}

/**
 * How many distinct fg/bg pairs the grid holds. It runs on every frame; most cells repeat the cell before them (runs
 * of blank canvas), and those are already counted, so only the others reach the Set.
 */
export function pairCount(grid: Grid): number {
  const pairs = new Set<number>()
  const cells = grid.cells
  let lastFg = -1
  let lastBg = -1
  for (let i = 0; i < grid.columns * grid.rows; i++) {
    const fg = cells[i * 3 + 1]!
    const bg = cells[i * 3 + 2]!
    if (fg === lastFg && bg === lastBg) continue
    lastFg = fg
    lastBg = bg
    pairs.add(fg * 0x2000000 + bg)
  }
  return pairs.size
}

/**
 * Coarsens colours, one more low bit per channel each round, until the grid holds at most `max` fg/bg pairs.
 * Returns how many bits it dropped (0 when the grid was already under budget), or 8 when even the coarsest round
 * (each channel snapped to 0, 128 or 255: 27 colours plus the terminal default) is still over budget.
 */
export function limitPairs(grid: Grid, max: number): number {
  if (pairCount(grid) <= max) return 0
  const slots = grid.columns * grid.rows * 3
  for (let drop = 1; drop <= 7; drop++) {
    const step = 1 << drop
    const snap = (v: number) => Math.min(255, Math.round(v / step) * step)
    for (let slot = 1; slot < slots; slot++) {
      if (slot % 3 === 0) continue
      const c = grid.cells[slot]!
      if (c !== DEFAULT) grid.cells[slot] = rgb(snap((c >>> 16) & 255), snap((c >>> 8) & 255), snap(c & 255))
    }
    if (pairCount(grid) <= max) return drop
  }
  return 8
}

/** One coloured run of text. */
export type Part = readonly [text: string, fg: number]

/** Writes parts left to right from x, stopping before maxX. Returns the next free column. */
export function writeParts(grid: Grid, x: number, y: number, parts: readonly Part[], maxX: number, bg?: number): number {
  let cx = x
  for (const [text, fg] of parts) {
    if (cx >= maxX) break
    cx += grid.text(cx, y, text, fg, bg, maxX - cx)
  }
  return cx
}

/** Writes parts so they end just before maxX, never starting left of minX. Returns the column it started at. */
export function writeRight(grid: Grid, y: number, parts: readonly Part[], minX: number, maxX: number, bg?: number): number {
  const width = parts.reduce((n, [text]) => n + [...text].length, 0)
  const start = Math.max(minX, maxX - width)
  writeParts(grid, start, y, parts, maxX, bg)
  return start
}
