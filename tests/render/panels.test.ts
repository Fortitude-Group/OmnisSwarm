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

const clone = (s: ReturnType<typeof state>, id: string, from: string, parent: string): void => {
  s.agents[id] = { ...s.agents[from]!, id, name: id, parent }
}

test('the tree ends on parent loops and shows every agent exactly once', () => {
  const s = state()
  clone(s, 'loop-a', 'a-test', 'loop-b')
  clone(s, 'loop-b', 'a-test', 'loop-a')
  clone(s, 'loop-c', 'a-test', 'loop-a')
  const g = new Grid(60, 20, CANVAS)
  drawTree(g, rect(0, 0, 60, 20), s, statsOf(s))
  const rows = gridText(g)
  for (const id of Object.keys(s.agents)) {
    const name = s.agents[id]!.name
    assert.equal(rows.filter(r => r.includes(` ${name} `) || r.trimEnd().endsWith(` ${name}`)).length, 1, `${name} once`)
  }
  assert.equal(rows.filter(r => r.trim() !== '').length, Object.keys(s.agents).length)
})

test('a very deep parent chain does not overflow the stack and only fills the rows it has', () => {
  const s = state()
  const base = statsOf(s)['a-test']!
  const stats: Record<string, AgentStats> = {}
  const N = 12_000 // the parent walk of layout.ts must be near-linear for this to be quick
  for (let i = 0; i < N; i++) {
    const id = `d${i}`
    s.agents[id] = { ...s.agents['a-test']!, id, name: id, parent: i === 0 ? 'lead' : `d${i - 1}`, startedAt: i + 1 }
    stats[id] = { ...base, id, name: id }
  }
  stats['lead'] = { ...base, id: 'lead', name: 'lead' }
  const g = new Grid(60, 6, CANVAS)
  drawTree(g, rect(0, 0, 60, 6), s, stats)
  const rows = gridText(g)
  assert.match(rows[0]!, / lead/)
  assert.match(rows[5]!, /… \d+ more/)
  assert.match(rows[1]!, /^ {3}\S.* d0 /)
})

test('agents with no stats leave no blank rows and the more-count only counts the visible', () => {
  const s = state()
  const st = statsOf(s)
  delete st['a-cod1']
  const g = new Grid(60, 3, CANVAS)
  drawTree(g, rect(0, 0, 60, 3), s, st)
  const rows = gridText(g)
  assert.ok(rows.every(r => r.trim() !== ''))
  assert.match(rows[2]!, /… 4 more/)
  const big = new Grid(60, 8, CANVAS)
  drawTree(big, rect(0, 0, 60, 8), s, st)
  assert.equal(gridText(big).filter(r => r.trim() !== '').length, 6)
})

test('unknown session figures show a dash and hide cc; the summary shows gaps', () => {
  const s = state()
  s.session = { ...s.session, contextTokens: null, contextWindow: null, contextPercent: null, costUsd: null }
  const g = new Grid(140, 2, CANVAS)
  drawHeader(g, rect(0, 0, 140, 2), s, swarmTotals(s, mid))
  const top = gridText(g)[0]!
  assert.match(top, /ctx –/)
  assert.ok(!top.includes('cc $'))
  s.gaps = 3
  const sg = new Grid(60, 1, CANVAS)
  drawSummary(sg, rect(0, 0, 60, 1), s, swarmTotals(s, mid))
  assert.match(gridText(sg)[0]!, /⚠ 3\s*$/)
})

test('gaps are pluralised and a long goal is cut with an ellipsis', () => {
  const s = state()
  s.gaps = 1
  s.swarm.goal = 'g'.repeat(300)
  const g = new Grid(140, 2, CANVAS)
  drawHeader(g, rect(0, 0, 140, 2), s, swarmTotals(s, mid))
  const [top, second] = gridText(g)
  assert.match(top!, /⚠ 1 gap $/)
  assert.match(second!, /…\s*$/)
})

test('the feed clips long text with an ellipsis', () => {
  const s = state()
  const g = new Grid(30, 4, CANVAS)
  drawFeed(g, rect(0, 0, 30, 4), s, mid)
  const rows = gridText(g)
  assert.ok(rows[1]!.trimEnd().endsWith('…'))
  assert.ok(rows[1]!.trimEnd().length <= 30)
})

test('timeline bars start and end where the lifetimes say', () => {
  const s = state()
  const g = new Grid(100, 7, CANVAS)
  drawTimeline(g, rect(0, 0, 100, 7), s, mid)
  const rows = gridText(g)
  const x0 = 15
  const arch = [...rows[1]!]
  assert.equal(arch[x0 + 1], ' ')
  for (let x = 2; x <= 83; x++) assert.equal(arch[x0 + x], '█', `architect col ${x}`)
  const cod2 = [...rows[3]!]
  for (let x = 14; x <= 59; x++) assert.equal(cod2[x0 + x], '█', `coder-2 col ${x}`)
  assert.equal(cod2[x0 + 13], ' ')
  assert.equal(cod2[x0 + 60], '▉')
  assert.equal(cod2[x0 + 61], ' ')
})

test('the timeline copes with thousands of agents', () => {
  const s = state()
  for (let i = 0; i < 150_000; i++) s.agents[`m${i}`] = { ...s.agents['a-test']!, id: `m${i}`, name: `m${i}`, parent: 'lead' }
  s.swarm.startedAt = null
  const g = new Grid(100, 7, CANVAS)
  drawTimeline(g, rect(0, 0, 100, 7), s, mid)
  assert.match(gridText(g)[6]!, /… \+/)
})
