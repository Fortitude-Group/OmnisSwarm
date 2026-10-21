import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clipText, fmtAge, fmtDuration, fmtPercent, fmtTokens, fmtUsd } from '../../src/render/format.ts'

test('fmtTokens', () => {
  assert.equal(fmtTokens(0), '0')
  assert.equal(fmtTokens(950), '950')
  assert.equal(fmtTokens(1234), '1.2k')
  assert.equal(fmtTokens(34_000), '34k')
  assert.equal(fmtTokens(1_200_000), '1.2M')
  assert.equal(fmtTokens(34_000_000), '34M')
  assert.equal(fmtTokens(Number.NaN), '0')
})

test('fmtUsd is always approximate and shows unknown as a dash', () => {
  assert.equal(fmtUsd(null), '–')
  assert.equal(fmtUsd(0.0042), '≈$0.004')
  assert.equal(fmtUsd(1.234), '≈$1.23')
  assert.equal(fmtUsd(250.4), '≈$250')
})

test('fmtDuration, fmtAge and fmtPercent', () => {
  assert.equal(fmtDuration(45_000), '45s')
  assert.equal(fmtDuration(185_000), '3m05s')
  assert.equal(fmtDuration(3_720_000), '1h02m')
  assert.equal(fmtAge(500), '0s')
  assert.equal(fmtAge(12_000), '12s')
  assert.equal(fmtAge(120_000), '2m')
  assert.equal(fmtAge(7_200_000), '2h')
  assert.equal(fmtPercent(null), '–')
  assert.equal(fmtPercent(0.344), '34%')
})

test('clipText cuts by code point and ends in an ellipsis', () => {
  assert.equal(clipText('abcdef', 4), 'abc…')
  assert.equal(clipText('ab', 4), 'ab')
  assert.equal(clipText('abc', 0), '')
  assert.equal(clipText('😀😀😀', 2), '😀…')
})

test('units are chosen after rounding, and bad numbers never print as numbers', () => {
  assert.equal(fmtTokens(9999), '10k')
  assert.equal(fmtTokens(999_999), '1.0M')
  assert.equal(fmtTokens(999_499), '999k')
  assert.equal(fmtUsd(99.999), '≈$100')
  assert.equal(fmtUsd(0.00999), '≈$0.01')
  assert.equal(fmtUsd(-1), '–')
  assert.equal(fmtDuration(Number.NaN), '–')
  assert.equal(fmtDuration(Number.POSITIVE_INFINITY), '–')
  assert.equal(fmtAge(Number.NaN), '–')
  assert.equal(clipText('abc', Number.NaN), '')
  assert.equal(clipText('abc', Number.POSITIVE_INFINITY), '')
})
