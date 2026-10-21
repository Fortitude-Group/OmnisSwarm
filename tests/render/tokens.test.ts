import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contrast } from '../../src/render/color.ts'
import { safeGlyph } from '../../src/render/grid.ts'
import {
  CANVAS, FEED_COLOR, FEED_MARK, GLYPH, KIND, MODEL, MOTION, PAIR_BUDGET, PULL_MS, STATUS, TEXT, contextColor, modelColor,
  modelFamily, statusGlyph,
} from '../../src/render/tokens.ts'

test('text tokens read at 4.5:1 on the canvas, and every signal colour at 3:1', () => {
  for (const c of [TEXT.primary, TEXT.dim]) assert.ok(contrast(c, CANVAS) >= 4.5, c.toString(16))
  for (const c of [...Object.values(MODEL), ...Object.values(STATUS), ...Object.values(KIND), ...Object.values(FEED_COLOR)]) {
    assert.ok(contrast(c, CANVAS) >= 3, c.toString(16))
  }
})

test('every glyph is one code point the Raster accepts', () => {
  for (const g of [...Object.values(GLYPH), ...Object.values(FEED_MARK)]) {
    assert.equal([...g].length, 1, g)
    assert.equal(safeGlyph(g.codePointAt(0)!), g.codePointAt(0), g)
  }
})

test('model families and colours', () => {
  assert.equal(modelFamily('claude-opus-5-5'), 'opus')
  assert.equal(modelFamily('claude-sonnet-4-6'), 'sonnet')
  assert.equal(modelFamily('claude-haiku-5-5'), 'haiku')
  assert.equal(modelFamily('claude-fable-5-1'), 'fable')
  assert.equal(modelFamily('claude-mythos-5-1'), 'fable')
  assert.equal(modelFamily('gpt-x'), 'other')
  assert.equal(modelFamily(null), 'other')
  assert.equal(modelColor('claude-opus-5-5'), MODEL.opus)
})

test('status glyphs, context colours, timings and budgets', () => {
  assert.equal(statusGlyph('running'), GLYPH.running)
  assert.equal(statusGlyph('failed'), GLYPH.failed)
  assert.equal(statusGlyph('waiting', true), GLYPH.unknown)
  assert.equal(contextColor(0.95), STATUS.failed)
  assert.equal(contextColor(0.75), STATUS.warn)
  assert.equal(contextColor(0.3), TEXT.dim)
  for (const v of Object.values(MOTION)) assert.ok(v > 0)
  assert.ok(PULL_MS >= 250, 'at most 4 pulls a second')
  assert.ok(PAIR_BUDGET.top + PAIR_BUDGET.bottom <= 1024 || (PAIR_BUDGET.top <= 1024 && PAIR_BUDGET.bottom <= 1024))
})
