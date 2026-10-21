import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

test('every value in the design doc Tokens table matches tokens.ts', async () => {
  const T = (await import('../../src/render/tokens.ts')) as unknown as Record<string, unknown>
  const doc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'design', 'pane.md'), 'utf8')
  const section = doc.slice(doc.indexOf('## 3. Tokens'), doc.indexOf('**Changes from'))
  const lookup = (path: string): unknown => path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], T)
  let checked = 0
  for (const line of section.split('\n')) {
    const cols = line.split('|').map(c => c.trim())
    if (cols.length < 4 || !cols[1]!.startsWith('`')) continue
    const names = [...cols[1]!.matchAll(/`([^`]+)`/g)].map(m => m[1]!)
    const values = cols[2]!.replace(/\*\*/g, '').replace(/\s*\(new\)/, '').split(' / ').map(v => v.replace(/`/g, '').trim())
    assert.equal(names.length, values.length, line)
    const prefix = names[0]!.includes('.') ? names[0]!.slice(0, names[0]!.indexOf('.')) : ''
    names.forEach((raw, i) => {
      const path = raw.startsWith('.') ? prefix + raw : raw.includes('.') || !prefix || raw === names[0] ? raw : `${prefix}.${raw}`
      const v = values[i]!
      const actual = lookup(path)
      const expected: unknown = /^#[0-9a-f]{6}$/i.test(v) ? parseInt(v.slice(1), 16) : v.startsWith('[') ? JSON.parse(v) : /^[\d.]+$/.test(v) ? Number(v) : v
      assert.deepEqual(actual, expected, `${path} should be ${v}`)
      checked++
    })
  }
  assert.ok(checked >= 80, `checked ${checked} tokens`)
})
