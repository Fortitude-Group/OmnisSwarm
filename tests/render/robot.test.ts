import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { foldAll } from '../../src/core/fold.ts'
import { pulsesFrom } from '../../src/mod/pane-model.ts'
import { Pixels } from '../../src/render/canvas.ts'
import { render } from '../../src/render/frame.ts'
import { FULL_MOTION, motionFor } from '../../src/render/fx.ts'
import { pairCount } from '../../src/render/grid.ts'
import { anyOverlap, blinkClosed, boxAt, fitBoxes, nextBlinkAt, paintRobot, robotCrowded, robotPulses } from '../../src/render/robot.ts'
import { ROBOT, activeSkin } from '../../src/render/sprites.ts'
import { CANVAS, KIND, LINK, MODEL, STATUS } from '../../src/render/tokens.ts'
import { emptyView } from '../../src/render/types.ts'
import { FIVE_AT, FIVE_SWARM, fiveAgentEvents } from '../fixtures/swarm-five.ts'
import { GOLDEN_CASES, goldenFrame } from './golden-cases.ts'
import { SHEET_SIZES, SHEET_STATES, lookOf, sheetCell, type SheetState } from './robot-sheet.ts'

/** The bitmap a state should show, built straight from the skin's variants (pane.md 12.4 and 12.5). */
const EXPECT: Record<SheetState, { eyes: 'open' | 'closed' | 'cross'; arms: 'down' | 'up'; lift: 'ground' | 'top' | 1 }> = {
  running: { eyes: 'open', arms: 'down', lift: 'ground' }, 'hop-top': { eyes: 'open', arms: 'down', lift: 'top' },
  'wave-up': { eyes: 'open', arms: 'up', lift: 'ground' }, 'wave-down': { eyes: 'open', arms: 'down', lift: 'ground' },
  'error-red': { eyes: 'cross', arms: 'down', lift: 'ground' }, 'error-off': { eyes: 'cross', arms: 'down', lift: 'ground' },
  waiting: { eyes: 'open', arms: 'down', lift: 'ground' }, blink: { eyes: 'closed', arms: 'down', lift: 'ground' },
  done: { eyes: 'closed', arms: 'down', lift: 'ground' }, failed: { eyes: 'cross', arms: 'down', lift: 'ground' },
  stuck: { eyes: 'open', arms: 'down', lift: 'ground' }, clash: { eyes: 'open', arms: 'down', lift: 'ground' },
  placeholder: { eyes: 'closed', arms: 'down', lift: 'ground' }, degraded: { eyes: 'open', arms: 'down', lift: 1 }, still: { eyes: 'open', arms: 'down', lift: 1 },
}

for (const size of SHEET_SIZES) {
  for (const state of SHEET_STATES) {
    test(`robot ${size} ${state} matches the skin's bitmaps pixel for pixel`, () => {
      const c = sheetCell(state, size)
      const look = lookOf(c)
      const sprite = activeSkin().sprites[c.size]
      const want = EXPECT[state]
      const eyeRows = want.eyes === 'closed' ? sprite.eyes.closed : want.eyes === 'cross' ? (sprite.eyes.cross ?? sprite.eyes.open) : sprite.eyes.open
      const armRows = want.arms === 'up' ? sprite.arms.up : sprite.arms.down
      const range = ROBOT.size[c.size]
      const lift = want.lift === 'ground' ? 0 : want.lift === 'top' ? Math.max(...range.hop) : 1
      assert.equal(look.lift, lift, 'lift')
      const px = new Pixels(40, 30, CANVAS)
      const box = boxAt({ x: 20, y: 15 }, c.size)
      paintRobot(px, box, look)
      for (let y = 0; y < sprite.h; y++) {
        for (let x = 0; x < sprite.w; x++) {
          const ch = armRows[y]![x] === 'A' ? 'A' : eyeRows[y]![x] === 'A' ? '.' : eyeRows[y]![x]!
          const got = px.get(box.left + x, box.top + range.headroom - lift + y)
          if (ch === '.') assert.notEqual(got, look.body, `${x},${y} is clear`)
          else assert.equal(got, ch === 'E' ? look.eye : ch === 'A' ? (look.armColor ?? look.body) : look.body, `${x},${y} is ${ch}`)
        }
      }
    })
  }
}

test('state colours: no robot body is ever red; failed is dead grey with red eyes and glow; an error flashes glow and outline', () => {
  for (const size of SHEET_SIZES) {
    for (const state of SHEET_STATES) assert.notEqual(lookOf(sheetCell(state, size)).body, STATUS.failed, `${size} ${state}`)
    const failed = lookOf(sheetCell('failed', size))
    assert.deepEqual([failed.body, failed.eye, failed.glow], [ROBOT.dead, STATUS.failed, { color: STATUS.failed, k: 0.7 }])
    const running = lookOf(sheetCell('running', size))
    const red = lookOf(sheetCell('error-red', size))
    const off = lookOf(sheetCell('error-off', size))
    assert.equal(red.body, running.body)
    assert.deepEqual([red.glow, red.outline, red.eye], [{ color: STATUS.failed, k: 1 }, { color: STATUS.failed, k: 0.9 }, CANVAS])
    assert.equal(off.outline, null)
    assert.equal(off.glow?.color, MODEL.sonnet)
    assert.deepEqual(lookOf(sheetCell('clash', size)).outline, { color: LINK.clash, k: 0.9 })
    assert.equal(lookOf(sheetCell('stuck', size)).outline?.color, STATUS.warn)
  }
})

test('the glow and the bar carry the model colour, so the chip dot keys to them', () => {
  const look = lookOf(sheetCell('running', 'M'))
  assert.equal(look.glow?.color, MODEL.sonnet)
  assert.equal(look.bar?.tone, MODEL.sonnet)
  assert.equal(lookOf(sheetCell('waiting', 'M')).glow, null)
  assert.equal(lookOf(sheetCell('placeholder', 'M')).bar, null)
})

test('a tool wave on a haiku robot with an edit carries by shape: the arms go up, in the edit colour', () => {
  const c = sheetCell('wave-up', 'L')
  const look = lookOf({ ...c, s: { ...c.s, model: 'claude-haiku-5-5' } })
  assert.deepEqual([look.arms, look.armColor, look.glow?.color], ['up', KIND.edit, MODEL.haiku])
  const during = lookOf({ ...c, pulse: { wave: 3, kind: 'edit', error: 4 } })
  assert.deepEqual([during.arms, during.armColor], ['up', null], 'while an error is live the arms are body colour, in the wave position')
})

test('degraded or still, a running robot holds at lift 1 with a steady halo; still frames show no pulses', () => {
  for (const size of SHEET_SIZES) {
    const degraded = lookOf(sheetCell('degraded', size))
    assert.deepEqual([degraded.lift, degraded.glow?.k], [1, 0.7])
    const still = lookOf({ ...sheetCell('error-red', size), still: true })
    assert.deepEqual([still.lift, still.glow?.k, still.outline, still.eyes], [1, 0.7, null, 'open'])
  }
})

test('pulses step down through their window: a wave in 3 steps of 150 ms, an error in 4 of 225 ms', () => {
  const view = { ...emptyView(), pulses: [{ agent: 'a', kind: 'edit' as const, at: 0, isError: false }, { agent: 'b', kind: 'bash' as const, at: 0, isError: true }] }
  const at = (t: number) => { const m = robotPulses(view, t, FULL_MOTION); return [m.get('a')?.wave ?? 0, m.get('b')?.error ?? 0] }
  assert.deepEqual([0, 100, 200, 300, 449, 450].map(t => at(t)[0]), [3, 3, 2, 1, 1, 0])
  assert.deepEqual([0, 200, 300, 500, 700, 899, 900].map(t => at(t)[1]), [4, 4, 3, 2, 1, 1, 0])
  const held = robotPulses(view, 600, motionFor(4))
  assert.deepEqual([held.get('a'), held.get('b')?.error], [undefined, 4])
  assert.equal(robotPulses(view, 200, motionFor(4)).get('a')?.wave, 3, 'degraded, a wave is held arms up')
})

test('a waiting robot blinks for 200 ms in every 6 s, and the loop is told when each blink starts and ends', () => {
  const swarm = foldAll(FIVE_SWARM, fiveAgentEvents())
  const s = { ...sheetCell('waiting', 'M').s, id: 'w' }
  const now = 1_000_000
  const next = nextBlinkAt({ w: s }, now)!
  assert.ok(next > now && next <= now + 6000)
  assert.notEqual(blinkClosed('w', next - 1), blinkClosed('w', next + 1))
  assert.equal(nextBlinkAt({ w: { ...s, status: 'running' } }, now), null)
  // In a frame: robots ask for the blink frames, globes never do.
  const view = { ...emptyView(), style: 'robot' as const }
  const waiting = { ...swarm, agents: { ...swarm.agents, 'a-arch': { ...swarm.agents['a-arch']!, finishedAt: null } } }
  assert.equal(render(waiting, { ...emptyView() }, FIVE_AT.idle, { columns: 120, rows: 44 }).wakeAt, undefined)
  const f = render(waiting, view, FIVE_AT.idle, { columns: 120, rows: 44 })
  assert.ok(f.wakeAt === undefined || (f.wakeAt > FIVE_AT.idle && f.wakeAt <= FIVE_AT.idle + 6000))
})

test('sizes step down graph-wide until no two boxes overlap, then at the canvas edges', () => {
  const near = [{ id: 'a', p: { x: 20, y: 20 }, r: 5, placeholder: false }, { id: 'b', p: { x: 34, y: 20 }, r: 5, placeholder: false }]
  const both = fitBoxes(near, 200, 100)
  assert.deepEqual([both.get('a')!.size, both.get('b')!.size], ['M', 'M'], 'L boxes 14 apart overlap when grown, M ones do not')
  const far = fitBoxes([{ ...near[0]!, p: { x: 20, y: 20 } }, { ...near[1]!, p: { x: 60, y: 20 } }], 200, 100)
  assert.equal(far.get('a')!.size, 'L')
  assert.equal(fitBoxes([{ id: 'e', p: { x: 4, y: 20 }, r: 5, placeholder: false }], 200, 100).get('e')!.size, 'S', 'stepped down at the left edge')
  assert.equal(fitBoxes([{ id: 'p', p: { x: 50, y: 20 }, r: 5, placeholder: true }], 200, 100).get('p')!.size, 'S', 'placeholders are always S')
  // Grown by 1 px: boxes need two clear pixels between them.
  const s = (x: number) => boxAt({ x, y: 10 }, 'S')
  assert.equal(anyOverlap([s(10), s(19)]), true)
  assert.equal(anyOverlap([s(10), s(20)]), false)
  assert.equal(robotCrowded({ a: { x: 10, y: 10 }, b: { x: 19, y: 10 } }), true)
})

test('in robot style a crowded graph shows the tree, and labels sit one row under the box whatever the hop', () => {
  const swarm = foldAll(FIVE_SWARM, fiveAgentEvents())
  const view = { ...emptyView(), style: 'robot' as const, pulses: pulsesFrom(fiveAgentEvents()) }
  const rows = (now: number) => {
    const f = render(swarm, view, now, { columns: 120, rows: 44 })
    const text = Array.from({ length: f.top.rows }, (_, y) => Array.from({ length: f.top.columns }, (_, x) => String.fromCodePoint(f.top.glyph(x, y))).join(''))
    return ['architect', 'coder-1', 'tester', 'reviewer'].map(name => text.findIndex(line => line.includes(name)))
  }
  const first = rows(FIVE_AT.idle)
  for (let k = 1; k < 10; k++) assert.deepEqual(rows(FIVE_AT.idle + k * 200), first, `labels stay put at slot ${k}`)
})

test('robot goldens draw no more colour pairs than the matching globe goldens', () => {
  for (const c of GOLDEN_CASES.filter(g => g.style === 'robot')) {
    const globe = GOLDEN_CASES.find(g => g.name === c.name.replace(/^robot-/, ''))!
    const r = goldenFrame(c)
    const g = goldenFrame(globe)
    assert.ok(pairCount(r.top) <= pairCount(g.top), `${c.name}: ${pairCount(r.top)} <= ${pairCount(g.top)}`)
  }
})

test('no rule outside ROBOT_SKINS names a pixel of a particular skin', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'render', 'robot.ts'), 'utf8')
  assert.equal(/clawd|ROBOT_SKINS/.test(src), false, 'robot.ts reaches skins only through activeSkin()')
  assert.equal(/\.(eyes|arms)\.(open|closed|cross|up|down)\[/.test(src), false, 'robot.ts never indexes a bitmap row directly')
})
