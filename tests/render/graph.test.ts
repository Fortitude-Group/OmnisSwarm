import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldAll, type SwarmState } from '../../src/core/fold.ts'
import { agentStats, fileClashes, type AgentStats } from '../../src/core/stats.ts'
import { pulsesFrom } from '../../src/mod/pane-model.ts'
import { desaturate, mix, scale } from '../../src/render/color.ts'
import { drawGraph, nodeColor, nodeRadius } from '../../src/render/graph.ts'
import { Grid, gridText, pairCount } from '../../src/render/grid.ts'
import { layoutNodes } from '../../src/render/layout.ts'
import { CANVAS, GRAPH, LINK, MODEL, STATUS } from '../../src/render/tokens.ts'
import { emptyView, rect } from '../../src/render/types.ts'
import { FIVE_AT, FIVE_SWARM, fiveAgentEvents } from '../fixtures/swarm-five.ts'
import { ev } from '../helpers.ts'

const statsOf = (s: SwarmState, now: number) => {
  const clashes = fileClashes(s, now)
  const out: Record<string, AgentStats> = {}
  for (const id of Object.keys(s.agents)) out[id] = agentStats(s, id, now, clashes)!
  return { stats: out, clashes }
}

function draw(s: SwarmState, now: number, w = 120, h = 24): Grid {
  const g = new Grid(w, h, CANVAS)
  const { stats, clashes } = statsOf(s, now)
  const positions = layoutNodes(s, s.swarm.topology, w, h * 2)
  drawGraph(g, rect(0, 0, w, h), { state: s, stats, positions, clashes, view: { ...emptyView(), pulses: pulsesFrom(fiveAgentEvents()) }, now, tEff: now })
  return g
}

const cells = (g: Grid) => Array.from({ length: g.columns * g.rows }, (_, i) => ({ x: i % g.columns, y: Math.floor(i / g.columns) }))
  .map(({ x, y }) => ({ glyph: g.glyph(x, y), fg: g.fg(x, y), bg: g.bg(x, y) }))

test('node radius grows with the log of tokens, within its limits', () => {
  assert.equal(nodeRadius(0, 6), GRAPH.minRadius)
  assert.ok(nodeRadius(1_000_000, 6) > nodeRadius(10_000, 6))
  assert.equal(nodeRadius(1e12, 6), 6)
  assert.equal(nodeRadius(1_000_000, 3), 3)
})

test('node colour follows status: running in the model colour, waiting dimmer, done a ghost, failed red, new ones faded', () => {
  const s = foldAll(FIVE_SWARM, fiveAgentEvents())
  const mid = FIVE_AT.mid
  const st = statsOf(s, mid).stats
  assert.equal(nodeColor(st['a-cod1']!, s.agents['a-cod1']!, mid), MODEL.sonnet)
  assert.equal(nodeColor(st['a-rev']!, s.agents['a-rev']!, mid), STATUS.failed)
  assert.equal(nodeColor(st['a-cod2']!, s.agents['a-cod2']!, mid), mix(desaturate(MODEL.sonnet, 0.7), CANVAS, 0.55))
  const idle = statsOf(s, FIVE_AT.idle).stats
  assert.equal(nodeColor(idle['a-arch']!, s.agents['a-arch']!, FIVE_AT.idle), scale(MODEL.opus, 0.72))
  assert.equal(nodeColor(st['a-cod1']!, s.agents['a-cod1']!, s.agents['a-cod1']!.startedAt), CANVAS)
})

test('mid-swarm: every agent is labelled, comets fly, the clash is drawn and the failed node is red', () => {
  const g = draw(foldAll(FIVE_SWARM, fiveAgentEvents()), FIVE_AT.mid)
  const text = gridText(g).join('\n')
  for (const name of ['lead', 'architect', 'coder-1', 'coder-2', 'tester', 'reviewer', 'ghost']) assert.ok(text.includes(name), name)
  const all = cells(g)
  assert.ok(all.some(c => c.fg === LINK.comet), 'a comet head')
  assert.ok(all.some(c => c.glyph > 0x2800 && c.glyph <= 0x28ff && c.fg === LINK.clash), 'a dashed clash line')
  assert.ok(all.some(c => (c.glyph === 0x2580 || c.glyph === 0x20) && (c.fg === STATUS.failed || c.bg === STATUS.failed)), 'a red node')
  assert.ok(pairCount(g) <= 1024)
})

test('once everything has settled there are no comets', () => {
  const g = draw(foldAll(FIVE_SWARM, fiveAgentEvents()), FIVE_AT.idle)
  assert.ok(!cells(g).some(c => c.fg === LINK.comet))
})

test('mesh and star layouts draw too', () => {
  for (const topology of ['mesh', 'star'] as const) {
    const text = gridText(draw(foldAll(FIVE_SWARM, fiveAgentEvents(topology)), FIVE_AT.mid)).join('\n')
    assert.ok(text.includes('architect') && text.includes('reviewer'), topology)
  }
})

test('a parent loop and an empty swarm draw without trouble', () => {
  const looped = foldAll('s1', [
    ev('agent.started', { name: 'a', role: 'r', description: '', parent: 'b' }, { agent: 'a', atSec: 0 }),
    ev('agent.started', { name: 'b', role: 'r', description: '', parent: 'a' }, { agent: 'b', atSec: 1 }),
  ])
  assert.ok(gridText(draw(looped, Date.parse('2026-10-21T10:00:10.000Z'))).join('').includes('a'))
  const empty = draw(foldAll('s1', []), FIVE_AT.mid)
  assert.ok(cells(empty).every(c => c.bg === CANVAS))
})

test('node radius is safe for any input', () => {
  for (const t of [NaN, -5, Infinity, -Infinity]) for (const m of [NaN, -1, 0, Infinity, 6]) {
    const r = nodeRadius(t, m)
    assert.ok(Number.isFinite(r) && r >= GRAPH.minRadius, `${t} ${m} -> ${r}`)
  }
})

test('the lead is labelled with its status glyph after the name', () => {
  const text = gridText(draw(foldAll(FIVE_SWARM, fiveAgentEvents()), FIVE_AT.mid)).join('\n')
  assert.match(text, /◆ lead [▶◌✓✕]/)
})

test('a tool flicker lights a pixel band outside the context ring', () => {
  const s = foldAll(FIVE_SWARM, fiveAgentEvents())
  const now = FIVE_AT.mid
  const { stats, clashes } = statsOf(s, now)
  const positions = layoutNodes(s, s.swarm.topology, 120, 48)
  const render = (pulses: ReturnType<typeof pulsesFrom>) => {
    const g = new Grid(120, 24, CANVAS)
    drawGraph(g, rect(0, 0, 120, 24), { state: s, stats, positions, clashes, view: { ...emptyView(), pulses }, now, tEff: now })
    return g
  }
  const quiet = render([])
  const lit = render([{ agent: 'a-cod1', kind: 'edit', at: now - 50, isError: false }])
  const p = positions['a-cod1']!
  const r = nodeRadius(stats['a-cod1']!.tokens.total, 6)
  let outside = 0
  for (let y = 0; y < 24; y++) for (let x = 0; x < 120; x++) {
    if (quiet.fg(x, y) === lit.fg(x, y) && quiet.bg(x, y) === lit.bg(x, y)) continue
    if (Math.hypot(x + 0.5 - p.x, 2 * y + 1 - p.y) > r + GRAPH.ringPx + 0.5) outside++
  }
  assert.ok(outside > 0)
})

test('a dense swarm and hostile input draw without NaN or overflow', () => {
  const events = [] as ReturnType<typeof ev>[]
  for (let i = 0; i < 300; i++) events.push(ev('agent.started', { name: `n${i}`, role: 'r', description: '', parent: i === 0 ? '' : 'n0' }, { agent: `n${i}`, atSec: i }))
  const s = foldAll('s1', events)
  const now = Date.parse('2026-10-21T10:10:00.000Z')
  const g = draw(s, now, 80, 20)
  assert.equal(g.columns, 80)
  const { stats, clashes } = statsOf(s, now)
  const bad = new Grid(40, 10, CANVAS)
  const positions = Object.fromEntries(Object.keys(s.agents).map(id => [id, { x: NaN, y: Infinity }]))
  drawGraph(bad, rect(0, 0, 40, 10), { state: s, stats, positions, clashes, view: emptyView(), now: NaN, tEff: NaN })
  drawGraph(bad, rect(0, 0, 0, 0), { state: s, stats, positions: {}, clashes, view: emptyView(), now, tEff: now })
  const tiny = new Grid(3, 2, CANVAS)
  drawGraph(tiny, rect(0, 0, 3, 2), { state: s, stats, positions: layoutNodes(s, s.swarm.topology, 3, 4), clashes, view: emptyView(), now, tEff: now })
})
