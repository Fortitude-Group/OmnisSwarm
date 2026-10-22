import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldAll, LEAD } from '../../src/core/fold.ts'
import { dripPixels, dropsFor, flashColour, globeDrops, spriteDrops } from '../../src/render/guard-badge.ts'
import { render } from '../../src/render/frame.ts'
import { ROBOT_SKINS } from '../../src/render/sprites.ts'
import { GUARD, MOTION } from '../../src/render/tokens.ts'
import { emptyView } from '../../src/render/types.ts'
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
