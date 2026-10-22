import { test } from 'node:test'
import assert from 'node:assert/strict'
import { changedBox, cellsOf, paintCell, paintGrids } from '../../src/render/raster.ts'
import { DEFAULT } from '../../src/render/color.ts'
import { goldenFrame, GOLDEN_CASES } from './golden-cases.ts'

test('paintGrids sizes the picture as preview did', () => {
  const f = goldenFrame(GOLDEN_CASES[0]!)
  const grids = f.bottom === null ? [f.top] : [f.top, f.bottom]
  const pic = paintGrids(grids)
  assert.equal(pic.width, Math.max(...grids.map(g => g.columns)) * 8)
  assert.equal(pic.height, (grids.reduce((n, g) => n + g.rows, 0) + grids.length - 1) * 16)
})

test('changedBox finds the cells that differ', () => {
  const f = goldenFrame(GOLDEN_CASES[0]!)
  const a = cellsOf([f.top, f.bottom], 120, 56)
  const b = cellsOf([f.top, f.bottom], 120, 56)
  assert.equal(changedBox(a, b), null)
  b.bg[3 * 120 + 7] = 0x123456
  assert.deepEqual(changedBox(a, b), { x: 7, y: 3, w: 1, h: 1 })
  assert.deepEqual(changedBox(null, b), { x: 0, y: 0, w: 120, h: 56 })
})

test('U+2800, controls and variation selectors draw nothing', () => {
  for (const glyph of [0x2800, 0x07, 0x85, 0xfe0e, 0xfe0f]) {
    const rgb = new Uint8Array(8 * 16 * 3)
    paintCell(rgb, 8, 0, 0, glyph, 0xffffff, DEFAULT)
    assert.equal(rgb.every(v => v === 0), true, `U+${glyph.toString(16)}`)
  }
})
