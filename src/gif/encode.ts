/**
 * A GIF89a writer for the export (spec section 4): one global palette, a looping animation, and frame differencing at
 * cell level. Each frame paints only the cells that changed; unchanged pixels inside that box are transparent. Pure.
 */
import { changedBox, paintCell, type Cells } from '../render/raster.ts'
import { CELL_H, CELL_W } from '../render/svg.ts'
import { lzwEncode } from './lzw.ts'
import { Palette, TRANSPARENT } from './palette.ts'

export type GifFrame = { x: number; y: number; w: number; h: number; delayCs: number; transparent: boolean; lzw: Uint8Array }
const MAX_DELAY_CS = 65_535

export class GifWriter {
  readonly width: number
  readonly height: number
  readonly #palette = new Palette()
  readonly #frames: GifFrame[] = []
  #last: Cells | null = null
  #lastIdx: Uint8Array | null = null
  #bytes = 800

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
  }

  get frames(): number {
    return this.#frames.length
  }

  get bytes(): number {
    return this.#bytes
  }

  add(cells: Cells, delayCs: number): void {
    if (Math.ceil(this.width / CELL_W) < cells.columns || Math.ceil(this.height / CELL_H) < cells.rows) {
      throw new RangeError(`GifWriter: ${cells.columns}x${cells.rows} cells do not fit a ${this.width}x${this.height} canvas`)
    }
    delayCs = Math.min(delayCs, MAX_DELAY_CS)
    const box = changedBox(this.#last, cells)
    const prev = this.#frames.at(-1)
    if (box === null && prev !== undefined && prev.delayCs + delayCs <= MAX_DELAY_CS) {
      prev.delayCs += delayCs
      return
    }
    const b = box ?? { x: 0, y: 0, w: 1, h: 1 }
    const px = { x: b.x * CELL_W, y: b.y * CELL_H, w: Math.min(b.w * CELL_W, this.width - b.x * CELL_W), h: Math.min(b.h * CELL_H, this.height - b.y * CELL_H) }
    const rgb = new Uint8Array(px.w * px.h * 3)
    for (let cy = b.y; cy < b.y + b.h; cy++) {
      for (let cx = b.x; cx < b.x + b.w; cx++) {
        const i = cy * cells.columns + cx
        paintCell(rgb, px.w, (cx - b.x) * CELL_W, (cy - b.y) * CELL_H, cells.glyph[i]!, cells.fg[i]!, cells.bg[i]!)
      }
    }
    const full = this.#lastIdx ?? new Uint8Array(this.width * this.height)
    const idx = new Uint8Array(px.w * px.h)
    const first = this.#lastIdx === null
    for (let y = 0; y < px.h; y++) {
      for (let x = 0; x < px.w; x++) {
        const o = (y * px.w + x) * 3
        const colour = this.#palette.indexOf((rgb[o]! << 16) | (rgb[o + 1]! << 8) | rgb[o + 2]!)
        const at = (px.y + y) * this.width + px.x + x
        idx[y * px.w + x] = !first && full[at] === colour ? TRANSPARENT : colour
        full[at] = colour
      }
    }
    this.#lastIdx = full
    this.#last = { ...cells, glyph: cells.glyph.slice(), fg: cells.fg.slice(), bg: cells.bg.slice() }
    const lzw = lzwEncode(idx)
    this.#frames.push({ ...px, delayCs, transparent: !first, lzw })
    this.#bytes += 19 + lzw.length + Math.ceil(lzw.length / 255) + 2
  }

  finish(): Uint8Array {
    const out: number[] = []
    const u16 = (n: number) => out.push(n & 255, (n >> 8) & 255)
    out.push(...[0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
    u16(this.width)
    u16(this.height)
    out.push(0xf7, 0, 0)
    out.push(...this.#palette.table())
    out.push(0x21, 0xff, 0x0b, ...[...'NETSCAPE2.0'].map(c => c.charCodeAt(0)), 0x03, 0x01, 0x00, 0x00, 0x00)
    for (const f of this.#frames) {
      out.push(0x21, 0xf9, 0x04, (1 << 2) | (f.transparent ? 1 : 0))
      u16(f.delayCs)
      out.push(TRANSPARENT, 0x00, 0x2c)
      u16(f.x)
      u16(f.y)
      u16(f.w)
      u16(f.h)
      out.push(0x00, 8)
      for (let i = 0; i < f.lzw.length; i += 255) {
        const n = Math.min(255, f.lzw.length - i)
        out.push(n)
        for (let j = 0; j < n; j++) out.push(f.lzw[i + j]!)
      }
      out.push(0x00)
    }
    out.push(0x3b)
    return Uint8Array.from(out)
  }
}
