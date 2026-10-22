import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldAll, LEAD } from '../../src/core/fold.ts'
import { dripPixels, dropsFor, flashColour, globeDrops, guardFlash, spriteDrops } from '../../src/render/guard-badge.ts'
import { render } from '../../src/render/frame.ts'
import { ROBOT_SKINS } from '../../src/render/sprites.ts'
import { GUARD, KIND, MOTION, CANVAS } from '../../src/render/tokens.ts'
import { emptyView, rect, type Pulse } from '../../src/render/types.ts'
import { Pixels } from '../../src/render/canvas.ts'
import { mix } from '../../src/render/color.ts'
import { FULL_MOTION } from '../../src/render/fx.ts'
import { boxAt, paintRobot, robotLook } from '../../src/render/robot.ts'
import { solidCells, type Node } from '../../src/render/graph.ts'
import { busiest } from '../../src/render/spotlight.ts'
import type { RobotSize } from '../../src/render/sprites.ts'
import { FIVE_AT, FIVE_SWARM, fiveAgentEvents } from '../fixtures/swarm-five.ts'
import { nowForSlot, sheetCell } from './robot-sheet.ts'
import type { SwarmEvent } from '../../src/core/events.ts'
import { at, ev } from '../helpers.ts'

const clawd = ROBOT_SKINS.clawd!.sprites
const start = ev('agent.started', { name: 'coder-b', role: 'coder', description: '', parent: LEAD }, { agent: 'a1', atSec: 1 })
const warned: SwarmEvent[] = [start, ev('guard.warned', { limit: 'time', value: 21, threshold: 20 }, { agent: 'a1', atSec: 2 })]
const nudged: SwarmEvent[] = [...warned, ev('guard.nudged', { limit: 'time', value: 31, threshold: 30, delivered: true }, { agent: 'a1', atSec: 3 })]
const done: SwarmEvent[] = [...nudged, ev('agent.finished', { outcome: 'answer' }, { agent: 'a1', atSec: 4 })]

test('one drop when warned, two when nudged, none once done', () => {
  assert.equal(dropsFor(foldAll('s1', [start]).agents.a1!), 0)
  assert.equal(dropsFor(foldAll('s1', warned).agents.a1!), 1)
  assert.equal(dropsFor(foldAll('s1', nudged).agents.a1!), 2)
  assert.equal(dropsFor(foldAll('s1', done).agents.a1!), 0)
})

test('clawd drop pixels match §13.2, the nudged copy mirrored', () => {
  assert.deepEqual(spriteDrops(clawd.S, 1), [[7, 0], [7, 1]])
  assert.deepEqual(spriteDrops(clawd.M, 1), [[9, 0], [8, 1], [9, 1]])
  assert.deepEqual(spriteDrops(clawd.L, 1), [[11, 0], [10, 1], [11, 1], [10, 2], [11, 2]])
  assert.deepEqual(spriteDrops(clawd.M, 2), [[9, 0], [8, 1], [9, 1], [1, 0], [2, 1], [1, 1]])
  assert.deepEqual(spriteDrops(clawd.M, 0), [])
})

test('the drip runs in hop slots 2-4 down body.x1, M and L only, both sides when nudged', () => {
  const m = clawd.M
  assert.deepEqual(dripPixels(m, 'M', 1, 1), [])
  assert.deepEqual(dripPixels(m, 'M', 1, 2), [[m.body[2], 2]])
  assert.deepEqual(dripPixels(m, 'M', 1, 4), [[m.body[2], 4]])
  assert.deepEqual(dripPixels(m, 'M', 1, 5), [])
  assert.deepEqual(dripPixels(m, 'M', 2, 3), [[m.body[2], 3], [m.body[0], 3]])
  assert.deepEqual(dripPixels(clawd.S, 'S', 1, 3), [])
})

test('the globe drop sits outside the ring at one o-clock; a small globe gets two pixels', () => {
  const p = { x: 40, y: 20 }
  const k = 5.5 * Math.SQRT1_2
  const a = { x: Math.round(40 + k), y: Math.round(20 - k) + 1 }
  assert.deepEqual(globeDrops(p, 3, 1, 1), [[a.x + 1, a.y - 2], [a.x, a.y - 1], [a.x + 1, a.y - 1]])
  assert.equal(globeDrops(p, 2, 1, 1).length, 2)
  const both = globeDrops(p, 3, 1, 2)
  assert.equal(both.length, 6)
  assert.ok(both.slice(3).every(([x]) => x < p.x), 'the second drop is at eleven o-clock')
})

test('the flash: white, drop, white over 450 ms; nothing after', () => {
  assert.equal(GUARD.flashMs, MOTION.pulseMs)
  const pulse = { agent: 'a1', kind: 'other' as const, at: 1_000, isError: false, guard: true as const }
  assert.equal(flashColour([pulse], 'a1', 1_050), 0xffffff)
  assert.equal(flashColour([pulse], 'a1', 1_225), GUARD.drop)
  assert.equal(flashColour([pulse], 'a1', 1_500), null)
  assert.equal(flashColour([pulse], 'a2', 1_050), null)
})

const colours = (events: SwarmEvent[], style: 'globe' | 'robot'): Set<number> => {
  const f = render(foldAll('s1', events), { ...emptyView(), style }, at(5), { columns: 120, rows: 44 })
  const out = new Set<number>()
  for (let y = 0; y < f.top.rows; y++) for (let x = 0; x < f.top.columns; x++) out.add(f.top.fg(x, y)).add(f.top.bg(x, y))
  return out
}

for (const style of ['globe', 'robot'] as const) {
  test(`a warned ${style} shows GUARD.drop; an unwarned or finished one does not`, () => {
    assert.equal(colours([start], style).has(GUARD.drop), false)
    assert.equal(colours(warned, style).has(GUARD.drop), true)
    assert.equal(colours(done, style).has(GUARD.drop), false)
  })
}

// A robot painted by robotLook and paintRobot, as the graph does, with the sprite origin worked out from the look.
function robotAt(size: RobotSize, drops: 1 | 2, o: { slot?: number; motion?: typeof FULL_MOTION; still?: boolean; wave?: boolean; flash?: number | null } = {}) {
  const c = sheetCell('running', size)
  const guard = { timeWarn: 20, timeAct: drops === 2 ? 30 : null, costWarn: null, costAct: null }
  const look = robotLook({
    ...c, a: { ...c.a, guard }, now: nowForSlot(c.id, o.slot ?? 0), motion: o.motion ?? FULL_MOTION, still: o.still ?? false,
    pulse: o.wave === true ? { wave: 3, kind: 'edit', error: 0 } : undefined, flash: o.flash ?? null,
  })
  const px = new Pixels(40, 40, CANVAS)
  const box = boxAt({ x: 20, y: 20 }, size)
  paintRobot(px, box, look)
  const s = ROBOT_SKINS.clawd!.sprites[size]
  const sx = box.left
  const sy = box.top + (size === 'S' ? 1 : 2) - look.lift
  return { look, at: (x: number, y: number): number => px.get(sx + x, sy + y), s }
}

test('at S the raised arm wins over the drop pixel at (7, 1); the other pixel stays', () => {
  const r = robotAt('S', 1, { wave: true })
  assert.equal(r.look.arms, 'up')
  assert.equal(r.at(7, 1), KIND.edit)
  assert.equal(r.at(7, 0), GUARD.drop)
  assert.equal(robotAt('S', 1).at(7, 1), GUARD.drop)
})

test('the drip is mix(body, drop, dripMix) in slots 2-4 at M and L, on the nudged side too, and absent at S', () => {
  for (const size of ['M', 'L'] as const) {
    const w = ROBOT_SKINS.clawd!.sprites[size]
    const dropBottom = Math.max(...w.sweat.map(([, y]) => y))
    for (const slot of [2, 3, 4]) {
      const r = robotAt(size, 2, { slot })
      const y = dropBottom + slot - 1
      if (y > w.body[3]) continue
      const drip = mix(r.look.body, GUARD.drop, GUARD.dripMix)
      assert.equal(r.at(w.body[2], y), drip, `${size} slot ${slot} right`)
      assert.equal(r.at(w.body[0], y), drip, `${size} slot ${slot} left`)
      assert.equal(robotAt(size, 1, { slot }).at(w.body[0], y), r.look.body, 'a warned robot drips on one side only')
    }
    for (const slot of [0, 1, 5, 9]) assert.equal(robotAt(size, 1, { slot }).look.drop.slot, slot)
    const none = robotAt(size, 1, { slot: 5 })
    assert.equal(none.at(w.body[2], dropBottom + 1), none.look.body, `${size} slot 5 has no drip`)
  }
  const s = robotAt('S', 1, { slot: 3 })
  assert.equal(s.at(6, 3), s.look.body)
})

test('no drip when breathing is off or the frame is still; a still frame has no flash either', () => {
  assert.equal(robotAt('M', 1, { slot: 3, motion: { ...FULL_MOTION, breathe: false } }).look.drop.slot, -1)
  const still = robotAt('M', 1, { slot: 3, still: true, flash: 0xffffff })
  assert.equal(still.look.drop.slot, -1)
  assert.equal(still.look.drop.color, GUARD.drop)
  assert.equal(still.at(9, 0), GUARD.drop)
  assert.equal(robotAt('M', 1, { flash: 0xffffff }).at(9, 0), 0xffffff)
})

test('the drop rides the hop: it sits at the sprite, whatever the lift', () => {
  for (const size of ['S', 'M', 'L'] as const) {
    const low = robotAt(size, 1, { slot: 0 })
    const high = robotAt(size, 1, { slot: 7 })
    assert.ok(high.look.lift > low.look.lift)
    const [x, y] = low.s.sweat[0]!
    assert.equal(low.at(x, y), GUARD.drop)
    assert.equal(high.at(x, y), GUARD.drop)
  }
})

test('guardFlash: faded flash with fade on; one held white frame with fade off', () => {
  const pulse: Pulse = { agent: 'a1', kind: 'other', at: 1_000, isError: false, guard: true }
  assert.equal(guardFlash([pulse], 'a1', 1_225, FULL_MOTION), GUARD.drop)
  const held = { ...FULL_MOTION, pulseFade: false, pulseHoldMs: 800 }
  assert.equal(guardFlash([pulse], 'a1', 1_225, held), 0xffffff)
  assert.equal(guardFlash([pulse], 'a1', 1_799, held), 0xffffff)
  assert.equal(guardFlash([pulse], 'a1', 1_800, held), null)
  // Never shorter than flashMs (matches robotPulses).
  assert.equal(guardFlash([pulse], 'a1', 1_449, { ...held, pulseHoldMs: 0 }), 0xffffff)
  assert.equal(guardFlash([pulse], 'a1', 1_450, { ...held, pulseHoldMs: 0 }), null)
})

test('the nudged globe drops are the first drop mirrored about the node', () => {
  const p = { x: 40, y: 20 }
  const one = globeDrops(p, 3, 1, 1)
  assert.deepEqual(globeDrops(p, 3, 1, 2), [...one, ...one.map(([x, y]) => [80 - x, y])])
})

test('a globe drop keeps labels clear of its cells', () => {
  const c = sheetCell('running', 'M')
  const node = (guard: boolean): Node => ({ id: c.id, p: { x: 40, y: 20 }, r: 3, fill: 0, s: c.s, a: { ...c.a, guard: guard ? { timeWarn: 20, timeAct: null, costWarn: null, costAct: null } : undefined } })
  const area = rect(0, 0, 80, 20)
  const cell = (n: Node): number => solidCells(area, [n])[7 * area.w + 45]!
  assert.equal(cell(node(false)), 0)
  assert.equal(cell(node(true)), 1)
})

test('guard pulses do not move the spotlight', () => {
  const s = foldAll(FIVE_SWARM, fiveAgentEvents())
  const guard: Pulse[] = Array.from({ length: 100 }, () => ({ agent: 'a-test', kind: 'other', at: FIVE_AT.mid - 1000, isError: false, guard: true }))
  assert.equal(busiest(s, guard, FIVE_AT.mid), busiest(s, [], FIVE_AT.mid))
})

const failed: SwarmEvent[] = [...warned, ev('agent.finished', { outcome: 'failed' }, { agent: 'a1', atSec: 4 })]
for (const style of ['globe', 'robot'] as const) {
  test(`a failed ${style} shows no drop; a warned one that is waiting keeps it`, () => {
    assert.equal(dropsFor(foldAll('s1', failed).agents.a1!), 0)
    assert.equal(colours(failed, style).has(GUARD.drop), false)
    const waiting = render(foldAll('s1', warned), { ...emptyView(), style }, at(600), { columns: 120, rows: 44 })
    const out = new Set<number>()
    for (let y = 0; y < waiting.top.rows; y++) for (let x = 0; x < waiting.top.columns; x++) out.add(waiting.top.fg(x, y)).add(waiting.top.bg(x, y))
    assert.equal(out.has(GUARD.drop), true)
    assert.equal(dropsFor(foldAll('s1', warned).agents.a1!), 1)
  })
}
