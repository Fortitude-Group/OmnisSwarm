import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fold, foldAll } from '../../src/core/fold.ts'
import { agentStats, fileClashes, type AgentStats } from '../../src/core/stats.ts'
import { contrast, hex, luminance } from '../../src/render/color.ts'
import { chipColor, frameInterval, render, targetFps } from '../../src/render/frame.ts'
import { gridText, pairCount, safeGlyph, type Grid } from '../../src/render/grid.ts'
import { FPS, MODEL, PAIR_BUDGET } from '../../src/render/tokens.ts'
import { emptyView, type View } from '../../src/render/types.ts'
import { FIVE_AT, FIVE_SWARM, fiveAgentEvents, quietEvents } from '../fixtures/swarm-five.ts'
import { at, ev } from '../helpers.ts'

const five = () => foldAll(FIVE_SWARM, fiveAgentEvents())
const FULL = { columns: 120, rows: 44 }
const fps = (s: ReturnType<typeof five>, view: View, now: number) => {
  const clashes = fileClashes(s, now)
  const stats: Record<string, AgentStats> = {}
  for (const id of Object.keys(s.agents)) stats[id] = agentStats(s, id, now, clashes)!
  return targetFps(s, view, now, stats, clashes)
}

test('each size step gives the right grids and chips', () => {
  const s = five()
  const full = render(s, emptyView(), FIVE_AT.mid, FULL)
  assert.deepEqual([full.step, full.top.columns, full.top.rows, full.bottom?.rows, full.chips.length], ['full', 120, 26, 17, 6])
  assert.deepEqual(full.chips.map(c => c.label), ['lead', 'architect', 'coder-1', 'coder-2', 'tester', 'reviewer'])
  const tree = render(s, emptyView(), FIVE_AT.mid, { columns: 60, rows: 13 })
  assert.deepEqual([tree.step, tree.bottom, tree.chips.length], ['tree', null, 0])
  const line = render(s, emptyView(), FIVE_AT.mid, { columns: 40, rows: 5 })
  assert.deepEqual([line.step, line.top.rows], ['summary', 1])
  assert.match(full.alt, /^◆ auth refactor · 6 agents/)
})

test('the spotlight is the pin, else the view\'s choice, else the busiest', () => {
  const s = five()
  assert.equal(render(s, emptyView(), FIVE_AT.mid, FULL).spotlight, 'a-cod1')
  assert.equal(render(s, { ...emptyView(), spotlight: { id: 'a-arch', since: 0 } }, FIVE_AT.mid, FULL).spotlight, 'a-arch')
  const pinned = render(s, { ...emptyView(), pinned: 'a-test', spotlight: { id: 'a-arch', since: 0 } }, FIVE_AT.mid, FULL)
  assert.equal(pinned.spotlight, 'a-test')
  assert.equal(pinned.chips.find(c => c.id === 'a-test')?.pinned, true)
})

test('the view keeps a pin only while that agent is in the state', () => {
  const s = five()
  const f = render(s, { ...emptyView(), pinned: 'gone' }, FIVE_AT.mid, FULL)
  assert.equal(f.chips.some(c => c.pinned), false)
  assert.equal(f.spotlight, 'a-cod1')
})

test('treeKey changes only when the element tree must change; nodesKey when the nodes do', () => {
  const s = five()
  const a = render(s, emptyView(), FIVE_AT.mid, FULL)
  const b = render(s, emptyView(), FIVE_AT.idle, FULL)
  assert.equal(a.treeKey, b.treeKey)
  assert.notEqual(a.treeKey, render(s, { ...emptyView(), pinned: 'a-test' }, FIVE_AT.mid, FULL).treeKey)
  assert.notEqual(a.treeKey, render(s, emptyView(), FIVE_AT.mid, { columns: 100, rows: 29 }).treeKey)
  const fewer = render(foldAll(FIVE_SWARM, fiveAgentEvents().slice(0, 12)), emptyView(), FIVE_AT.mid, FULL)
  assert.notEqual(a.treeKey, fewer.treeKey)
  assert.notEqual(a.nodesKey, fewer.nodesKey)
})

test('the frame rate: busy while things move, slow while only glows move, a tick when still', () => {
  const s = five()
  assert.equal(fps(s, emptyView(), FIVE_AT.mid), FPS.busy)
  assert.equal(fps(s, emptyView(), FIVE_AT.idle), FPS.glow)
  const quiet = foldAll(FIVE_SWARM, quietEvents())
  assert.equal(fps(quiet, emptyView(), FIVE_AT.idle), FPS.tick)
  assert.equal(fps(quiet, { ...emptyView(), tween: { from: {}, at: FIVE_AT.idle - 100 } }, FIVE_AT.idle), FPS.busy)
  assert.equal(fps(quiet, { ...emptyView(), pulses: [{ agent: 'a-arch', kind: 'read', at: FIVE_AT.idle - 100, isError: false }] }, FIVE_AT.idle), FPS.busy)
})

test('the frame interval backs off when frames are slow and recovers when they are fast', () => {
  assert.equal(frameInterval(30, 0, 0), 33)
  assert.equal(frameInterval(30, 33, 25), 66)
  assert.equal(frameInterval(30, 66, 50), 132)
  assert.equal(frameInterval(30, 132, 100), 250)
  assert.equal(frameInterval(30, 250, 10), 125)
  assert.equal(frameInterval(30, 125, 10), 63)
  assert.equal(frameInterval(12, 33, 5), 83)
  assert.equal(frameInterval(12, 100, 40), 100)
  assert.equal(frameInterval(0, 33, 5), 0)
})

test('the tick is exempt from the back-off floor: a slow frame never speeds it up', () => {
  assert.equal(frameInterval(FPS.tick, 0, 0), 1000)
  assert.equal(frameInterval(FPS.tick, 1000, 900), 1000)
  assert.equal(frameInterval(FPS.tick, 1000, 5), 1000)
  // After the idle tick, a rate change starts at its own base, not half the tick.
  assert.equal(frameInterval(30, 1000, 5), 33)
  assert.equal(frameInterval(12, 1000, 5), 83)
})

test('every frame stays inside its colour-pair budget and the Raster limits', () => {
  const s = five()
  for (const size of [FULL, { columns: 100, rows: 29 }, { columns: 80, rows: 21 }, { columns: 60, rows: 13 }, { columns: 600, rows: 600 }]) {
    for (const now of [FIVE_AT.mid, FIVE_AT.idle]) {
      const f = render(s, emptyView(), now, size)
      assert.ok(pairCount(f.top) <= PAIR_BUDGET.top)
      if (f.bottom !== null) assert.ok(pairCount(f.bottom) <= PAIR_BUDGET.bottom)
      for (const g of [f.top, f.bottom]) if (g !== null) assert.ok(g.columns <= 512 && g.rows <= 256)
    }
  }
})

test('render is deterministic', () => {
  const s = five()
  const a = render(s, emptyView(), FIVE_AT.mid, FULL)
  const b = render(s, emptyView(), FIVE_AT.mid, FULL)
  assert.equal(a.top.encode(), b.top.encode())
  assert.equal(a.bottom!.encode(), b.bottom!.encode())
})

test('a fresh state holding the same agents draws the same frame: no fade-in restarts', () => {
  const a = render(five(), emptyView(), FIVE_AT.idle, FULL)
  const b = render(five(), emptyView(), FIVE_AT.idle, FULL)
  assert.equal(a.top.encode(), b.top.encode())
  assert.equal(a.bottom!.encode(), b.bottom!.encode())
  assert.equal(a.nodesKey, b.nodesKey)
  // An agent that started long ago is fully drawn on a new state object, not fading in from the canvas.
  const s = five()
  const copy = foldAll(FIVE_SWARM, fiveAgentEvents())
  assert.deepEqual(render(s, emptyView(), FIVE_AT.mid, FULL).positions, render(copy, emptyView(), FIVE_AT.mid, FULL).positions)
})

test('chip colours are the model colours darkened to luminance 0.18 or less', () => {
  assert.deepEqual(Object.values(MODEL).map(c => hex(chipColor(c))), ['#9e628b', '#3f73d1', '#31854e', '#7e7823', '#707681'])
  for (const c of Object.values(MODEL)) {
    const d = chipColor(c)
    assert.ok(luminance(d) <= 0.18)
    assert.ok(contrast(d, 0x000000) >= 3.2 && contrast(d, 0xffffff) >= 3.2, hex(d))
  }
  assert.equal(chipColor(0x101010), 0x101010)
  const f = render(five(), emptyView(), FIVE_AT.mid, FULL)
  assert.equal(f.chips.find(c => c.id === 'a-arch')?.color, chipColor(MODEL.opus))
})

test('the layout is reused while the nodes stay the same and rebuilt when they change', () => {
  const s = five()
  const a = render(s, emptyView(), FIVE_AT.mid, FULL)
  const b = render(s, emptyView(), FIVE_AT.idle, FULL)
  assert.deepEqual(a.positions, b.positions)
  assert.equal(a.positions.lead, b.positions.lead)
  const wider = render(s, emptyView(), FIVE_AT.mid, { columns: 100, rows: 40 })
  assert.notDeepEqual(a.positions, wider.positions)
  const fewer = render(foldAll(FIVE_SWARM, fiveAgentEvents().slice(0, 12)), emptyView(), FIVE_AT.mid, FULL)
  assert.ok(Object.keys(fewer.positions).length < Object.keys(a.positions).length)
})

test('a failed read and hidden finished agents are said in the header', () => {
  const s = five()
  const header = (n: Parameters<typeof render>[4]) => gridText(render(s, emptyView(), FIVE_AT.mid, FULL, n).top).slice(0, 2).join('\n')
  assert.match(header({ degraded: 'too-large' }), /⚠ Swarm too large to draw \(6 agents\)/)
  assert.match(header({ degraded: 'too-large', degradedAgents: 900 }), /\(900 agents\)/)
  assert.match(header({ degraded: 'unreadable' }), /⚠ Waiting for the swarm…/)
  assert.match(header({ degraded: 'unreadable', hiddenFinished: 2 }), /Waiting for the swarm… · \+2 finished/)
  assert.match(header({ hiddenFinished: 3 }), /\+3 finished/)
  assert.doesNotMatch(header({}), /finished|too large|Waiting/)
  assert.doesNotMatch(header({ hiddenFinished: 0, degraded: null }), /finished/)
})

test('hostile names and summaries never put a cell the Raster would refuse', () => {
  const s = foldAll('s1', [
    ev('agent.started', { name: '😀中文x', role: 'r‮', description: '', parent: 'lead' }, { agent: 'e1', atSec: 0 }),
    ev('message.sent', { to: 'main', summary: 'ź́ ﾟ全角   end' }, { agent: 'e1', atSec: 1 }),
  ])
  const f = render(s, emptyView(), at(2), FULL)
  const ok = (g: Grid) => {
    for (let y = 0; y < g.rows; y++) for (let x = 0; x < g.columns; x++) assert.equal(safeGlyph(g.glyph(x, y)), g.glyph(x, y))
  }
  ok(f.top)
  ok(f.bottom!)
})

test('an empty swarm renders', () => {
  const f = render(foldAll('s1', []), emptyView(), at(0), FULL)
  assert.deepEqual([f.spotlight, f.chips.length, f.fps], [null, 0, FPS.tick])
})

test('the one-row steps say a failed read in short form', () => {
  const s = five()
  const top = (size: { columns: number; rows: number }, d: 'too-large' | 'unreadable') => gridText(render(s, emptyView(), FIVE_AT.mid, size, { degraded: d }).top)[0]!
  assert.match(top({ columns: 60, rows: 13 }, 'too-large'), /⚠ too large/)
  assert.match(top({ columns: 60, rows: 13 }, 'unreadable'), /⚠ waiting/)
  assert.match(top({ columns: 60, rows: 5 }, 'unreadable'), /⚠ waiting/)
})

test('a cached state object whose events change is laid out again', () => {
  const events = fiveAgentEvents()
  const s = foldAll(FIVE_SWARM, events.slice(0, 12))
  const before = render(s, emptyView(), FIVE_AT.mid, FULL)
  for (const e of events.slice(12, 30)) fold(s, e)
  const after = render(s, emptyView(), FIVE_AT.mid, FULL)
  assert.notEqual(before.nodesKey, after.nodesKey)
  assert.ok(Object.keys(after.positions).length > Object.keys(before.positions).length)
})

test('labels keep a clear cell either side: no line runs into them', () => {
  const f = render(five(), emptyView(), FIVE_AT.mid, FULL)
  const rows = gridText(f.top)
  const braille = (g: number) => g > 0x2800 && g <= 0x28ff
  for (const name of ['architect', 'tester', 'coder-1']) {
    const y = rows.findIndex((r, i) => i >= 2 && r.includes(` ${name}`))
    assert.ok(y >= 0, name)
    const x = rows[y]!.indexOf(` ${name}`) - 1
    const end = x + name.length + 2
    assert.ok(!braille(f.top.glyph(x - 1, y)) && !braille(f.top.glyph(end + 1, y)), `${name} at ${x},${y}`)
  }
})

test('when two nodes would overlap the graph area shows the tree', () => {
  const crowded = render(five(), emptyView(), FIVE_AT.mid, { columns: 80, rows: 21 })
  assert.match(gridText(crowded.top).join('\n'), /architect\s+\S+ tok · /)
  assert.ok(gridText(crowded.top).slice(2).every(r => ![...r].some(ch => ch > '⠀' && ch <= '⣿')))
  const roomy = render(five(), emptyView(), FIVE_AT.mid, FULL)
  assert.doesNotMatch(gridText(roomy.top).slice(2).join('\n'), /\S+ tok · /)
})

test('a very deep chain draws in bounded time (the legibility guard is linear and cached)', { timeout: 30_000 }, () => {
  const s = five()
  const base = s.agents['a-test']!
  const N = 20_000
  for (let i = 0; i < N; i++) {
    s.agents[`c${i}`] = { ...base, id: `c${i}`, name: `c${i}`, parent: i === 0 ? 'lead' : `c${i - 1}`, startedAt: FIVE_AT.mid - 50_000 + i }
  }
  s.events++
  const t0 = Date.now()
  const f = render(s, emptyView(), FIVE_AT.mid, FULL)
  render(s, emptyView(), FIVE_AT.mid, FULL)
  assert.equal(f.step, 'full')
  assert.ok(Date.now() - t0 < 5_000)
})

test('the 1-row header leaves out the topology so the context fits', () => {
  const f = render(five(), emptyView(), FIVE_AT.mid, { columns: 60, rows: 13 })
  assert.match(gridText(f.top)[0]!, /◆ auth refactor · 6 agents 4▶ · ≈\$[\d.]+\+ · ctx 34%/)
  assert.doesNotMatch(gridText(f.top)[0]!, /hierarchical/)
})
