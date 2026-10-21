import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT } from '../../src/render/color.ts'
import { Grid } from '../../src/render/grid.ts'
import { blockShape, escapeXml, gridToSvg } from '../../src/render/svg.ts'

test('a half-block cell is a background rectangle and a top-half rectangle', () => {
  const g = new Grid(1, 1)
  g.set(0, 0, 0x2580, 0xff0000, 0x0000ff)
  const svg = gridToSvg(g, 'one cell')!
  assert.ok(svg.includes('<path fill="#0000ff" d="M0 0h8v16h-8z"/>'))
  assert.ok(svg.includes('<path fill="#ff0000" d="M0 0h8v8h-8z"/>'))
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="16"'))
  assert.ok(svg.includes('<title>one cell</title>'))
})

test('braille dots become small squares, shades get opacity, text is escaped', () => {
  const g = new Grid(4, 1)
  g.set(0, 0, 0x2801, 0xffffff)
  g.set(1, 0, 0x2591, 0x00ff00)
  g.text(2, 0, 'A<', 0xeeeeee)
  const svg = gridToSvg(g, 'a & b')!
  assert.ok(svg.includes('M1 1h2v2h-2z'))
  assert.ok(svg.includes('fill-opacity="0.25"'))
  assert.ok(svg.includes('x="16 24"'))
  assert.ok(svg.includes('>A&lt;</text>'))
  assert.ok(svg.includes('<title>a &amp; b</title>'))
})

test('the terminal default background is left transparent, and an oversize document is refused', () => {
  const g = new Grid(2, 1, DEFAULT)
  g.set(0, 0, 0x41, 0xffffff)
  assert.ok(!gridToSvg(g, 'x')!.includes('<path'))
  assert.equal(gridToSvg(g, 'x', 10), null)
})

test('block shapes and escaping', () => {
  assert.deepEqual(blockShape(0x2588), [0, 0, 1, 1, 1])
  assert.deepEqual(blockShape(0x2584), [0, 0.5, 1, 0.5, 1])
  assert.deepEqual(blockShape(0x258c), [0, 0, 0.5, 1, 1])
  assert.equal(blockShape(0x41), null)
  assert.equal(escapeXml('<a href="x">\'&</a>\u0001'), '&lt;a href=&quot;x&quot;&gt;&apos;&amp;&lt;/a&gt;')
})
