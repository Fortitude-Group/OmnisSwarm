import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hintLines, hintStats, hintsText, tierOf } from '../../src/core/hints.ts'
import type { HistoryRow } from '../../src/core/history.ts'

let n = 0
const row = (role: string, model: string, clean: boolean, costUsd = 1, minutes = 5): HistoryRow =>
  ({ v: 1, id: `s/a${n++}`, role, model, clean, costUsd, minutes, at: '2026-10-25T10:00:00.000Z', project: '0123456789abcdef' })
/** `cleanCount` clean rows then the rest not clean, `runCount` in all. */
const runs = (role: string, model: string, runCount: number, cleanCount: number, costUsd = 1): HistoryRow[] =>
  Array.from({ length: runCount }, (_, i) => row(role, model, i < cleanCount, costUsd))
const H = 'claude-haiku-5-5', S = 'claude-sonnet-5-5', O = 'claude-opus-5-5'

test('tierOf reads haiku, sonnet and opus from the model id, and nothing else', () => {
  assert.equal(tierOf(H), 1)
  assert.equal(tierOf('Claude-Sonnet-4-6'), 2)
  assert.equal(tierOf(O), 3)
  assert.equal(tierOf('gpt-5'), null)
})

test('a cheaper tier within 10 points gets a try line with both records and average costs', () => {
  const lines = hintLines([...runs('dev', S, 8, 7, 0.41), ...runs('dev', O, 10, 9, 1.8)], [])
  assert.deepEqual(lines, ["dev: Sonnet finished clean 7 of 8 (≈$0.41 avg) vs Opus 9 of 10 (≈$1.80). Try model: 'sonnet'."])
})

test('exactly 10 points below still counts as cheaper; 11 does not', () => {
  assert.equal(hintLines([...runs('dev', S, 5, 4), ...runs('dev', O, 10, 9)], []).length, 1)
  assert.deepEqual(hintLines([...runs('dev', S, 100, 79), ...runs('dev', O, 10, 9)], []), [])
})

test('the cheapest tier that qualifies is the one hinted', () => {
  const lines = hintLines([...runs('dev', H, 5, 5), ...runs('dev', S, 5, 5), ...runs('dev', O, 5, 5)], [])
  assert.match(lines[0]!, /^dev: Haiku .* vs Opus .*Try model: 'haiku'\.$/)
})

test('25 or more points below gives a keep line; 24 gives nothing', () => {
  assert.deepEqual(hintLines([...runs('sec', H, 5, 3), ...runs('sec', S, 20, 17)], []), ['sec: Haiku finished clean 3 of 5 vs Sonnet 17 of 20. Keep it on Sonnet.'])
  assert.deepEqual(hintLines([...runs('sec', H, 25, 15), ...runs('sec', S, 25, 21)], []), [])
})

test('fewer than 5 runs on a tier, or one tier only, gives no hint', () => {
  assert.deepEqual(hintLines([...runs('dev', S, 4, 4), ...runs('dev', O, 10, 10)], []), [])
  assert.deepEqual(hintLines(runs('dev', O, 50, 50), []), [])
})

test('a role short of evidence in the project falls back to machine rows, labelled', () => {
  const machine = [...runs('dev', S, 6, 6, 0.5), ...runs('dev', O, 6, 6, 2)]
  assert.deepEqual(hintLines(runs('dev', O, 3, 3), machine), ["dev: Sonnet finished clean 6 of 6 (≈$0.50 avg) vs Opus 6 of 6 (≈$2.00). Try model: 'sonnet' (across projects)."])
  assert.deepEqual(hintLines([...runs('sec', H, 6, 1), ...runs('sec', S, 6, 6)], []), ['sec: Haiku finished clean 1 of 6 vs Sonnet 6 of 6. Keep it on Sonnet.'])
  assert.deepEqual(hintLines([], [...runs('sec', H, 6, 1), ...runs('sec', S, 6, 6)]), ['sec: Haiku finished clean 1 of 6 vs Sonnet 6 of 6. Keep it on Sonnet (across projects).'])
})

test('project rows win when they qualify, even when machine rows disagree', () => {
  const project = [...runs('dev', S, 5, 5), ...runs('dev', O, 5, 5)]
  const machine = [...runs('dev', S, 50, 0), ...runs('dev', O, 50, 50)]
  assert.match(hintLines(project, machine)[0]!, /Try model: 'sonnet'\.$/)
})

test('at most 5 lines, largest sample first, then by role', () => {
  const rows = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].flatMap((role, i) => [...runs(role, S, 5 + i, 5 + i), ...runs(role, O, 5, 5)])
  const lines = hintLines(rows, [])
  assert.equal(lines.length, 5)
  assert.deepEqual(lines.map(l => l.split(':')[0]), ['g', 'f', 'e', 'd', 'c'])
  const tie = hintLines([...runs('b', S, 5, 5), ...runs('b', O, 5, 5), ...runs('a', S, 5, 5), ...runs('a', O, 5, 5)], [])
  assert.deepEqual(tie.map(l => l.split(':')[0]), ['a', 'b'])
})

test('rows with an unknown model are left out of tiering', () => {
  assert.deepEqual(hintLines([...runs('dev', 'gpt-5', 10, 10), ...runs('dev', O, 10, 10)], []), [])
})

test('hintStats averages cost and minutes per role and tier from the chosen source', () => {
  const stats = hintStats([row('dev', S, true, 1, 4), row('dev', S, false, 2, 8)], [])
  assert.deepEqual(stats, [{ role: 'dev', tier: 2, runs: 2, clean: 1, avgUsd: 1.5, avgMin: 6, source: 'project' }])
})

test('hintsText says so when there is no history, and lists the table and hints when there is', () => {
  assert.equal(hintsText([], []), 'No run history yet. Hints appear once a role has 5 or more finished runs on each of two models.')
  const text = hintsText([...runs('dev', S, 8, 7, 0.41), ...runs('dev', O, 10, 9, 1.8)], [])
  assert.match(text, /^Model history \(role · model · runs · clean · avg cost · avg minutes · source\):\n- dev · Sonnet · 8 · 7 · ≈\$0\.41 · 5 · project\n- dev · Opus · 10 · 9 · ≈\$1\.80 · 5 · project\n\nHints:\n- dev: Sonnet/)
  assert.match(hintsText(runs('dev', O, 3, 3), []), /\n\nNo hints yet: no role has 5 or more runs on each of two models\.$/)
})
