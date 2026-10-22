import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fitSpeed, logTimeAt, replayOffsets, retime } from '../../src/core/replay-clock.ts'
import { LEAD } from '../../src/core/fold.ts'
import { at, ev } from '../helpers.ts'

test('offsets divide gaps by the speed and cut quiet ones to 2 s', () => {
  assert.deepEqual(replayOffsets([0, 1_000, 61_000, 62_000], 10), [0, 100, 2_100, 2_200])
  assert.deepEqual(replayOffsets([0, 1_000, 61_000], 1), [0, 1_000, 3_000])
  assert.deepEqual(replayOffsets([], 10), [])
  assert.deepEqual(replayOffsets([5_000, 4_000], 10), [0, 0])
})

test('retime sorts, rewrites timestamps onto the replay clock and keeps the log times', () => {
  const a = ev('agent.started', { name: 'a', role: 'r', description: '', parent: LEAD }, { agent: 'a1', atSec: 10 })
  const b = ev('agent.finished', { outcome: 'answer' }, { agent: 'a1', atSec: 70 })
  const out = retime([b, a], 10, 1_000_000)
  assert.deepEqual(out.events.map(e => e.type), ['agent.started', 'agent.finished'])
  assert.deepEqual(out.events.map(e => Date.parse(e.ts)), [1_000_000, 1_002_000])
  assert.deepEqual(out.logTs, [at(10), at(70)])
  assert.equal(out.events[0]!.swarm, a.swarm)
})

test('the log time at a replay offset is interpolated, cut gaps included', () => {
  const logTs = [0, 1_000, 61_000]
  const offsets = replayOffsets(logTs, 10)
  assert.equal(logTimeAt(logTs, offsets, 50), 500)
  assert.equal(logTimeAt(logTs, offsets, 1_100), 31_000)
  assert.equal(logTimeAt(logTs, offsets, 99_999), 61_000)
  assert.equal(logTimeAt(logTs, offsets, -5), 0)
})

test('fitSpeed finds the slowest speed whose replay fits', () => {
  const ts = Array.from({ length: 600 }, (_, i) => i * 1_000)
  const s = fitSpeed(ts, 27_000, 0.25)
  const end = (sp: number) => replayOffsets(ts, sp).at(-1)!
  assert.ok(end(s) <= 27_000)
  assert.ok(end(s * 0.99) > 27_000)
  assert.equal(fitSpeed([0, 1_000], 27_000, 0.25), 0.25)
})
