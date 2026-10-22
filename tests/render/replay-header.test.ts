// tests/render/replay-header.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldAll } from '../../src/core/fold.ts'
import { render } from '../../src/render/frame.ts'
import { gridText } from '../../src/render/grid.ts'
import { emptyView } from '../../src/render/types.ts'
import { fmtClock } from '../../src/render/header.ts'
import { REPLAY } from '../../src/render/tokens.ts'
import { fiveAgentEvents, FIVE_SWARM, FIVE_AT } from '../fixtures/swarm-five.ts'

const state = foldAll(FIVE_SWARM, fiveAgentEvents())

const replay = (over: Partial<{ speed: number; clockMs: number; totalMs: number; ended: boolean }> = {}) =>
  ({ replay: { speed: 10, clockMs: 192_000, totalMs: 520_000, ended: false, ...over } })

test('row 0 starts with the badge and the swarm clock', () => {
  const f = render(state, emptyView(), FIVE_AT.mid, { columns: 120, rows: 44 }, replay())
  assert.match(gridText(f.top)[0]!, /^ REPLAY 10× {2}03:12 \/ 08:40 {2}◆ /)
})

test('at the end the clock says end and row 1 offers the stop command', () => {
  const f = render(state, emptyView(), FIVE_AT.mid, { columns: 120, rows: 44 }, replay({ clockMs: 520_000, ended: true }))
  const rows = gridText(f.top)
  assert.match(rows[0]!, /08:40 \/ 08:40 end/)
  assert.match(rows[1]!, /\/omnis replay stop/)
})

test('both header rows are painted REPLAY.raised', () => {
  const f = render(state, emptyView(), FIVE_AT.mid, { columns: 120, rows: 44 }, replay())
  assert.equal(f.top.bg(60, 0), REPLAY.raised)
  assert.equal(f.top.bg(60, 1), REPLAY.raised)
  assert.equal(f.top.bg(1, 0), REPLAY.badge.bg)
})

test('the clock reads h:mm:ss past an hour', () => {
  assert.equal(fmtClock(192_000), '03:12')
  assert.equal(fmtClock(3_792_000), '1:03:12')
})

test('without a replay the header is unchanged', () => {
  const plain = render(state, emptyView(), FIVE_AT.mid, { columns: 120, rows: 44 })
  assert.doesNotMatch(gridText(plain.top)[0]!, /REPLAY/)
})

// pane.md 13.7: the badge shows at every size step, the 1-row header and the summary line included.
for (const [step, size] of [
  ['full', { columns: 120, rows: 44 }],
  ['noTimeline', { columns: 100, rows: 29 }],
  ['compactSpotlight', { columns: 80, rows: 21 }],
  ['tree', { columns: 60, rows: 13 }],
  ['summary', { columns: 40, rows: 5 }],
] as const) {
  test(`the badge shows at the ${step} step, on the raised tint`, () => {
    const f = render(state, emptyView(), FIVE_AT.mid, size, replay())
    assert.equal(f.step, step)
    assert.match(gridText(f.top)[0]!, /^ REPLAY 10× /)
    assert.equal(f.top.bg(1, 0), REPLAY.badge.bg)
    assert.equal(f.top.bg(size.columns - 1, 0), REPLAY.raised)
  })
}

test('the 1-row header and summary line keep the clock when it fits whole', () => {
  const tree = render(state, emptyView(), FIVE_AT.mid, { columns: 60, rows: 13 }, replay())
  assert.match(gridText(tree.top)[0]!, /^ REPLAY 10× {2}03:12 \/ 08:40 /)
  const line = render(state, emptyView(), FIVE_AT.mid, { columns: 40, rows: 5 }, replay())
  assert.match(gridText(line.top)[0]!, /^ REPLAY 10× {2}03:12 \/ 08:40 /)
  const narrow = render(state, emptyView(), FIVE_AT.mid, { columns: 30, rows: 5 }, replay())
  assert.match(gridText(narrow.top)[0]!, /^ REPLAY 10× /)
})
