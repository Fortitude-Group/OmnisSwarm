import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clip, isOneOf, isSafeKey, LIMITS, makeEvent, parseLine, SCHEMA_VERSION, serialise, TOPOLOGIES } from '../../src/core/events.ts'

const now = new Date('2026-10-21T10:00:00.000Z')
const message = () => makeEvent({ type: 'message.sent', swarm: 's1', src: 'recorder', agent: 'a1', data: { to: 'tester', summary: 'hi' }, now })

test('clip flattens whitespace and cuts long text with an ellipsis', () => {
  assert.equal(clip('  a\n  b  ', 10), 'a b')
  assert.equal(clip('abcdefghij', 5), 'abcd…')
  assert.equal(clip('abcde', 5), 'abcde')
})

test('makeEvent fills the envelope', () => {
  assert.deepEqual(message(), {
    v: SCHEMA_VERSION, ts: '2026-10-21T10:00:00.000Z', swarm: 's1', src: 'recorder',
    type: 'message.sent', agent: 'a1', data: { to: 'tester', summary: 'hi' },
  })
})

test('makeEvent leaves agent out when none is given', () => {
  const e = makeEvent({ type: 'swarm.ended', swarm: 's1', src: 'mcp', data: {}, now })
  assert.equal('agent' in e, false)
})

test('serialise ends in a newline and round-trips through parseLine', () => {
  const line = serialise(message())
  assert.ok(line.endsWith('\n'))
  const parsed = parseLine(line.trim())
  assert.ok(parsed.ok)
  if (parsed.ok) assert.deepEqual(parsed.event, message())
})

test('serialise refuses a line over the byte limit', () => {
  const big = makeEvent({ type: 'message.sent', swarm: 's1', src: 'recorder', data: { to: 'b', summary: 'x'.repeat(LIMITS.line) }, now })
  assert.throws(() => serialise(big), RangeError)
})

test('parseLine rejects bad JSON, bad shapes and newer versions', () => {
  const good = JSON.parse(serialise(message())) as Record<string, unknown>
  assert.deepEqual(parseLine('{nope'), { ok: false, reason: 'json' })
  assert.deepEqual(parseLine('[]'), { ok: false, reason: 'shape' })
  assert.deepEqual(parseLine(JSON.stringify({ ...good, v: SCHEMA_VERSION + 1 })), { ok: false, reason: 'version' })
  assert.deepEqual(parseLine(JSON.stringify({ ...good, type: 'nope' })), { ok: false, reason: 'shape' })
  assert.deepEqual(parseLine(JSON.stringify({ ...good, src: 'nope' })), { ok: false, reason: 'shape' })
  assert.deepEqual(parseLine(JSON.stringify({ ...good, ts: 'not a date' })), { ok: false, reason: 'shape' })
  assert.deepEqual(parseLine(JSON.stringify({ ...good, data: null })), { ok: false, reason: 'shape' })
  assert.deepEqual(parseLine(JSON.stringify({ ...good, agent: 7 })), { ok: false, reason: 'shape' })
})

test('isSafeKey blocks prototype keys and the empty string', () => {
  assert.equal(isSafeKey('design/auth'), true)
  for (const k of ['__proto__', 'constructor', 'prototype', '']) assert.equal(isSafeKey(k), false)
})

test('isOneOf narrows to a known value', () => {
  assert.equal(isOneOf(TOPOLOGIES, 'mesh'), true)
  assert.equal(isOneOf(TOPOLOGIES, 'ring'), false)
  assert.equal(isOneOf(TOPOLOGIES, 3), false)
})

test('parseLine rejects an invalid swarm id and an over-long agent name', () => {
  const ok = JSON.parse(serialise(message()))
  assert.equal(parseLine(JSON.stringify(ok)).ok, true)
  for (const swarm of ['../x', 'Auth', 'nul', '']) {
    assert.deepEqual(parseLine(JSON.stringify({ ...ok, swarm })), { ok: false, reason: 'shape' }, swarm)
  }
  assert.deepEqual(parseLine(JSON.stringify({ ...ok, agent: 'a'.repeat(65) })), { ok: false, reason: 'shape' })
  assert.equal(parseLine(JSON.stringify({ ...ok, agent: 'a'.repeat(64) })).ok, true)
})

const withSummary = (summary: string) => makeEvent({ type: 'message.sent', swarm: 's1', src: 'recorder', data: { to: 'b', summary }, now })
const byteLen = (s: string) => new TextEncoder().encode(s).length

test('serialise accepts a line of exactly the limit and rejects one byte more', () => {
  const base = byteLen(serialise(withSummary('')))
  const exact = serialise(withSummary('x'.repeat(LIMITS.line - base)))
  assert.equal(byteLen(exact), LIMITS.line)
  assert.throws(() => serialise(withSummary('x'.repeat(LIMITS.line - base + 1))), RangeError)
})

test('serialise counts a multi-byte character as its UTF-8 byte length', () => {
  const base = byteLen(serialise(withSummary('')))
  // 'é' is 2 bytes: half the room in 'é' fills the limit exactly, one more 'é' overshoots by 2
  const room = LIMITS.line - base
  const fits = serialise(withSummary('é'.repeat(room / 2) + (room % 2 ? 'x' : '')))
  assert.equal(byteLen(fits), LIMITS.line)
  assert.throws(() => serialise(withSummary('é'.repeat(Math.floor(room / 2) + 1))), RangeError)
})
