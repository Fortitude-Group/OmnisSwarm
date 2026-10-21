import { test } from 'node:test'
import assert from 'node:assert/strict'
import { costOf, priceFor } from '../../src/core/prices.ts'

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }
const near = (a: number | null, b: number) => assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`)

test('priceFor matches exact ids, dated ids and nothing else', () => {
  assert.equal(priceFor('claude-opus-5-5')?.input, 4)
  assert.equal(priceFor('claude-haiku-4-5-20251001')?.contextWindow, 200_000)
  assert.equal(priceFor('claude-opus-5-5-20270101')?.input, 4)
  assert.equal(priceFor('claude-opus-5')?.input, 5)
  assert.equal(priceFor('gpt-something'), null)
})

test('costOf prices each token class', () => {
  near(costOf('claude-opus-5-5', { ...zero, input: 1_000_000 }), 4)
  near(costOf('claude-opus-5-5', { ...zero, output: 1_000_000 }), 20)
  near(costOf('claude-opus-5-5', { ...zero, cacheRead: 1_000_000 }), 0.2)
  near(costOf('claude-opus-5-5', { ...zero, cacheWrite5m: 1_000_000 }), 5)
  near(costOf('claude-opus-5-5', { ...zero, cacheWrite1h: 1_000_000 }), 8)
  near(costOf('claude-fable-5-1', { ...zero, cacheRead: 1_000_000 }), 0.25)
})

test('costOf switches Haiku 5.5 to its long-context rate above 100K prompt tokens', () => {
  near(costOf('claude-haiku-5-5', { ...zero, input: 50_000 }), 0.005)
  near(costOf('claude-haiku-5-5', { ...zero, input: 200_000 }), 0.1)
})

test('costOf returns null for an unknown model', () => {
  assert.equal(costOf('mystery-model', { ...zero, input: 10 }), null)
})

test('priceFor does not price new model versions as an older one', () => {
  assert.equal(priceFor('claude-opus-5-1'), null)
  assert.equal(priceFor('claude-sonnet-5-7'), null)
  assert.equal(priceFor('claude-opus-5-5-2027'), null)
})
