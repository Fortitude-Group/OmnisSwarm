import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Dots, Pixels, compose, toDots } from '../../src/render/canvas.ts'
import { Grid, gridText } from '../../src/render/grid.ts'
import { rect } from '../../src/render/types.ts'

test('pixels read, write, blend and light by floored position, and ignore the outside', () => {
  const p = new Pixels(4, 4, 0x111111)
  assert.equal(p.get(0, 0), 0x111111)
  p.set(1, 1, 0xff0000)
  assert.equal(p.get(1.7, 1.2), 0xff0000)
  assert.equal(p.get(9, 9), 0)
  p.set(9, 9, 0xffffff)
  p.blend(1, 1, 0x000000, 0.5)
  assert.equal(p.get(1, 1), 0x800000)
  p.light(0, 0, 0x101010, 1)
  assert.equal(p.get(0, 0), 0x212121)
  p.line({ x: 0, y: 3 }, { x: 3, y: 3 }, 0x00ff00)
  for (let x = 0; x < 4; x++) assert.equal(p.get(x, 3), 0x00ff00)
})

test('dots set the braille bit for their place in the cell', () => {
  const d = new Dots(2, 1)
  assert.equal(d.width, 4)
  assert.equal(d.height, 4)
  d.dot(0, 0, 1)
  d.dot(1, 0, 1)
  d.dot(0, 3, 1)
  d.dot(1, 3, 1)
  d.dot(2, 0, 7)
  d.dot(4, 0, 1)
  assert.equal(d.bits[0], 0xc9)
  assert.equal(d.bits[1], 0x01)
  assert.equal(d.colors[1], 7)
})

test('a dashed dot line leaves every other run out', () => {
  const d = new Dots(4, 1)
  d.line({ x: 0, y: 0 }, { x: 7, y: 0 }, 1, 2)
  assert.deepEqual([...d.bits], [0x09, 0, 0x09, 0])
})

test('compose draws half-blocks, flat cells and braille over the mean of the two pixels', () => {
  const g = new Grid(2, 1)
  const p = new Pixels(2, 2, 0)
  p.set(0, 0, 0xff0000)
  p.set(0, 1, 0x0000ff)
  p.set(1, 0, 0x00ff00)
  p.set(1, 1, 0x00ff00)
  const d = new Dots(2, 1)
  compose(g, rect(0, 0, 2, 1), p, d)
  assert.equal(g.glyph(0, 0), 0x2580)
  assert.equal(g.fg(0, 0), 0xff0000)
  assert.equal(g.bg(0, 0), 0x0000ff)
  assert.deepEqual(gridText(g)[0]![1], ' ')
  assert.equal(g.bg(1, 0), 0x00ff00)
  d.dot(2, 0, 0xffffff)
  compose(g, rect(0, 0, 2, 1), p, d)
  assert.equal(g.glyph(1, 0), 0x2801)
  assert.equal(g.fg(1, 0), 0xffffff)
  assert.equal(g.bg(1, 0), 0x00ff00)
})

test('toDots doubles both axes', () => {
  assert.deepEqual(toDots({ x: 1.5, y: 2 }), { x: 3, y: 4 })
})

test('non-finite coordinates are ignored and long lines stay bounded', () => {
  const p = new Pixels(4, 4, 0x111111)
  p.set(NaN, 1, 0xffffff)
  assert.equal(p.get(NaN, 0), 0)
  assert.equal(p.get(Infinity, 0), 0)
  p.line({ x: 0, y: 0 }, { x: Infinity, y: 0 }, 0xffffff)
  p.line({ x: NaN, y: 0 }, { x: 1, y: 0 }, 0xffffff)
  assert.equal(p.get(0, 0), 0x111111)
  const d = new Dots(2, 1)
  d.dot(0, NaN, 1)
  d.dot(Infinity, 0, 1)
  d.line({ x: 0, y: 0 }, { x: -Infinity, y: 0 }, 1)
  assert.deepEqual([...d.bits], [0, 0])
  const t = Date.now()
  p.line({ x: 0, y: 0 }, { x: 3e7, y: 3e7 }, 0x00ff00)
  d.line({ x: 0, y: 0 }, { x: 3e7, y: 3e7 }, 1)
  assert.ok(Date.now() - t < 100)
})
