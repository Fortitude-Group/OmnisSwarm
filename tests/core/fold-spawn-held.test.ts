import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldAll, LEAD, MAX_HOLDS } from '../../src/core/fold.ts'
import { reportMarkdown } from '../../src/core/report.ts'
import { isSwarmState } from '../../src/core/state-check.ts'
import { at, ev } from '../helpers.ts'

const held = (data: Record<string, unknown>, atSec: number) => ev('spawn.held', data as never, { atSec })
const roundTrip = (s: unknown) => JSON.parse(JSON.stringify(s))

test('a start and an end each add a feed line, and the end is kept for the report', () => {
  const s = foldAll('s1', [
    held({ role: 'Explore', phase: 'start', count: 1, ms: 0 }, 1),
    held({ role: 'Explore', phase: 'end', count: 3, ms: 41_200, why: 'answered' }, 42),
    held({ role: 'Plan', phase: 'end', count: 1, ms: 240_000, why: 'timeout' }, 300),
    held({ role: 'reviewer', phase: 'end', count: 2, ms: 12_400, why: 'failed' }, 400),
  ])
  assert.deepEqual(s.feed.map(f => [f.agent, f.text]), [
    [LEAD, 'holding Explore agents until the first one answers'],
    [LEAD, 'held 3 Explore agents 41 s for the first to answer'],
    [LEAD, 'held 1 Plan agent 240 s, let go at the 4 min limit'],
    [LEAD, 'held 2 reviewer agents 12 s, let go when the first stopped without answering'],
  ])
  assert.deepEqual(s.holds, [
    { role: 'Explore', count: 3, ms: 41_200, why: 'answered', at: at(42) },
    { role: 'Plan', count: 1, ms: 240_000, why: 'timeout', at: at(300) },
    { role: 'reviewer', count: 2, ms: 12_400, why: 'failed', at: at(400) },
  ])
  assert.equal(isSwarmState(roundTrip(s), 's1'), true)
  const report = reportMarkdown(s, at(500), 0)
  assert.match(report, /## Cache holds\n\n- Held 3 Explore agents 41 s for the first to answer\.\n- Held 1 Plan agent 240 s, let go at the 4 min limit\.\n- Held 2 reviewer agents 12 s, let go when the first stopped without answering\.\n/)
})

test('a bad spawn.held is skipped, holds are capped, and no holds means no report section', () => {
  const s = foldAll('s1', [
    held({ role: '', phase: 'end', count: 1, ms: 1, why: 'answered' }, 1),
    held({ role: 'Explore', phase: 'end', count: 1, ms: 1, why: 'maybe' }, 2),
    held({ role: 'Explore', phase: 'later', count: 1, ms: 1 }, 3),
  ])
  assert.equal(s.holds, undefined)
  assert.deepEqual(s.feed, [])
  assert.doesNotMatch(reportMarkdown(s, at(10), 0), /Cache holds/)
  const many = foldAll('s1', Array.from({ length: MAX_HOLDS + 5 }, (_, i) => held({ role: 'Explore', phase: 'end', count: 1, ms: i * 1000, why: 'answered' }, i + 1)))
  assert.equal(many.holds!.length, MAX_HOLDS)
  assert.equal(many.holds![0]!.ms, 5000)
})

test('the state check refuses a planted hold of the wrong shape', () => {
  const s = roundTrip(foldAll('s1', [held({ role: 'Explore', phase: 'end', count: 1, ms: 1, why: 'answered' }, 1)]))
  assert.equal(isSwarmState(s, 's1'), true)
  assert.equal(isSwarmState({ ...s, holds: [{ ...s.holds[0], why: 'because' }] }, 's1'), false)
  assert.equal(isSwarmState({ ...s, holds: [{ ...s.holds[0], extra: 1 }] }, 's1'), false)
  assert.equal(isSwarmState({ ...s, holds: 'none' }, 's1'), false)
})
