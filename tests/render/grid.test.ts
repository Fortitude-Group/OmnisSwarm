import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT } from '../../src/render/color.ts'
import {
  Grid, decodeCells, fromBase64, gridText, limitPairs, pairCount, safeGlyph, toBase64, writeParts, writeRight,
} from '../../src/render/grid.ts'

test('a new grid is blank, in the terminal colours unless told otherwise', () => {
  const g = new Grid(3, 2)
  assert.deepEqual(gridText(g), ['   ', '   '])
  assert.equal(g.fg(0, 0), DEFAULT)
  assert.equal(new Grid(2, 1, 0x112233).bg(1, 0), 0x112233)
})

test('set writes inside the grid and ignores anything outside it', () => {
  const g = new Grid(2, 2)
  g.set(1, 1, 0x41, 0xff0000, 0x00ff00)
  g.set(5, 5, 0x42, 0xff0000)
  g.set(-1, 0, 0x42, 0xff0000)
  assert.equal(g.glyph(1, 1), 0x41)
  assert.equal(g.fg(1, 1), 0xff0000)
  assert.equal(g.bg(1, 1), 0x00ff00)
  assert.deepEqual(gridText(g), ['  ', ' A'])
})

test('safeGlyph keeps printable width-1 BMP characters and replaces the rest with ?', () => {
  for (const ok of [0x41, 0x20, 0x2580, 0x28ff, 0x25b6, 0x2713, 0x2715, 0x25cc, 0x26a0, 0x2588]) assert.equal(safeGlyph(ok), ok, ok.toString(16))
  for (const bad of [0x07, 0x7f, 0x9b, 0x0301, 0x200b, 0x202e, 0xd800, 0xe000, 0x4e2d, 0xac00, 0xff21, 0x26a1, 0x231a, 0xfe0f, 0x1f600, -1, 1.5]) {
    assert.equal(safeGlyph(bad), 0x3f, bad.toString(16))
  }
})

test('text writes code points, clips at the edge and at max, and makes unsafe ones ?', () => {
  const g = new Grid(6, 1)
  assert.equal(g.text(0, 0, 'ab😀c\u0007d', 0xffffff), 6)
  assert.deepEqual(gridText(g), ['ab?c?d'])
  const h = new Grid(4, 1)
  assert.equal(h.text(1, 0, 'hello', 0xffffff), 3)
  assert.equal(h.text(0, 0, 'xyz', 0xffffff, undefined, 2), 2)
  assert.deepEqual(gridText(h), ['xyel'])
})

test('base64 matches the standard alphabet and round-trips', () => {
  assert.equal(toBase64(Uint8Array.of(0x4d, 0x61, 0x6e)), 'TWFu')
  assert.equal(toBase64(Uint8Array.of(0x4d)), 'TQ==')
  assert.equal(toBase64(Uint8Array.of(0x4d, 0x61)), 'TWE=')
  assert.deepEqual([...fromBase64('TWE=')], [0x4d, 0x61])
  const bytes = Uint8Array.from({ length: 257 }, (_, i) => (i * 37) & 255)
  assert.equal(toBase64(bytes), Buffer.from(bytes).toString('base64'))
  assert.deepEqual([...fromBase64(toBase64(bytes))], [...bytes])
})

test('encode packs little-endian [codePoint, fg, bg] triplets as the Raster expects', () => {
  const g = new Grid(1, 1)
  g.set(0, 0, 0x2588, 0xff8800, DEFAULT)
  const expected = Buffer.from(new Uint8Array(Uint32Array.of(0x2588, 0xff8800, 0x01000000).buffer)).toString('base64')
  assert.equal(g.encode(), expected)
  assert.deepEqual(g.toRaster('k'), { key: 'k', columns: 1, rows: 1, cells: expected })
})

test('decodeCells rebuilds the grid and refuses the wrong size', () => {
  const g = new Grid(3, 2, 0x101010)
  g.text(0, 1, 'hi▀', 0xabcdef)
  const back = decodeCells(g.encode(), 3, 2)
  assert.deepEqual([...back.cells], [...g.cells])
  assert.throws(() => decodeCells(g.encode(), 2, 2), RangeError)
})

test('pairCount counts distinct fg/bg pairs and limitPairs brings a grid under budget', () => {
  const g = new Grid(2, 1)
  g.set(1, 0, 0x41, 0xff0000, 0x000000)
  assert.equal(pairCount(g), 2)
  assert.equal(limitPairs(g, 10), 0)
  const big = new Grid(40, 40, 0x0b0f17)
  for (let i = 0; i < 1600; i++) big.set(i % 40, Math.floor(i / 40), 0x2580, (i * 9973) & 0xffffff)
  assert.ok(pairCount(big) > 1000)
  assert.ok(limitPairs(big, 1000) > 0)
  assert.ok(pairCount(big) <= 1000)
})

test('writeParts writes coloured runs left to right, writeRight aligns them to the right', () => {
  const g = new Grid(10, 1)
  const next = writeParts(g, 0, 0, [['ab', 0xff0000], ['cd', 0x00ff00]], 10)
  assert.equal(next, 4)
  assert.equal(g.fg(2, 0), 0x00ff00)
  writeRight(g, 0, [['xy', 0x0000ff]], 0, 10)
  assert.deepEqual(gridText(g), ['abcd    xy'])
  assert.equal(writeParts(g, 8, 0, [['longer', 0xffffff]], 10), 10)
})
