import { test } from 'node:test'
import assert from 'node:assert/strict'
import { add, clamp01, contrast, desaturate, hex, mix, quantise, rgb, scale } from '../../src/render/color.ts'

test('mix blends channel by channel and clamps t', () => {
  assert.equal(mix(0x000000, 0xffffff, 0.5), 0x808080)
  assert.equal(mix(0x123456, 0xabcdef, 0), 0x123456)
  assert.equal(mix(0x123456, 0xabcdef, 1), 0xabcdef)
  assert.equal(mix(0x000000, 0xff0000, 2), 0xff0000)
})

test('scale, add and desaturate', () => {
  assert.equal(scale(0x808080, 0.5), 0x404040)
  assert.equal(add(0x101010, 0xffffff, 1), 0xffffff)
  assert.equal(add(0x101010, 0x204060, 0.5), 0x203040)
  assert.equal(desaturate(0xff0000, 1), 0x4c4c4c)
  assert.equal(rgb(300, -5, 127.6), 0xff0080)
})

test('hex, contrast, quantise and clamp01', () => {
  assert.equal(hex(0x0b0f17), '#0b0f17')
  assert.ok(Math.abs(contrast(0xffffff, 0x000000) - 21) < 0.01)
  assert.equal(contrast(0x000000, 0xffffff), contrast(0xffffff, 0x000000))
  assert.equal(quantise(0.49, 3), 0.5)
  assert.equal(quantise(0.2, 3), 0)
  assert.equal(clamp01(Number.NaN), 0)
  assert.equal(clamp01(7), 1)
})

test('quantise copes with odd step counts', () => {
  assert.equal(quantise(0.4, Number.NaN), 0.4)
  assert.equal(quantise(0.4, 1.9), 0.4)
  assert.equal(quantise(0.9, 2.9), 1)
  assert.equal(quantise(0.4, Number.POSITIVE_INFINITY), 0.4)
})
