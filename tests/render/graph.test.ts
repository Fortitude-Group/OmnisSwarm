import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LEAD, foldAll, type SwarmState } from '../../src/core/fold.ts'
import { agentStats, fileClashes, type AgentStats } from '../../src/core/stats.ts'
import { pulsesFrom } from '../../src/mod/pane-model.ts'
import { desaturate, mix, scale } from '../../src/render/color.ts'
import { bendFor, drawGraph, nodeColor, nodeRadius, radiusCap } from '../../src/render/graph.ts'
import { Grid, gridText, pairCount } from '../../src/render/grid.ts'
import { layoutNodes } from '../../src/render/layout.ts'
import { CANVAS, GRAPH, LINK, MODEL, STATUS, TEXT } from '../../src/render/tokens.ts'
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

test('a dense swarm and hostile input draw without NaN or overflow', { timeout: 10_000 }, () => {
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
  assert.ok(cells(bad).every(c => c.bg === CANVAS && c.glyph === 0x20), 'every hostile position was rejected')
  drawGraph(bad, rect(0, 0, 0, 0), { state: s, stats, positions: {}, clashes, view: emptyView(), now, tEff: now })
  const tiny = new Grid(3, 2, CANVAS)
  drawGraph(tiny, rect(0, 0, 3, 2), { state: s, stats, positions: layoutNodes(s, s.swarm.topology, 3, 4), clashes, view: emptyView(), now, tEff: now })
})

const one = (): SwarmState => foldAll('s1', [ev('agent.started', { name: 'solo', role: 'r', description: '', parent: '' }, { agent: 'solo', atSec: 0 })])
const T1 = Date.parse('2026-10-21T10:00:30.000Z')

test('caller-supplied edges replace the per-frame structural edges', () => {
  const s = foldAll(FIVE_SWARM, fiveAgentEvents())
  const { stats, clashes } = statsOf(s, FIVE_AT.idle)
  const positions = layoutNodes(s, s.swarm.topology, 120, 48)
  const faint = mix(CANVAS, TEXT.faint, 0.6)
  const count = (edges?: { from: string; to: string }[]) => {
    const g = new Grid(120, 24, CANVAS)
    drawGraph(g, rect(0, 0, 120, 24), { state: s, stats, positions, clashes, view: emptyView(), now: FIVE_AT.idle, tEff: FIVE_AT.idle, ...(edges ? { edges } : {}) })
    return cells(g).filter(c => c.glyph > 0x2800 && c.fg === faint).length
  }
  assert.ok(count() > 0)
  assert.equal(count([]), 0)
})

test('a max-size node at the top of the canvas keeps its context ring inside it', () => {
  const s = one()
  const { stats, clashes } = statsOf(s, T1)
  const big = { ...stats['solo']!, status: 'waiting' as const, contextFill: 0.5, tokens: { ...stats['solo']!.tokens, total: 1e12 } }
  const g = new Grid(40, 30, CANVAS)
  drawGraph(g, rect(0, 0, 40, 30), { state: s, stats: { solo: big }, positions: { solo: { x: 20, y: 6 } }, clashes, view: emptyView(), now: T1, tEff: T1 })
  assert.ok(cells(g).slice(19, 21).some(c => c.fg === TEXT.dim || c.bg === TEXT.dim), 'the ring top is on the canvas')
})

test('a node on the bottom layer leaves its own label row clear of its ring', () => {
  const s = one()
  const { stats, clashes } = statsOf(s, T1)
  const big = { ...stats['solo']!, status: 'waiting' as const, contextFill: 0.5, tokens: { ...stats['solo']!.tokens, total: 1e12 } }
  const g = new Grid(40, 30, CANVAS)
  drawGraph(g, rect(0, 0, 40, 30), { state: s, stats: { solo: big }, positions: { solo: { x: 20, y: 53 } }, clashes, view: emptyView(), now: T1, tEff: T1 })
  assert.ok(cells(g).slice(29 * 40).every(c => c.glyph !== 0x2580 && c.bg === CANVAS), 'nothing but the label in the last row')
  assert.ok(gridText(g)[29]!.includes('solo'))
})

test('radius is capped by the spacing between nodes', () => {
  const area = rect(0, 0, 120, 24)
  assert.equal(radiusCap([{ x: 10, y: 20 }, { x: 80, y: 20 }], area), GRAPH.maxRadius)
  assert.equal(radiusCap([{ x: 10, y: 20 }, { x: 15, y: 20 }], area), 2)
  assert.equal(radiusCap([{ x: 10, y: 20 }, { x: 10, y: 20 }], area), GRAPH.minRadius)
  assert.equal(radiusCap([{ x: 10, y: 20 }], area), GRAPH.maxRadius)
  assert.ok(nodeRadius(1e12, 99) <= GRAPH.maxRadius)
})

test('an arc bends enough to clear a node sitting between its ends', () => {
  const a = { x: 10, y: 20 }
  const b = { x: 70, y: 20 }
  assert.equal(bendFor(a, b, []), GRAPH.linkBend)
  const reach = 7
  const bend = bendFor(a, b, [{ p: { x: 40, y: 20 }, reach }])
  assert.ok(bend > GRAPH.linkBend && bend <= GRAPH.linkBendMax)
  assert.ok(0.5 * bend * 60 >= reach - 1e-9, 'the peak clears the node')
  assert.equal(bendFor(a, b, [{ p: { x: 40, y: 20 }, reach: 1000 }]), GRAPH.linkBendMax)
  assert.equal(bendFor(a, a, [{ p: a, reach: 3 }]), GRAPH.linkBend)
})

test('a crowded lead keeps its status glyph beside the diamond', () => {
  const s = foldAll(FIVE_SWARM, fiveAgentEvents())
  const { stats, clashes } = statsOf(s, FIVE_AT.mid)
  const positions = layoutNodes(s, s.swarm.topology, 120, 48)
  const g = new Grid(5, 24, CANVAS)
  drawGraph(g, rect(0, 0, 5, 24), { state: s, stats, positions: { [LEAD]: { x: 2, y: 10 } }, clashes, view: emptyView(), now: FIVE_AT.mid, tEff: FIVE_AT.mid })
  assert.match(gridText(g).join(''), /◆[▶◌✓✕]/)
})

test('an infinite or oversized area is clamped to the grid', { timeout: 10_000 }, () => {
  const s = foldAll(FIVE_SWARM, fiveAgentEvents())
  const { stats, clashes } = statsOf(s, FIVE_AT.mid)
  const positions = layoutNodes(s, s.swarm.topology, 120, 48)
  const g = new Grid(120, 24, CANVAS)
  for (const area of [rect(0, 0, Infinity, Infinity), rect(0, 0, 4000, 4000), rect(100, 10, 4000, 4000), rect(NaN, 0, 10, 10)]) {
    drawGraph(g, area, { state: s, stats, positions, clashes, view: emptyView(), now: FIVE_AT.mid, tEff: FIVE_AT.mid })
  }
})

test('radiusCap is fast when every node shares one column', { timeout: 10_000 }, () => {
  const points = Array.from({ length: 10_000 }, (_, i) => ({ x: 50, y: i * 0.01 }))
  const t0 = performance.now()
  assert.equal(radiusCap(points, rect(0, 0, 120, 24)), GRAPH.minRadius)
  assert.ok(performance.now() - t0 < 1000)
  const roomy = Array.from({ length: 200 }, (_, i) => ({ x: 50, y: i * 40 }))
  assert.equal(radiusCap(roomy, rect(0, 0, 120, 24)), GRAPH.maxRadius)
})

test('a negative area origin clips the graph instead of shifting it right', { timeout: 10_000 }, () => {
  const s = one()
  const { stats, clashes } = statsOf(s, T1)
  const at = (areaX: number, nodeX: number) => {
    const g = new Grid(40, 12, CANVAS)
    drawGraph(g, rect(areaX, 0, 40, 12), { state: s, stats, positions: { solo: { x: nodeX, y: 12 } }, clashes, view: emptyView(), now: T1, tEff: T1 })
    return gridText(g).map(r => r.indexOf('solo')).find(i => i >= 0) ?? -1
  }
  const home = at(0, 20)
  assert.ok(home >= 0)
  assert.equal(at(-5, 25), home)
})

test('a quiet link shows only while recent; at rest the graph holds no message arcs', () => {
  const s = foldAll(FIVE_SWARM, fiveAgentEvents())
  const draw = (now: number) => {
    const { stats, clashes } = statsOf(s, now)
    const g = new Grid(120, 24, CANVAS)
    drawGraph(g, rect(0, 0, 120, 24), { state: s, stats, positions: layoutNodes(s, s.swarm.topology, 120, 48), clashes, view: emptyView(), now, tEff: now, edges: [] })
    return cells(g).filter(c => c.glyph > 0x2800 && c.fg !== LINK.clash).length
  }
  assert.ok(draw(FIVE_AT.mid) > 0)
  assert.equal(draw(FIVE_AT.idle), 0)
})
