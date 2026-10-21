import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldAll } from '../../src/core/fold.ts'
import { agentStats } from '../../src/core/stats.ts'
import { Grid, gridText } from '../../src/render/grid.ts'
import { busiest, chooseSpotlight, drawSpotlight, sparkline } from '../../src/render/spotlight.ts'
import { CANVAS, MODEL, STATUS, TEXT, SPOTLIGHT_HOLD_MS } from '../../src/render/tokens.ts'
import { rect, type Pulse } from '../../src/render/types.ts'
import { FIVE_AT, FIVE_SWARM, fiveAgentEvents } from '../fixtures/swarm-five.ts'

const state = () => foldAll(FIVE_SWARM, fiveAgentEvents())
const mid = FIVE_AT.mid

test('busiest is the agent with the most recent output, and pulses count', () => {
  const s = state()
  assert.equal(busiest(s, [], mid), 'a-cod1')
  const pulses: Pulse[] = Array.from({ length: 100 }, () => ({ agent: 'a-test', kind: 'bash', at: mid - 1000, isError: false }))
  assert.equal(busiest(s, pulses, mid), 'a-test')
  assert.equal(busiest(foldAll('s1', []), [], mid), null)
})

test('the spotlight holds an agent for the hold time, then follows the busiest', () => {
  const s = state()
  const held = { id: 'a-arch', since: mid - (SPOTLIGHT_HOLD_MS - 1) }
  assert.equal(chooseSpotlight(held, null, s, [], mid), held)
  assert.deepEqual(chooseSpotlight({ id: 'a-arch', since: mid - SPOTLIGHT_HOLD_MS }, null, s, [], mid), { id: 'a-cod1', since: mid })
  const same = { id: 'a-cod1', since: mid - 99_999 }
  assert.equal(chooseSpotlight(same, null, s, [], mid), same)
  assert.deepEqual(chooseSpotlight({ id: 'gone', since: mid }, null, s, [], mid), { id: 'a-cod1', since: mid })
  assert.deepEqual(chooseSpotlight(null, null, s, [], mid), { id: 'a-cod1', since: mid })
})

test('a pin always wins; an unknown or placeholder pin is ignored', () => {
  const s = state()
  assert.deepEqual(chooseSpotlight(null, 'a-test', s, [], mid), { id: 'a-test', since: mid })
  const pinned = { id: 'a-test', since: 5 }
  assert.equal(chooseSpotlight(pinned, 'a-test', s, [], mid), pinned)
  assert.deepEqual(chooseSpotlight(null, 'zzz', s, [], mid), { id: 'a-cod1', since: mid })
  assert.deepEqual(chooseSpotlight(null, '?ghost', s, [], mid), { id: 'a-cod1', since: mid })
})

test('sparkline scales to its own maximum, newest on the right', () => {
  const g = new Grid(5, 1)
  sparkline(g, 0, 0, 5, [0, 1, 2, 4, 8], 0xffffff)
  assert.deepEqual(gridText(g), ['▁▁▂▄█'])
  const h = new Grid(3, 1)
  sparkline(h, 0, 0, 3, [0, 1, 2, 4, 8], 0xffffff)
  assert.deepEqual(gridText(h), ['▂▄█'])
  const k = new Grid(3, 1)
  sparkline(k, 0, 0, 3, [8], 0xffffff)
  assert.deepEqual(gridText(k), ['▁▁█'])
})

test('the full card shows every per-agent stat', () => {
  const s = state()
  const g = new Grid(110, 6, CANVAS)
  drawSpotlight(g, rect(0, 0, 110, 6), agentStats(s, 'a-cod1', mid)!, s.agents['a-cod1']!, mid, false)
  const rows = gridText(g)
  assert.match(rows[0]!, /coder-1 · coder · claude-sonnet-5-5/)
  assert.match(rows[0]!, /▶ running · 25s/)
  assert.match(rows[1]!, /tokens in .* out .* cache r .* w .* = /)
  assert.match(rows[1]!, /≈\$/)
  assert.match(rows[2]!, /context .*%.*cache hit \d+%/)
  assert.match(rows[3]!, /speed ≈ /)
  assert.match(rows[4]!, /tools r 0 {2}e 2 /)
  assert.match(rows[4]!, /errors 0/)
  assert.match(rows[5]!, /files 2/)
  assert.match(rows[5]!, /msgs ↓2 ↑1/)
  assert.match(rows[5]!, /! clash/)
})

test('a stuck agent says so, and the compact card is one line', () => {
  const s = state()
  const g = new Grid(110, 6, CANVAS)
  drawSpotlight(g, rect(0, 0, 110, 6), agentStats(s, 'a-test', mid)!, s.agents['a-test']!, mid, false)
  assert.match(gridText(g)[4]!, /! stuck/)
  const c = new Grid(90, 1, CANVAS)
  drawSpotlight(c, rect(0, 0, 90, 1), agentStats(s, 'a-cod1', mid)!, s.agents['a-cod1']!, mid, true)
  assert.match(gridText(c)[0]!, /coder-1 ▶ running · 25s · .* tok · ≈\$.* · ctx /)
})

test('the 10 s pulse window includes a pulse exactly 10 s old and drops one 1 ms older', () => {
  const s = state()
  const burst = (age: number): Pulse[] => Array.from({ length: 100 }, () => ({ agent: 'a-test', kind: 'bash', at: mid - age, isError: false }))
  assert.equal(busiest(s, burst(10_000), mid), 'a-test')
  assert.equal(busiest(s, burst(10_001), mid), 'a-cod1')
})

const colAt = (rows: string[], y: number, needle: string, offset = 0): number => {
  const i = rows[y]!.indexOf(needle)
  assert.ok(i >= 0, `${needle} not on row ${y}`)
  return i + offset
}

test('the card colours the model name and dims zero counts', () => {
  const s = state()
  const stats = agentStats(s, 'a-cod1', mid)!
  const g = new Grid(110, 6, CANVAS)
  drawSpotlight(g, rect(0, 0, 110, 6), stats, s.agents['a-cod1']!, mid, false)
  const rows = gridText(g)
  assert.equal(g.fg(colAt(rows, 0, 'claude-sonnet-5-5'), 0), MODEL.sonnet)
  assert.equal(g.fg(colAt(rows, 0, 'coder-1'), 0), TEXT.primary)
  assert.equal(g.fg(colAt(rows, 4, 'r 0', 2), 4), TEXT.dim)
  assert.equal(g.fg(colAt(rows, 4, 'e 2', 2), 4), TEXT.primary)
  assert.equal(g.fg(colAt(rows, 4, 'errors 0', 7), 4), TEXT.dim)
  const h = new Grid(110, 6, CANVAS)
  drawSpotlight(h, rect(0, 0, 110, 6), { ...stats, errors: 3 }, s.agents['a-cod1']!, mid, false)
  assert.equal(h.fg(colAt(gridText(h), 4, 'errors 3', 7), 4), STATUS.failed)
})

test('an unknown model shows a dim dash for cost, a known one shows it in primary', () => {
  const s = state()
  const stats = agentStats(s, 'a-cod1', mid)!
  const g = new Grid(110, 6, CANVAS)
  drawSpotlight(g, rect(0, 0, 110, 6), stats, s.agents['a-cod1']!, mid, false)
  assert.equal(g.fg(colAt(gridText(g), 1, '≈$'), 1), TEXT.primary)
  const h = new Grid(110, 6, CANVAS)
  drawSpotlight(h, rect(0, 0, 110, 6), { ...stats, model: null }, s.agents['a-cod1']!, mid, false)
  const rows = gridText(h)
  assert.match(rows[1]!, /–\s*$/)
  assert.equal(h.fg(rows[1]!.trimEnd().length - 1, 1), TEXT.dim)
})

test('on a narrow card the right-hand text never overwrites the left', () => {
  const s = state()
  const stats = agentStats(s, 'a-cod1', mid)!
  const g = new Grid(44, 6, CANVAS)
  drawSpotlight(g, rect(0, 0, 44, 6), stats, s.agents['a-cod1']!, mid, false)
  const rows = gridText(g)
  assert.match(rows[0]!, /▶ running · 25s $/)
  assert.match(rows[0]!, /^ ● coder-1/)
  assert.match(rows[0]!, / {2}▶ running/)
  assert.match(rows[1]!, / {2}≈\$[\d.]+ $/)
  const t = new Grid(60, 6, CANVAS)
  drawSpotlight(t, rect(0, 0, 60, 6), stats, s.agents['a-cod1']!, mid, false)
  assert.match(gridText(t)[5]!, /^ files 2 {2}\S.* msgs ↓2/)
})
