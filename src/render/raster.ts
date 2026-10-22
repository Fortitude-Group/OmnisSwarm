/**
 * The software rasteriser shared by the preview script and the GIF export: a Grid (or stack of grids) to RGB pixels,
 * one 8x16 cell at a time. Blocks and braille are drawn exactly, other glyphs from the bitmap font (a soft bar when the
 * font lacks one). Pure.
 */
import { DEFAULT } from './color.ts'
import type { Grid } from './grid.ts'
import { FONT_H, FONT_W, glyphRows } from './font/index.ts'
import { CELL_H, CELL_W, blockRects } from './svg.ts'
import { CANVAS } from './tokens.ts'

export type Cells = { columns: number; rows: number; glyph: Uint32Array; fg: Uint32Array; bg: Uint32Array }

const DOTS: ReadonlyArray<readonly [number, number]> = [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2], [0, 3], [1, 3]]

/** Stacks the grids with one blank row between them, padded with the canvas colour out to columns x rows. */
export function cellsOf(grids: readonly (Grid | null)[], columns: number, rows: number): Cells {
  const n = columns * rows
  const cells: Cells = { columns, rows, glyph: new Uint32Array(n).fill(0x20), fg: new Uint32Array(n).fill(0xc9d1d9), bg: new Uint32Array(n).fill(CANVAS) }
  let oy = 0
  for (const g of grids) {
    if (g === null) continue
    for (let y = 0; y < g.rows && oy + y < rows; y++) {
      for (let x = 0; x < g.columns && x < columns; x++) {
        const i = (oy + y) * columns + x
        cells.glyph[i] = g.glyph(x, y)
        cells.fg[i] = g.fg(x, y)
        cells.bg[i] = g.bg(x, y)
      }
    }
    oy += g.rows + 1
  }
  return cells
}

/** Cells that draw nothing: space, U+2800, controls, variation selectors and values past Unicode (as svg.ts). */
function isBlank(code: number): boolean {
  return code <= 0x20 || code === 0x2800 || (code >= 0x7f && code <= 0x9f) || code === 0xfe0e || code === 0xfe0f || code > 0x10ffff
}

/** Paints one cell into a packed RGB buffer `width` pixels wide, its top-left pixel at (x0, y0). */
export function paintCell(rgb: Uint8Array, width: number, x0: number, y0: number, glyph: number, fg: number, bg: number): void {
  const height = Math.floor(rgb.length / 3 / width)
  const fill = (x: number, y: number, w: number, h: number, c: number, a = 1) => {
    for (let yy = Math.round(y); yy < Math.round(y + h); yy++) {
      for (let xx = Math.round(x); xx < Math.round(x + w); xx++) {
        if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue
        const i = (yy * width + xx) * 3
        rgb[i] = Math.round(rgb[i]! * (1 - a) + ((c >>> 16) & 255) * a)
        rgb[i + 1] = Math.round(rgb[i + 1]! * (1 - a) + ((c >>> 8) & 255) * a)
        rgb[i + 2] = Math.round(rgb[i + 2]! * (1 - a) + (c & 255) * a)
      }
    }
  }
  const colour = fg === DEFAULT ? 0xc9d1d9 : fg
  if (bg !== DEFAULT) fill(x0, y0, CELL_W, CELL_H, bg)
  const block = blockRects(glyph)
  if (block !== null) {
    for (const [rx, ry, rw, rh] of block.rects) fill(x0 + rx * CELL_W, y0 + ry * CELL_H, rw * CELL_W, rh * CELL_H, colour, block.opacity)
  } else if (glyph > 0x2800 && glyph <= 0x28ff) {
    DOTS.forEach(([col, row], bit) => {
      if (((glyph - 0x2800) >> bit) & 1) fill(x0 + col * 4 + 1, y0 + row * 4 + 1, 2, 2, colour)
    })
  } else if (!isBlank(glyph)) {
    const rows = glyphRows(glyph)
    if (rows === null) fill(x0 + 1, y0 + 4, CELL_W - 2, CELL_H - 8, colour, 0.6)
    else {
      for (let y = 0; y < FONT_H; y++) {
        for (let x = 0; x < FONT_W; x++) if ((rows[y]! >> (7 - x)) & 1) fill(x0 + x, y0 + y, 1, 1, colour)
      }
    }
  }
}

export function paintGrids(grids: readonly Grid[]): { width: number; height: number; rgb: Uint8Array } {
  const width = Math.max(...grids.map(g => g.columns)) * CELL_W
  const height = (grids.reduce((n, g) => n + g.rows, 0) + grids.length - 1) * CELL_H
  const rgb = new Uint8Array(width * height * 3)
  let oy = 0
  for (const g of grids) {
    for (let cy = 0; cy < g.rows; cy++) {
      for (let cx = 0; cx < g.columns; cx++) paintCell(rgb, width, cx * CELL_W, oy + cy * CELL_H, g.glyph(cx, cy), g.fg(cx, cy), g.bg(cx, cy))
    }
    oy += (g.rows + 1) * CELL_H
  }
  return { width, height, rgb }
}

export function changedBox(a: Cells | null, b: Cells): { x: number; y: number; w: number; h: number } | null {
  if (a === null || a.columns !== b.columns || a.rows !== b.rows) return { x: 0, y: 0, w: b.columns, h: b.rows }
  let x0 = b.columns
  let y0 = b.rows
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < b.rows; y++) {
    for (let x = 0; x < b.columns; x++) {
      const i = y * b.columns + x
      if (a.glyph[i] === b.glyph[i] && a.fg[i] === b.fg[i] && a.bg[i] === b.bg[i]) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
}
