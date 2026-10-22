import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GifWriter } from '../../src/gif/encode.ts'
import { Palette, TRANSPARENT } from '../../src/gif/palette.ts'
import type { Cells } from '../../src/render/raster.ts'
import { CELL_H, CELL_W } from '../../src/render/svg.ts'
import { decodeGif } from './decode.ts'

const cells = (columns: number, rows: number, bg: number): Cells => ({
  columns, rows, glyph: new Uint32Array(columns * rows).fill(0x20), fg: new Uint32Array(columns * rows).fill(0xffffff), bg: new Uint32Array(columns * rows).fill(bg),
})

test('a two-frame GIF decodes: header, loop, palette, a full frame then a small transparent one', () => {
  const w = new GifWriter(4 * CELL_W, 3 * CELL_H)
  const a = cells(4, 3, 0x0d1117)
  w.add(a, 10)
  const b = cells(4, 3, 0x0d1117)
  b.bg[5] = 0xff8800
  w.add(b, 10)
  const gif = decodeGif(w.finish())
  assert.equal(gif.width, 32)
  assert.equal(gif.height, 48)
  assert.equal(gif.loops, true)
  assert.equal(gif.frames.length, 2)
  assert.deepEqual([gif.frames[1]!.x, gif.frames[1]!.y, gif.frames[1]!.w, gif.frames[1]!.h], [CELL_W, CELL_H, CELL_W, CELL_H])
  assert.equal(gif.frames[1]!.transparent, TRANSPARENT)
  assert.equal(gif.frames[0]!.pixels.every(i => gif.palette[i] === 0x0d1117), true)
  assert.equal(gif.frames[1]!.pixels.every(i => gif.palette[i] === 0xff8800), true)
})

test('an unchanged frame adds its delay to the last one', () => {
  const w = new GifWriter(8, 16)
  w.add(cells(1, 1, 0x112233), 10)
  w.add(cells(1, 1, 0x112233), 10)
  const gif = decodeGif(w.finish())
  assert.equal(gif.frames.length, 1)
  assert.equal(gif.frames[0]!.delayCs, 20)
})

test('the palette keeps index 0 free and maps colours past 255 to the nearest', () => {
  const p = new Palette()
  assert.notEqual(p.indexOf(0x000000), TRANSPARENT)
  for (let i = 1; i <= 300; i++) p.indexOf(i * 50_000)
  assert.equal(p.size, 256)
  const near = p.indexOf(0xfefefe)
  assert.ok(near > 0 && near < 256)
})
