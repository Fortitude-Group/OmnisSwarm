import { test } from 'node:test'
import assert from 'node:assert/strict'
import { arc, blink, comet, easeInOut, fadeIn, flash, ghost, glow, hashUnit, lerpPoint, tween } from '../../src/render/fx.ts'
import { MOTION } from '../../src/render/tokens.ts'

test('fadeIn and ghost run from 0 to 1 over their durations', () => {
  assert.equal(fadeIn(0, 0), 0)
  assert.equal(fadeIn(0, -100), 0)
  assert.equal(fadeIn(0, MOTION.fadeInMs), 1)
  const mid = fadeIn(0, MOTION.fadeInMs / 2)
  assert.ok(mid > 0.5 && mid < 1)
  assert.equal(ghost(null, 99), 0)
  assert.equal(ghost(0, MOTION.ghostMs / 2), 0.5)
  assert.equal(ghost(0, MOTION.ghostMs * 3), 1)
})

test('glow stays in 0..1 and repeats every period', () => {
  for (let t = 0; t < 4000; t += 97) {
    const g = glow(t, 0.3)
    assert.ok(g >= 0 && g <= 1)
  }
  assert.ok(Math.abs(glow(0, 0) - glow(MOTION.glowPeriodMs, 0)) < 1e-9)
})

test('flash falls from 1 to 0 and is 0 before it starts; blink alternates', () => {
  assert.equal(flash(0, 0, 100), 1)
  assert.equal(flash(0, 50, 100), 0.5)
  assert.equal(flash(0, 150, 100), 0)
  assert.equal(flash(100, 50, 100), 0)
  assert.equal(blink(0, 250), true)
  assert.equal(blink(260, 250), false)
})

test('a comet starts at the sender, is halfway at half time, leaves a fading trail, then is gone', () => {
  const path = (t: number) => lerpPoint({ x: 0, y: 0 }, { x: 100, y: 0 }, t)
  assert.deepEqual(comet(path, 0, 0)[0], { p: { x: 0, y: 0 }, k: 1 })
  const half = comet(path, 0, MOTION.cometMs / 2)
  assert.equal(half[0]!.k, 1)
  assert.ok(Math.abs(half[0]!.p.x - 50) < 1e-9)
  assert.ok(half.length > 1)
  for (let i = 1; i < half.length; i++) assert.ok(half[i]!.k < half[i - 1]!.k && half[i]!.p.x < half[i - 1]!.p.x)
  const landed = comet(path, 0, MOTION.cometMs + 10)
  assert.ok(landed.length > 0 && landed.every(s => s.k < 1))
  assert.deepEqual(comet(path, 0, MOTION.cometMs + MOTION.trailMs + 1), [])
  assert.deepEqual(comet(path, 100, 0), [])
})

test('an arc runs from a to b, bowed to the left of travel; the reverse bows the other way', () => {
  const a = { x: 0, y: 0 }
  const b = { x: 100, y: 0 }
  assert.deepEqual(arc(a, b, 0.25)(0), a)
  assert.deepEqual(arc(a, b, 0.25)(1), b)
  assert.deepEqual(arc(a, b, 0.25)(0.5), { x: 50, y: 12.5 })
  assert.deepEqual(arc(b, a, 0.25)(0.5), { x: 50, y: -12.5 })
  assert.deepEqual(arc(a, b, 0)(0.5), { x: 50, y: 0 })
})

test('easeInOut, hashUnit and lerpPoint', () => {
  assert.equal(easeInOut(0.5), 0.5)
  assert.equal(hashUnit('a-arch'), hashUnit('a-arch'))
  assert.ok(hashUnit('x') >= 0 && hashUnit('x') < 1)
  assert.notEqual(hashUnit('a'), hashUnit('b'))
  assert.deepEqual(lerpPoint({ x: 0, y: 10 }, { x: 10, y: 20 }, 0.5), { x: 5, y: 15 })
})

test('tween glides from the old positions to the new ones', () => {
  const target = { a: { x: 10, y: 10 }, b: { x: 0, y: 0 } }
  assert.deepEqual(tween(target, null, 0), target)
  const t = { from: { a: { x: 0, y: 0 } }, at: 1000 }
  assert.deepEqual(tween(target, t, 1000).a, { x: 0, y: 0 })
  assert.deepEqual(tween(target, t, 1000).b, { x: 0, y: 0 })
  assert.deepEqual(tween(target, t, 1000 + MOTION.tweenMs).a, { x: 10, y: 10 })
  const mid = tween(target, t, 1000 + MOTION.tweenMs / 2).a!
  assert.ok(mid.x > 5 && mid.x < 10)
})
