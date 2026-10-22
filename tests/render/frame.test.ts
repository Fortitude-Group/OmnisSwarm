import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fold, foldAll } from '../../src/core/fold.ts'
import { agentStats, fileClashes, type AgentStats } from '../../src/core/stats.ts'
import { contrast, hex, luminance } from '../../src/render/color.ts'
import { MAX_INTERVAL_MS, budgetFps, chipColor, frameInterval, render, smoothRenderMs, targetFps } from '../../src/render/frame.ts'
import { FULL_MOTION, motionFor } from '../../src/render/fx.ts'
import { pulsesFrom } from '../../src/mod/pane-model.ts'
import { gridText, pairCount, safeGlyph, type Grid } from '../../src/render/grid.ts'
import { FPS, LINK, MODEL, PAIR_BUDGET } from '../../src/render/tokens.ts'
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

test('the frame rate matches the design tokens: busy 20, glow 5, floor 4, tick 1', () => {
  assert.deepEqual({ ...FPS }, { busy: 20, glow: 5, min: 4, tick: 1 })
})

test('ghost fades, link fades and the clash blink run at the glow rate, not busy', () => {
  const quietAt = (mutate: (s: ReturnType<typeof five>) => void) => {
    const s = foldAll(FIVE_SWARM, quietEvents())
    mutate(s)
    return fps(s, emptyView(), FIVE_AT.idle)
  }
  // A finished agent fading to its ghost.
  assert.equal(quietAt(s => fold(s, ev('agent.finished', { outcome: 'answer', reason: 'answer' }, { agent: 'a-arch', atSec: 399.5, swarm: FIVE_SWARM }))), FPS.glow)
  // A link two seconds after its last message: the comet has landed, the link is still fading.
  assert.equal(quietAt(s => { for (const l of Object.values(s.links)) l.lastAt = FIVE_AT.idle - 2000 }), FPS.glow)
  // Once the fade window has passed, only the tick is left.
  assert.equal(quietAt(s => { for (const l of Object.values(s.links)) l.lastAt = FIVE_AT.idle - 3500 }), FPS.tick)
  // Two agents edited the same file a second ago: the rims blink.
  assert.equal(quietAt(s => { s.edits['x.ts'] = [{ agent: 'lead', at: FIVE_AT.idle - 1000 }, { agent: 'a-arch', at: FIVE_AT.idle - 900 }] }), FPS.glow)
  // A fade-in is still busy.
  assert.equal(quietAt(s => fold(s, ev('agent.started', { name: 'new', role: 'r', description: '', parent: 'lead' }, { agent: 'a-new', atSec: 399.8, swarm: FIVE_SWARM }))), FPS.busy)
})

test('pane.md section 11: each interval is at least 10x the last render, so render never takes more than 100 ms a second', () => {
  assert.equal(frameInterval(20, 0), 50)
  assert.equal(frameInterval(20, 5), 50)
  assert.equal(frameInterval(20, 6), 60)
  assert.equal(frameInterval(20, 25), 250)
  assert.equal(frameInterval(FPS.glow, 10), 200)
  assert.equal(frameInterval(FPS.glow, 25), 250)
  assert.equal(frameInterval(FPS.tick, 25), 1000)
  assert.equal(frameInterval(FPS.tick, 150), 1500)
  assert.equal(frameInterval(0, 5), 0)
  // A frame that comes in under the cap falls straight back to the target rate.
  assert.equal(frameInterval(20, 2), 50)
  for (const fps of [FPS.busy, FPS.glow, FPS.min, FPS.tick]) {
    for (const renderMs of [0, 1, 3, 4.9, 5, 7.5, 12, 25, 40, 99, 250, 1000]) {
      const interval = frameInterval(fps, renderMs)
      assert.ok(interval >= 10 * renderMs, `${fps} fps, ${renderMs} ms`)
      assert.ok(renderMs * (1000 / interval) <= 100 + 1e-9, `${fps} fps, ${renderMs} ms spends ${renderMs * (1000 / interval)} ms a second`)
      assert.ok(interval >= Math.round(1000 / fps), 'never faster than the target')
    }
  }
  assert.equal(frameInterval(20, Number.NaN), 50)
})

test('one freak frame never stretches the interval past 10 s', () => {
  assert.equal(MAX_INTERVAL_MS, 10_000)
  assert.equal(frameInterval(FPS.tick, 999), 9990)
  assert.equal(frameInterval(FPS.tick, 5_000), 10_000)
  assert.equal(frameInterval(FPS.busy, Number.MAX_VALUE), 10_000)
})

test('the motion cap follows an average of render times: one slow frame alone drops no motion', () => {
  // Steady at 8 ms (cap 12.5 fps, every motion on), then one 14 ms frame: on its own it would cap at 7.1 fps.
  let avg = 0
  for (let i = 0; i < 40; i++) avg = smoothRenderMs(avg, 8)
  assert.ok(Math.abs(avg - 8) < 0.01)
  assert.equal(motionFor(budgetFps(14)).fadeIn, false)
  avg = smoothRenderMs(avg, 14)
  assert.equal(motionFor(budgetFps(avg)).fadeIn, true)
  // Frames that stay slow do bring the cap down within a few frames.
  for (let i = 0; i < 6; i++) avg = smoothRenderMs(avg, 14)
  assert.equal(motionFor(budgetFps(avg)).fadeIn, false)
  assert.equal(smoothRenderMs(Number.NaN, Number.NaN), 0)
})

test('the budget cap is 1000 / (10 x renderMs) frames a second', () => {
  assert.equal(budgetFps(25), 4)
  assert.equal(budgetFps(5), 20)
  assert.equal(budgetFps(0), Number.POSITIVE_INFINITY)
  assert.equal(budgetFps(Number.NaN), Number.POSITIVE_INFINITY)
})

test('pane.md section 6: motions drop in order as the cap falls, and come back in reverse', () => {
  const on = (cap: number) => {
    const m = motionFor(cap)
    return [m.breathe, m.slowFades, m.clashBlink, m.fadeIn, m.glide, m.pulseFade, m.comets].map(b => (b ? 1 : 0)).join('')
  }
  assert.deepEqual(motionFor(Number.POSITIVE_INFINITY), FULL_MOTION)
  assert.equal(on(Number.POSITIVE_INFINITY), '1111111')
  assert.equal(on(20), '1111111')
  assert.equal(on(10), '1111111')
  assert.equal(on(9.99), '1110001')
  assert.equal(on(5), '1110001')
  assert.equal(on(4.99), '0000001')
  assert.equal(on(4), '0000001')
  assert.equal(on(3.99), '0000000')
  assert.equal(on(0.5), '0000000')
  // A pulse is held for at least one frame at the cap, never shorter than its own window.
  assert.equal(motionFor(8).pulseHoldMs, 125)
  assert.equal(motionFor(2).pulseHoldMs, 500)
  assert.equal(FULL_MOTION.pulseHoldMs, 0)
})

test('a degraded frame asks only for what still moves: steady glows need only the tick', () => {
  const s = five()
  assert.equal(fps(s, emptyView(), FIVE_AT.idle), FPS.glow)
  const clashes = fileClashes(s, FIVE_AT.idle)
  const stats: Record<string, AgentStats> = {}
  for (const id of Object.keys(s.agents)) stats[id] = agentStats(s, id, FIVE_AT.idle, clashes)!
  assert.equal(targetFps(s, emptyView(), FIVE_AT.idle, stats, clashes, motionFor(4.9)), FPS.tick)
  assert.equal(render(s, emptyView(), FIVE_AT.idle, FULL, {}, 4.9).fps, FPS.tick)
  const quiet = foldAll(FIVE_SWARM, quietEvents())
  const glide = { ...emptyView(), tween: { from: {}, at: FIVE_AT.idle - 100 } }
  assert.equal(render(quiet, glide, FIVE_AT.idle, FULL, {}, 9.9).fps, FPS.tick)
  assert.equal(render(quiet, glide, FIVE_AT.idle, FULL, {}, 10).fps, FPS.busy)
})

test('with no cap given, or an infinite one, the frame is the full-motion frame', () => {
  const s = five()
  const a = render(s, emptyView(), FIVE_AT.mid, FULL)
  const b = render(s, emptyView(), FIVE_AT.mid, FULL, {}, Number.POSITIVE_INFINITY)
  assert.equal(a.top.encode(), b.top.encode())
})

test('under 5 fps breathing, stuck rims and the clash blink hold steady', () => {
  const s = five()
  const view = { ...emptyView(), pulses: pulsesFrom(fiveAgentEvents()) }
  // full-idle: three agents glow. Half a breath apart the graph differs at full motion and not when degraded.
  const graph = (now: number, cap?: number) => render(s, view, now, FULL, {}, cap).top.encode()
  assert.notEqual(graph(FIVE_AT.idle), graph(FIVE_AT.idle + 1000))
  assert.equal(graph(FIVE_AT.idle, 4.9), graph(FIVE_AT.idle + 1000, 4.9))
  assert.notEqual(graph(FIVE_AT.idle, 4.9), graph(FIVE_AT.idle, 5))
})

test('under 4 fps comets give way to the lit link; at 4 they still fly', () => {
  const s = five()
  const comet = (cap: number) => {
    const g = render(s, emptyView(), FIVE_AT.mid, FULL, {}, cap).top
    let n = 0
    for (let y = 0; y < g.rows; y++) for (let x = 0; x < g.columns; x++) if (g.fg(x, y) === LINK.comet) n++
    return n
  }
  assert.ok(comet(4) > 0)
  assert.equal(comet(3.9), 0)
})

test('under 10 fps a pulse is drawn at full strength, not part-faded', () => {
  const s = foldAll(FIVE_SWARM, quietEvents())
  const pulse = (age: number) => ({ ...emptyView(), pulses: [{ agent: 'a-arch', kind: 'edit' as const, at: FIVE_AT.idle - age, isError: false }] })
  const top = (age: number, cap?: number) => render(s, pulse(age), FIVE_AT.idle, FULL, {}, cap).top.encode()
  assert.notEqual(top(0), top(300))
  assert.equal(top(0, 9.9), top(300, 9.9))
  assert.equal(top(0, 9.9), top(0))
  // Held for one frame at the cap when that is longer than its own 450 ms window: at 2 fps, 500 ms.
  assert.equal(top(400, 2), top(0, 2))
  assert.notEqual(top(460, 9.9), top(0, 9.9))
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

test('a swarm with warned and nudged agents stays inside the pair budget too', () => {
  // pane.md 13.6: the drop adds one or two colours per node.
  const evs = [...fiveAgentEvents(), ev('guard.warned', { limit: 'time', value: 21, threshold: 20 }, { agent: 'a-cod1', atSec: 5 }), ev('guard.nudged', { limit: 'time', value: 31, threshold: 30, delivered: true }, { agent: 'a-arch', atSec: 5 })]
  const s = foldAll(FIVE_SWARM, evs)
  for (const style of ['globe', 'robot'] as const) {
    const f = render(s, { ...emptyView(), style }, FIVE_AT.idle, FULL)
    assert.ok(pairCount(f.top) <= PAIR_BUDGET.top)
    assert.ok(pairCount(f.bottom!) <= PAIR_BUDGET.bottom)
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
