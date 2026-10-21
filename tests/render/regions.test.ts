import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planRegions, sizeStep } from '../../src/render/regions.ts'
import { rect } from '../../src/render/types.ts'

test('size steps drop the timeline, then the spotlight, then the graph, then everything but a line', () => {
  assert.equal(sizeStep({ columns: 120, rows: 44 }), 'full')
  assert.equal(sizeStep({ columns: 100, rows: 29 }), 'noTimeline')
  assert.equal(sizeStep({ columns: 80, rows: 21 }), 'compactSpotlight')
  assert.equal(sizeStep({ columns: 60, rows: 13 }), 'tree')
  assert.equal(sizeStep({ columns: 47, rows: 30 }), 'tree')
  assert.equal(sizeStep({ columns: 40, rows: 5 }), 'summary')
  assert.equal(sizeStep({ columns: 29, rows: 40 }), 'summary')
})

test('full: header, graph, chips, spotlight, timeline and feed fill the pane exactly', () => {
  const r = planRegions({ columns: 120, rows: 44 }, 6)
  assert.equal(r.step, 'full')
  assert.deepEqual(r.top, { columns: 120, rows: 26 })
  assert.deepEqual(r.bottom, { columns: 120, rows: 17 })
  assert.deepEqual(r.header, rect(0, 0, 120, 2))
  assert.deepEqual(r.graph, rect(0, 2, 120, 24))
  assert.deepEqual(r.spotlight, rect(0, 0, 120, 6))
  assert.deepEqual(r.timeline, rect(0, 6, 120, 7))
  assert.deepEqual(r.feed, rect(0, 13, 120, 4))
  assert.equal(r.chips, true)
  assert.equal(r.top.rows + 1 + r.bottom!.rows, 44)
})

test('no timeline and compact spotlight', () => {
  const a = planRegions({ columns: 100, rows: 29 }, 6)
  assert.deepEqual([a.top.rows, a.bottom!.rows, a.timeline, a.feed], [18, 10, null, rect(0, 6, 100, 4)])
  const b = planRegions({ columns: 80, rows: 21 }, 6)
  assert.deepEqual([b.top.rows, b.bottom!.rows, b.spotlight, b.feed], [14, 6, rect(0, 0, 80, 1), rect(0, 1, 80, 5)])
})

test('tree and summary have no chips and no bottom grid', () => {
  const t = planRegions({ columns: 60, rows: 13 }, 6)
  assert.deepEqual([t.top, t.tree, t.bottom, t.chips, t.graph], [{ columns: 60, rows: 13 }, rect(0, 1, 60, 12), null, false, null])
  const s = planRegions({ columns: 40, rows: 5 }, 6)
  assert.deepEqual([s.top, s.header, s.bottom, s.chips], [{ columns: 40, rows: 1 }, rect(0, 0, 40, 1), null, false])
})

test('a huge pane is held to the Raster limits', () => {
  const r = planRegions({ columns: 600, rows: 600 }, 3)
  assert.equal(r.top.columns, 512)
  assert.equal(r.top.rows, 256)
  assert.equal(r.bottom!.rows, 256)
  assert.equal(r.graph!.h, 254)
})
