import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldAll } from '../../src/core/fold.ts'
import { agentStats, fileClashes, swarmTotals, type AgentStats } from '../../src/core/stats.ts'
import { drawFeed, nameOf } from '../../src/render/feed.ts'
import { fmtUsd } from '../../src/render/format.ts'
import { Grid, gridText } from '../../src/render/grid.ts'
import { drawHeader, drawSummary, summaryText } from '../../src/render/header.ts'
import { drawTimeline } from '../../src/render/timeline.ts'
import { CANVAS } from '../../src/render/tokens.ts'
import { drawTree } from '../../src/render/tree.ts'
import { rect } from '../../src/render/types.ts'
import { FIVE_AT, FIVE_SWARM, fiveAgentEvents } from '../fixtures/swarm-five.ts'

const mid = FIVE_AT.mid
const state = () => foldAll(FIVE_SWARM, fiveAgentEvents())
const statsOf = (s: ReturnType<typeof state>) => {
  const clashes = fileClashes(s, mid)
  const out: Record<string, AgentStats> = {}
  for (const id of Object.keys(s.agents)) out[id] = agentStats(s, id, mid, clashes)!
  return out
}

test('the header shows name, topology, agents, cost, tokens, burn, context and tasks', () => {
  const s = state()
  const totals = swarmTotals(s, mid)
  const g = new Grid(140, 2, CANVAS)
  drawHeader(g, rect(0, 0, 140, 2), s, totals)
  const [top, second] = gridText(g)
  assert.match(top!, /◆ auth refactor · hierarchical · 6 agents 4▶/)
  assert.ok(top!.includes(`${fmtUsd(totals.costUsd)}+`), 'a partial cost is marked +')
  assert.match(top!, / tok · ≈\$[\d.]+\/min · ctx 34%/)
  assert.match(top!, /cc \$1\.20/)
  assert.match(second!, /tasks 0 pending · 1 active · 1 done · 0 failed · memory 1 · ! 1 clash/)
})

test('the header shows log gaps on the right', () => {
  const s = state()
  s.gaps = 2
  const g = new Grid(140, 2, CANVAS)
  drawHeader(g, rect(0, 0, 140, 2), s, swarmTotals(s, mid))
  assert.match(gridText(g)[0]!, /⚠ 2 gaps $/)
})

test('the summary is one line', () => {
  const s = state()
  const totals = swarmTotals(s, mid)
  assert.match(summaryText(s, totals), /^◆ auth refactor · 6 agents 4▶ · ≈\$[\d.]+\+ · ctx 34%$/)
  const g = new Grid(40, 1, CANVAS)
  drawSummary(g, rect(0, 0, 40, 1), s, totals)
  assert.match(gridText(g)[0]!, /^ ◆ auth refactor · 6 agents/)
})

test('the tree lists agents depth first, indented by depth, and says how many did not fit', () => {
  const s = state()
  const g = new Grid(60, 12, CANVAS)
  drawTree(g, rect(0, 0, 60, 12), s, statsOf(s))
  const rows = gridText(g)
  const order = ['lead', 'architect', 'coder-1', 'coder-2', 'tester', 'reviewer', 'ghost'].map(name => rows.findIndex(r => r.includes(` ${name}`)))
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6])
  assert.deepEqual([rows[0]!.search(/\S/), rows[1]!.search(/\S/), rows[2]!.search(/\S/)], [1, 3, 5])
  const small = new Grid(60, 3, CANVAS)
  drawTree(small, rect(0, 0, 60, 3), s, statsOf(s))
  assert.match(gridText(small)[2]!, /… 5 more/)
})

test('the timeline has a row per agent and an axis; failed rows end in a cross', () => {
  const s = state()
  const g = new Grid(100, 7, CANVAS)
  drawTimeline(g, rect(0, 0, 100, 7), s, mid)
  const rows = gridText(g)
  assert.deepEqual(rows.slice(0, 6).map(r => /lead|architect|coder-1|coder-2|tester|reviewer/.exec(r)?.[0]), ['lead', 'architect', 'coder-1', 'coder-2', 'tester', 'reviewer'])
  const reviewer = rows[5]!
  assert.equal([...reviewer].filter(ch => ch === '✕').length, 2)
  assert.match(rows[1]!, /█/)
  assert.match(rows[6]!, /0s.*30s/)
})

test('the feed lists messages, memory writes and task changes, newest first', () => {
  const s = state()
  const g = new Grid(100, 4, CANVAS)
  drawFeed(g, rect(0, 0, 100, 4), s, mid)
  const rows = gridText(g)
  assert.match(rows[0]!, /^ {2}0s # task t2 → done/)
  assert.match(rows[1]!, /0s › architect → \?ghost: are you there/)
  assert.match(rows[2]!, /0s › lead → tester: rerun with a fixed seed/)
  assert.match(rows[3]!, /0s › architect → coder-1: use ed25519 keys/)
  assert.equal(nameOf(s, '?ghost'), '?ghost')
  assert.equal(nameOf(s, 'a-cod1'), 'coder-1')
  assert.equal(nameOf(s, 'nobody'), 'nobody')
})
