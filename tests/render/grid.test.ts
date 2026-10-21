import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT } from '../../src/render/color.ts'
import {
  Grid, decodeCells, fromBase64, gridText, limitPairs, pairCount, safeGlyph, sameCells, toBase64, writeParts, writeRight,
} from '../../src/render/grid.ts'
import { RASTER_MAX } from '../../src/render/tokens.ts'

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

test('base64 of a whole large Raster matches Node, across every chunk boundary and tail length', () => {
  for (const length of [0, 1, 2, 3, 6143, 6144, 6145, 24_576, 120 * 26 * 12, 512 * 256 * 12 + 2]) {
    const bytes = Uint8Array.from({ length }, (_, i) => (i * 131 + (i >> 7)) & 255)
    assert.equal(toBase64(bytes), Buffer.from(bytes).toString('base64'), `${length} bytes`)
  }
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

test('fill clips to the grid, so an infinite box returns at once', () => {
  const g = new Grid(3, 2)
  g.fill(-5, -5, Number.POSITIVE_INFINITY, 5.5, 0x123456)
  assert.equal(g.bg(2, 0), 0x123456)
  assert.equal(g.bg(0, 1), DEFAULT)
  g.fill(1, 1, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, 0x654321)
  assert.equal(g.bg(2, 1), 0x654321)
  assert.equal(g.bg(0, 1), DEFAULT)
})

test('reads and writes outside the grid, or at non-finite spots, are harmless', () => {
  const g = new Grid(2, 2, 0x111111, 0x222222)
  for (const [x, y] of [[-1, 0], [0, -1], [2, 0], [0, 2], [Number.NaN, 0], [0, Number.POSITIVE_INFINITY]] as const) {
    assert.equal(g.glyph(x, y), 0x20)
    assert.equal(g.fg(x, y), DEFAULT)
    assert.equal(g.bg(x, y), DEFAULT)
    g.set(x, y, 0x41, 0xffffff, 0xffffff)
  }
  assert.deepEqual(gridText(g), ['  ', '  '])
  assert.equal(g.bg(0, 0), 0x111111)
})

test('grid sizes are whole, at least 1, finite and capped at the Raster limit', () => {
  const g = new Grid(Number.NaN, Number.POSITIVE_INFINITY)
  assert.equal(g.columns, 1)
  assert.equal(g.rows, 1)
  const big = new Grid(100_000, 100_000)
  assert.equal(big.columns, RASTER_MAX.columns)
  assert.equal(big.rows, RASTER_MAX.rows)
  assert.equal(new Grid(2.9, 0).columns, 2)
})

test('limitPairs never recolours the terminal default and says when it cannot reach the budget', () => {
  const g = new Grid(40, 40)
  for (let i = 1; i < 1600; i++) g.set(i % 40, Math.floor(i / 40), 0x2580, (i * 9973) & 0xffffff, (i * 7919) & 0xffffff)
  assert.ok(limitPairs(g, 500) > 0)
  assert.equal(g.fg(0, 0), DEFAULT)
  assert.equal(g.bg(0, 0), DEFAULT)
  const h = new Grid(40, 40)
  for (let i = 0; i < 1600; i++) h.set(i % 40, Math.floor(i / 40), 0x2580, (i * 9973) & 0xffffff, (i * 7919) & 0xffffff)
  assert.equal(limitPairs(h, 2), 8)
})

test('fromBase64 rejects characters outside the alphabet', () => {
  for (const bad of ['TW!u', 'TW u', '-_-_', 'TWFu\n']) assert.throws(() => fromBase64(bad), RangeError, JSON.stringify(bad))
})

test('text reports the columns it advanced', () => {
  assert.equal(new Grid(5, 1).text(0, 0, 'abc😀', 0xffffff), 4)
})

test('sameCells is true only for the same size and every cell alike', () => {
  const a = new Grid(4, 2, 0x0b0f17, 0xe6edf3)
  const b = new Grid(4, 2, 0x0b0f17, 0xe6edf3)
  assert.equal(sameCells(a, b), true)
  b.set(3, 1, 0x41, 0xe6edf3)
  assert.equal(sameCells(a, b), false)
  a.set(3, 1, 0x41, 0xe6edf3)
  assert.equal(sameCells(a, b), true)
  a.set(0, 0, 0x20, 0xe6edf3, 0x131a26)
  assert.equal(sameCells(a, b), false)
  assert.equal(sameCells(new Grid(4, 2), new Grid(2, 4)), false)
})

test('pairCount agrees with a plain Set of pairs, for small, large and default-coloured grids', () => {
  const bySet = (g: Grid) => {
    const pairs = new Set<string>()
    for (let i = 0; i < g.columns * g.rows; i++) pairs.add(`${g.cells[i * 3 + 1]} ${g.cells[i * 3 + 2]}`)
    return pairs.size
  }
  for (const [w, h, colours] of [[1, 1, 1], [7, 3, 4], [120, 26, 40], [120, 26, 3000], [512, 256, 50_000]] as const) {
    const g = new Grid(w, h)
    let seed = w * 7919 + h
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
        const fg = seed % colours === 0 ? 0x01000000 : (seed % colours) * 0x010203
        g.set(x, y, 0x41, fg & 0x1ffffff, ((seed >>> 8) % colours) * 0x030201)
      }
    }
    assert.equal(pairCount(g), bySet(g), `${w}x${h}`)
  }
})
