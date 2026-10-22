import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lzwEncode } from '../../src/gif/lzw.ts'
import { lzwDecode } from './decode.ts'

const roundTrip = (data: Uint8Array) => assert.deepEqual(lzwDecode(lzwEncode(data), 8, data.length), data)

test('LZW round-trips short, repetitive, random and dictionary-filling input', () => {
  roundTrip(Uint8Array.from([7]))
  roundTrip(new Uint8Array(10_000).fill(3))
  roundTrip(Uint8Array.from({ length: 5000 }, (_, i) => i % 7))
  let seed = 1
  roundTrip(Uint8Array.from({ length: 200_000 }, () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 16) & 255))
})

test('a flat run compresses well', () => {
  assert.ok(lzwEncode(new Uint8Array(100_000)).length < 2_000)
})
