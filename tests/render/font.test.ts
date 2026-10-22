import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { FONT_H, FONT_W, REQUIRED, glyphRows } from '../../src/render/font/index.ts'
import { paintCell } from '../../src/render/raster.ts'

const RENDER = join(import.meta.dirname, '..', '..', 'src', 'render')

test('every required glyph has 16 rows', () => {
  const missing = REQUIRED.filter(cp => glyphRows(cp)?.length !== FONT_H)
  assert.deepEqual(missing.map(cp => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`), [])
})

test('REQUIRED covers every non-ASCII character in the render code outside comments, bar blocks and braille', () => {
  const required = new Set(REQUIRED)
  const found = new Set<number>()
  for (const name of readdirSync(RENDER).filter(f => f.endsWith('.ts'))) {
    const code = readFileSync(join(RENDER, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    for (const ch of code) {
      const cp = ch.codePointAt(0)!
      if (cp > 0x7e && !(cp >= 0x2580 && cp <= 0x259f) && !(cp >= 0x2800 && cp <= 0x28ff)) found.add(cp)
    }
  }
  const gaps = [...found].filter(cp => !required.has(cp))
  assert.deepEqual(gaps.map(cp => String.fromCodePoint(cp)), [])
})

test('a letter is drawn from its bitmap, fg on bg, with no soft bar', () => {
  const rgb = new Uint8Array(FONT_W * FONT_H * 3)
  paintCell(rgb, FONT_W, 0, 0, 'A'.codePointAt(0)!, 0xffffff, 0x000000)
  const rows = glyphRows(0x41)!
  for (let y = 0; y < FONT_H; y++) {
    for (let x = 0; x < FONT_W; x++) {
      const on = (rows[y]! >> (7 - x)) & 1
      assert.equal(rgb[(y * FONT_W + x) * 3], on ? 255 : 0, `pixel ${x},${y}`)
    }
  }
})

test('a glyph the font lacks still gets the soft bar', () => {
  const rgb = new Uint8Array(FONT_W * FONT_H * 3)
  paintCell(rgb, FONT_W, 0, 0, 0x4e00, 0xffffff, 0x000000)
  assert.ok(rgb.some(v => v > 0) && rgb.some(v => v > 0 && v < 255), 'the 0.6 bar blends')
})

test('a quadrant block is exact, not a bar', () => {
  const rgb = new Uint8Array(FONT_W * FONT_H * 3)
  paintCell(rgb, FONT_W, 0, 0, 0x2598, 0xffffff, 0x000000)
  assert.equal(rgb[0], 255)
  assert.equal(rgb[((FONT_H - 1) * FONT_W + FONT_W - 1) * 3], 0)
})

test('the licence ships beside the font', () => {
  const licence = readFileSync(join(RENDER, 'font', 'LICENSE-spleen.txt'), 'utf8')
  assert.match(licence, /Redistribution and use in source and binary forms/)
  assert.match(readFileSync(join(RENDER, 'font', 'spleen8x16.ts'), 'utf8'), /Cambus/)
})
