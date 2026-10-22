import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { foldAll } from '../../src/core/fold.ts'
import { swarmTotals } from '../../src/core/stats.ts'
import { cardRect, drawCard, swarmDurationMs } from '../../src/render/card.ts'
import { glyphRows } from '../../src/render/font/index.ts'
import { render } from '../../src/render/frame.ts'
import { gridText } from '../../src/render/grid.ts'
import { fmtClock } from '../../src/render/header.ts'
import { paintGrids } from '../../src/render/raster.ts'
import { planRegions } from '../../src/render/regions.ts'
import { CELL_H, CELL_W } from '../../src/render/svg.ts'
import { mix } from '../../src/render/color.ts'
import { ACCENT, CANVAS, CANVAS_RAISED } from '../../src/render/tokens.ts'
import { emptyView } from '../../src/render/types.ts'
import { fiveAgentEvents, FIVE_SWARM } from '../fixtures/swarm-five.ts'

const state = foldAll(FIVE_SWARM, fiveAgentEvents())
const END = state.lastAt
const size = { columns: 120, rows: 44 }
const graphOf = () => planRegions(size, 5).graph!

test('the card sits at columns 30-89, rows 7-20 at the full step', () => {
  assert.deepEqual(cardRect(graphOf()), { x: 30, y: 7, w: 60, h: 14 })
})

test('duration is the wall-clock figure, the same value on the figure row and in "of work"', () => {
  const ms = swarmDurationMs(state)
  assert.equal(ms, (state.swarm.endedAt ?? state.lastAt) - state.swarm.startedAt!)
  const top = render(state, emptyView(), END, size).top
  drawCard(top, graphOf(), state, swarmTotals(state, END), { durationMs: ms, clipMs: 24_000, endedAt: state.swarm.endedAt }, 1)
  const text = gridText(top).join('\n')
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.floor((ms % 60_000) / 1000)
  assert.match(text, new RegExp(`${minutes}m ${String(seconds).padStart(2, '0')}s`))
  assert.match(text, new RegExp(`${fmtClock(ms)} of work in 24 s`))
})

test('the summary card matches its golden', () => {
  const top = render(state, emptyView(), END, size).top
  drawCard(top, graphOf(), state, swarmTotals(state, END), { durationMs: swarmDurationMs(state), clipMs: 24_000, endedAt: state.swarm.endedAt }, 1)
  const golden = readFileSync(new URL('./golden/summary-card.txt', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  assert.equal(gridText(top).join('\n') + '\n', golden)
})

test('the fade dims the graph by half of k and leaves the bottom grid alone', () => {
  const plain = render(state, emptyView(), END, size)
  const faded = render(state, emptyView(), END, size)
  drawCard(faded.top, graphOf(), state, swarmTotals(state, END), { durationMs: 1, clipMs: 1, endedAt: null }, 1 / 3)
  // A drawn graph cell outside the card (canvas stays canvas when dimmed toward canvas).
  const graph = graphOf()
  const card = cardRect(graph)
  const cells: [number, number][] = []
  for (let y = graph.y; y < graph.y + graph.h; y++) {
    for (let x = graph.x; x < graph.x + graph.w; x++) {
      const inCard = x >= card.x && x < card.x + card.w && y >= card.y && y < card.y + card.h
      if (!inCard && (plain.top.bg(x, y) !== CANVAS || plain.top.fg(x, y) !== CANVAS)) cells.push([x, y])
    }
  }
  const drawn = cells.find(([x, y]) => plain.top.bg(x, y) !== CANVAS) ?? cells.find(([x, y]) => plain.top.glyph(x, y) !== 0x20)!
  const [x, y] = drawn
  const before = plain.top.bg(x, y) !== CANVAS ? plain.top.bg(x, y) : plain.top.fg(x, y)
  const after = plain.top.bg(x, y) !== CANVAS ? faded.top.bg(x, y) : faded.top.fg(x, y)
  assert.equal(after, mix(before, CANVAS, 0.5 / 3))
  assert.deepEqual(gridText(faded.bottom!), gridText(plain.bottom!))
})

test('the wordmark on the card is real text: each cell of "Omnis" matches its font bitmap', () => {
  const top = render(state, emptyView(), END, size).top
  drawCard(top, graphOf(), state, swarmTotals(state, END), { durationMs: swarmDurationMs(state), clipMs: 24_000, endedAt: null }, 1)
  const { width, rgb } = paintGrids([top])
  const card = cardRect(graphOf())
  const px = (x: number, y: number): number => { const i = (y * width + x) * 3; return (rgb[i]! << 16) | (rgb[i + 1]! << 8) | rgb[i + 2]! }
  ;[...'Omnis'].forEach((ch, n) => {
    const rows = glyphRows(ch.codePointAt(0)!)!
    const cx = (card.x + 13 + n) * CELL_W
    const cy = (card.y + 1) * CELL_H
    for (let y = 0; y < CELL_H; y++) {
      for (let x = 0; x < CELL_W; x++) {
        const on = ((rows[y]! >> (7 - x)) & 1) === 1
        assert.equal(px(cx + x, cy + y), on ? ACCENT : CANVAS_RAISED, `${ch} pixel ${x},${y}`)
      }
    }
  })
})

test('the GIF header ends row 0 with the wordmark and drops the pane-only stop hint', () => {
  const replay = { speed: 2, clockMs: 30_000, totalMs: 30_000, ended: true }
  const top = render(state, emptyView(), END, size, { replay, wordmark: true }).top
  const [row0, row1] = gridText(top)
  assert.match(row0!, /OmnisSwarm $/)
  assert.equal(top.fg(row0!.lastIndexOf('Omnis'), 0), ACCENT)
  assert.doesNotMatch(row1!, /omnis replay stop/)
  assert.match(gridText(render(state, emptyView(), END, size, { replay }).top)[1]!, /omnis replay stop/)
})

test('the agent count matches the header, and "ended" is local time', () => {
  const endedAt = state.lastAt
  const top = render(state, emptyView(), END, size).top
  const totals = swarmTotals(state, END)
  drawCard(top, graphOf(), state, totals, { durationMs: swarmDurationMs(state), clipMs: 24_000, endedAt }, 1)
  const text = gridText(top)
  assert.match(text[0]!, new RegExp(`${totals.agents} agents`))
  const card = cardRect(graphOf())
  assert.equal(text[card.y + 7]!.slice(card.x + 3, card.x + 3 + String(totals.agents).length), String(totals.agents))
  const d = new Date(endedAt)
  const local = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  assert.match(text[card.y + 5]!, new RegExp(`ended ${local}`))
})
