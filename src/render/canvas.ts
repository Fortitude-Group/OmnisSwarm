/**
 * The graph's two layers: a half-block pixel canvas (two pixels a cell, one above the other) for nodes, glow and thick
 * links, and braille dots (2x4 a cell) for fine lines and particles. compose() paints both into cells. Pure.
 */
import { add, mix } from './color.ts'
import type { Grid } from './grid.ts'
import type { Point, Rect } from './types.ts'

const UPPER_HALF = 0x2580
const SPACE = 0x20
const BRAILLE = 0x2800
/** Braille dot bits by [row][column] within one cell. */
const BIT: ReadonlyArray<readonly [number, number]> = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]]

export class Pixels {
  readonly width: number
  readonly height: number
  readonly data: Uint32Array

  constructor(width: number, height: number, bg: number) {
    this.width = Math.max(1, Math.floor(width))
    this.height = Math.max(1, Math.floor(height))
    this.data = new Uint32Array(this.width * this.height).fill(bg >>> 0)
  }

  #at(x: number, y: number): number {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return -1
    const px = Math.floor(x)
    const py = Math.floor(y)
    return px < 0 || py < 0 || px >= this.width || py >= this.height ? -1 : py * this.width + px
  }

  get(x: number, y: number): number {
    const i = this.#at(x, y)
    return i < 0 ? 0 : this.data[i]!
  }

  set(x: number, y: number, c: number): void {
    const i = this.#at(x, y)
    if (i >= 0) this.data[i] = c >>> 0
  }

  blend(x: number, y: number, c: number, t: number): void {
    const i = this.#at(x, y)
    if (i >= 0) this.data[i] = mix(this.data[i]!, c, t)
  }

  light(x: number, y: number, c: number, k: number): void {
    const i = this.#at(x, y)
    if (i >= 0) this.data[i] = add(this.data[i]!, c, k)
  }

  line(a: Point, b: Point, c: number, t = 1): void {
    if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) return
    const steps = Math.min(this.width + this.height, Math.max(1, Math.ceil(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)))))
    for (let i = 0; i <= steps; i++) this.blend(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps, c, t)
  }
}

export class Dots {
  readonly columns: number
  readonly rows: number
  readonly bits: Uint8Array
  readonly colors: Uint32Array

  constructor(columns: number, rows: number) {
    this.columns = Math.max(1, Math.floor(columns))
    this.rows = Math.max(1, Math.floor(rows))
    this.bits = new Uint8Array(this.columns * this.rows)
    this.colors = new Uint32Array(this.columns * this.rows)
  }

  get width(): number {
    return this.columns * 2
  }

  get height(): number {
    return this.rows * 4
  }

  /** Lights the dot under (x, y), in dot space. A cell takes the colour of the last dot drawn in it. */
  dot(x: number, y: number, c: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    const dx = Math.floor(x)
    const dy = Math.floor(y)
    if (dx < 0 || dy < 0 || dx >= this.width || dy >= this.height) return
    const cell = Math.floor(dy / 4) * this.columns + Math.floor(dx / 2)
    this.bits[cell] = this.bits[cell]! | BIT[dy % 4]![dx % 2]!
    this.colors[cell] = c >>> 0
  }

  /** A line of dots from a to b in dot space. With `dash`, every other run of `dash` dots is left out. */
  line(a: Point, b: Point, c: number, dash = 0): void {
    if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) return
    const steps = Math.min(this.width + this.height, Math.max(1, Math.ceil(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)))))
    for (let i = 0; i <= steps; i++) {
      if (dash > 0 && Math.floor(i / dash) % 2 === 1) continue
      this.dot(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps, c)
    }
  }
}

/** Pixel space to dot space: a pixel is one cell wide and half a cell tall, a dot half a cell wide and a quarter tall. */
export const toDots = (p: Point): Point => ({ x: p.x * 2, y: p.y * 2 })

/** Paints both layers into `grid` at `area`. A cell with dots shows braille over the mean of its two pixels. */
export function compose(grid: Grid, area: Rect, pixels: Pixels, dots: Dots): void {
  const w = Math.min(area.w, pixels.width, dots.columns)
  const h = Math.min(area.h, Math.floor(pixels.height / 2), dots.rows)
  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) {
      const top = pixels.get(cx, cy * 2)
      const bottom = pixels.get(cx, cy * 2 + 1)
      const i = cy * dots.columns + cx
      const bits = dots.bits[i]!
      if (bits !== 0) grid.set(area.x + cx, area.y + cy, BRAILLE + bits, dots.colors[i]!, mix(top, bottom, 0.5))
      else if (top === bottom) grid.set(area.x + cx, area.y + cy, SPACE, top, top)
      else grid.set(area.x + cx, area.y + cy, UPPER_HALF, top, bottom)
    }
  }
}
