import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contrast, desaturate, mix, scale } from '../../src/render/color.ts'
import { ROBOT, ROBOT_SIZES, ROBOT_SKINS, composite, type SkinSprite } from '../../src/render/sprites.ts'
import { CANVAS } from '../../src/render/tokens.ts'

// pane.md 12.4: the checks every skin in ROBOT_SKINS must pass, so a broken skin fails the build, not the pane.

/** sRGB to OKLab after a Machado (severity 1) colour-vision simulation, as section 3 measures. */
const lin = (c: number): number => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
const VISION: Record<string, number[][]> = {
  normal: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
}
function oklab(c: number, m: number[][]): number[] {
  const v = [lin((c >> 16) & 255), lin((c >> 8) & 255), lin(c & 255)]
  const [r, g, b] = m.map(row => Math.max(0, Math.min(1, row[0]! * v[0]! + row[1]! * v[1]! + row[2]! * v[2]!))) as [number, number, number]
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const mm = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [0.2104542553 * l + 0.793617785 * mm - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * mm + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * mm - 0.808675766 * s]
}
const distance = (a: number, b: number, m: number[][]): number => { const p = oklab(a, m); const q = oklab(b, m); return 100 * Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!) }

const LETTERS = new Set([...'.BEALDH'])
const variants = (s: SkinSprite): [string, readonly string[]][] => [
  ['eyes.open', s.eyes.open], ['eyes.closed', s.eyes.closed], ...(s.eyes.cross === undefined ? [] : [['eyes.cross', s.eyes.cross] as [string, readonly string[]]]),
  ['arms.down', s.arms.down], ['arms.up', s.arms.up],
]

for (const [name, skin] of Object.entries(ROBOT_SKINS)) {
  for (const size of ROBOT_SIZES) {
    test(`skin ${name} at ${size} passes the skin checks`, () => {
      const s = skin.sprites[size]
      const limit = ROBOT.size[size]
      assert.ok(s.w <= limit.maxW && s.h <= limit.maxH, `${s.w}x${s.h} is within ${limit.maxW}x${limit.maxH}`)
      assert.ok(s.haloRows < s.h)
      const [x0, y0, x1, y1] = s.body
      assert.ok(x0 >= 0 && y0 >= 0 && x1 < s.w && y1 < s.h && x0 <= x1 && y0 <= y1, 'body inside the sprite')
      for (const [label, rows] of variants(s)) {
        assert.equal(rows.length, s.h, `${label} has ${s.h} rows`)
        rows.forEach((row, y) => {
          assert.equal([...row].length, s.w, `${label} row ${y} is ${s.w} wide`)
          ;[...row].forEach((ch, x) => {
            assert.ok(LETTERS.has(ch), `${label} uses only the bitmap letters, not ${ch}`)
            if (ch === 'E') assert.ok(x >= x0 && x <= x1 && y >= y0 && y <= y1, `${label} eye at ${x},${y} lies inside body`)
          })
        })
      }
      for (const [label, rows] of [['arms.up', s.arms.up], ['arms.down', s.arms.down]] as const) {
        rows.forEach((row, y) => [...row].forEach((ch, x) => {
          const open = s.eyes.open[y]![x]!
          if (ch !== 'A' && open !== 'A') assert.equal(ch, open, `${label} matches eyes.open at ${x},${y}`)
        }))
      }
      assert.notDeepEqual(s.eyes.closed, s.eyes.open, 'eyes.closed differs from eyes.open')
      if (s.eyes.cross !== undefined) assert.notDeepEqual(s.eyes.cross, s.eyes.open, 'eyes.cross differs from eyes.open')
    })
  }

  test(`skin ${name}: body colour contrast and distance from the dead grey`, () => {
    const body = skin.bodyColor
    const waiting = scale(body, 0.72)
    const ghost = mix(body, mix(desaturate(body, 0.7), CANVAS, 0.55), 1)
    assert.ok(contrast(body, CANVAS) >= 4.5, 'body on the canvas')
    assert.ok(contrast(CANVAS, body) >= 3 && contrast(CANVAS, waiting) >= 3, 'canvas eyes on the body and its waiting tone')
    for (const [vision, m] of Object.entries(VISION)) {
      assert.ok(distance(body, ROBOT.dead, m) >= 9, `body vs dead under ${vision}`)
      assert.ok(distance(ghost, ROBOT.dead, m) >= 9, `done ghost vs dead under ${vision}`)
    }
  })
}

test('the active skin exists and clawd matches pane.md 12.4', () => {
  assert.ok(Object.hasOwn(ROBOT_SKINS, ROBOT.skin))
  const clawd = ROBOT_SKINS.clawd!
  assert.equal(clawd.bodyColor, 0xd77757)
  assert.equal(ROBOT.dead, 0x2a2e36)
  const table = { S: [8, 5, [1, 0, 6, 3], 3, false], M: [11, 6, [1, 0, 9, 4], 4, true], L: [13, 7, [1, 0, 11, 5], 5, true] } as const
  for (const size of ROBOT_SIZES) {
    const s = clawd.sprites[size]
    const [w, h, body, haloRows, cross] = table[size]
    assert.deepEqual([s.w, s.h, s.body, s.haloRows, s.eyes.cross !== undefined], [w, h, body, haloRows, cross], size)
    assert.deepEqual(s.arms.down, s.eyes.open, `${size}: arms.down is eyes.open`)
  }
})

test('compositing takes the eye variant, clears its arms and sets the arm variant\'s arms', () => {
  const m = ROBOT_SKINS.clawd!.sprites.M
  assert.deepEqual(composite(m, 'open', 'down'), m.eyes.open)
  assert.deepEqual(composite(m, 'cross', 'up'), [
    'ABBBBBBBBBA',
    'ABEBBBBBEBA',
    '.BBEBBBEBB.',
    '.BEBBBBBEB.',
    '.BBBBBBBBB.',
    '.L.L...L.L.',
  ])
  // With no cross, the open eyes stand in.
  const s = ROBOT_SKINS.clawd!.sprites.S
  assert.deepEqual(composite(s, 'cross', 'down'), s.eyes.open)
})
