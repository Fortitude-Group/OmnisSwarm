import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { foldAll, LEAD } from '../../src/core/fold.ts'
import { agentStats } from '../../src/core/stats.ts'
import { hex } from '../../src/render/color.ts'
import { render } from '../../src/render/frame.ts'
import { Grid, gridText } from '../../src/render/grid.ts'
import { drawSpotlight } from '../../src/render/spotlight.ts'
import { CANVAS, MODEL, STATUS, TEXT, routedFamilies } from '../../src/render/tokens.ts'
import { emptyView, rect } from '../../src/render/types.ts'
import { at, ev } from '../helpers.ts'

// 100k in and 100k out: sonnet ≈$1.20, haiku ≈$0.06, so routing one way saves ≈$1.14 and the other costs ≈$1.14 more.
const routed = (model: string, requested: string) => foldAll('s1', [
  ev('agent.started', { name: 'coder-1', role: 'coder', description: '', parent: LEAD }, { agent: 'a1', atSec: 0 }),
  ev('agent.usage', { model, requested, input: 100_000, output: 100_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, { agent: 'a1', atSec: 1 }),
])
const FULL = { columns: 120, rows: 44 }
const COMPACT = { columns: 80, rows: 21 }
const TREE = { columns: 60, rows: 13 }
const frame = (model: string, requested: string, size = FULL) => render(routed(model, requested), { ...emptyView(), pinned: 'a1' }, at(2), size)
const DOWN = ['claude-haiku-5-5', 'claude-sonnet-5-5'] as const
const UP = ['claude-sonnet-5-5', 'claude-haiku-5-5'] as const

/** The row and column where `text` first shows (after `after`, if given), or null. */
function find(g: Grid, text: string, after = ''): { x: number; y: number } | null {
  const rows = gridText(g)
  for (let y = 0; y < rows.length; y++) {
    const from = after === '' ? 0 : rows[y]!.indexOf(after)
    if (from < 0) continue
    const x = rows[y]!.indexOf(text, from)
    if (x >= 0) return { x, y }
  }
  return null
}
/** Every cell of `text` (after `after`) has the colour `fg`. */
function colourOf(g: Grid, text: string, fg: number, after = ''): void {
  const p = find(g, text, after)
  assert.ok(p !== null, `no "${text}"`)
  for (let i = 0; i < [...text].length; i++) {
    if (text[i] === ' ') continue
    assert.equal(hex(g.fg(p.x + i, p.y)), hex(fg), `"${text}" cell ${i}`)
  }
}
const all = (g: Grid | null) => gridText(g!).join('\n')

test('routedFamilies: a badge only when both families are known and differ', () => {
  const s = (model: string | null, requested: string | null) => ({ model, route: requested === null ? null : { requested, deltaUsd: 0 } })
  assert.deepEqual(routedFamilies(s('claude-haiku-5-5', 'claude-sonnet-5-5')), { asked: 'sonnet', answered: 'haiku' })
  assert.equal(routedFamilies(s('claude-sonnet-4-6', 'claude-sonnet-5-5')), null)
  assert.equal(routedFamilies(s('gpt-5-mini', 'claude-sonnet-5-5')), null)
  assert.equal(routedFamilies(s('claude-haiku-5-5', 'mystery')), null)
  assert.equal(routedFamilies(s('claude-haiku-5-5', null)), null)
  assert.equal(routedFamilies(s(null, 'claude-sonnet-5-5')), null)
})

test('spotlight row 0 shows sonnet → haiku in place of the model id, coloured per §13.5', () => {
  const g = frame(...DOWN).bottom!
  assert.match(all(g), /● coder-1 · coder · sonnet → haiku /)
  assert.doesNotMatch(all(g), /claude-/)
  colourOf(g, 'sonnet', TEXT.dim, 'coder · ')
  colourOf(g, ' → ', TEXT.faint, 'sonnet')
  colourOf(g, 'haiku', MODEL.haiku, '→')
  colourOf(g, '●', MODEL.haiku)
})

test('spotlight row 1 says what it saved vs requested, the figure in the running colour', () => {
  const g = frame(...DOWN).bottom!
  assert.match(all(g), /≈\$0\.06 · saves ≈\$1\.14 vs requested \n/)
  colourOf(g, '≈$0.06', TEXT.primary)
  colourOf(g, ' · saves ', TEXT.dim)
  colourOf(g, '≈$1.14', STATUS.running, 'saves')
  colourOf(g, ' vs requested', TEXT.dim)
})

test('a dearer answer says costs … more vs requested, the figure in amber', () => {
  const g = frame(...UP).bottom!
  assert.match(all(g), /haiku → sonnet/)
  assert.match(all(g), /≈\$1\.20 · costs ≈\$1\.14 more vs requested /)
  colourOf(g, 'haiku', TEXT.dim, 'coder · ')
  colourOf(g, 'sonnet', MODEL.sonnet, '→')
  colourOf(g, '≈$1.14', STATUS.warn, 'costs')
  colourOf(g, ' more vs requested', TEXT.dim)
})

test('a saving that rounds to $0.000 is left out, the badge stays', () => {
  const tiny = foldAll('s1', [
    ev('agent.started', { name: 'coder-1', role: 'coder', description: '', parent: LEAD }, { agent: 'a1', atSec: 0 }),
    ev('agent.usage', { model: DOWN[0], requested: DOWN[1], input: 10, output: 10, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, { agent: 'a1', atSec: 1 }),
  ])
  const g = render(tiny, { ...emptyView(), pinned: 'a1' }, at(2), FULL).bottom!
  assert.match(all(g), /sonnet → haiku/)
  assert.doesNotMatch(all(g), /saves|costs/)
})

test('the graph label carries ↓ in dim for cheaper and ↑ in amber for dearer', () => {
  const down = frame(...DOWN).top
  assert.match(all(down), /▶ coder-1 ↓/)
  colourOf(down, '↓', TEXT.dim, 'coder-1')
  const up = frame(...UP).top
  assert.match(all(up), /▶ coder-1 ↑/)
  colourOf(up, '↑', STATUS.warn, 'coder-1')
})

test('the compact spotlight shows · sonnet → haiku after the name and leaves the saving out', () => {
  const f = frame(...DOWN, COMPACT)
  assert.equal(f.step, 'compactSpotlight')
  const g = f.bottom!
  assert.match(all(g), /● coder-1 · sonnet → haiku ▶ running/)
  assert.doesNotMatch(all(g), /saves|vs requested/)
  colourOf(g, 'sonnet', TEXT.dim, 'coder-1')
  colourOf(g, ' → ', TEXT.faint, 'sonnet')
  colourOf(g, 'haiku', MODEL.haiku, '→')
})

test('the tree puts the mark after the name, in the same colours, and no saving', () => {
  const down = frame(...DOWN, TREE)
  assert.equal(down.step, 'tree')
  assert.match(all(down.top), /▶ coder-1 ↓ {2}200k tok · ≈\$0\.06/)
  assert.doesNotMatch(all(down.top), /saves|saved|routed/)
  colourOf(down.top, 'coder-1', MODEL.haiku)
  colourOf(down.top, '↓', TEXT.dim, 'coder-1')
  colourOf(frame(...UP, TREE).top, '↑', STATUS.warn, 'coder-1')
})

test('two versions of one family, or an unknown family, show no badge or mark', () => {
  for (const [model, requested] of [['claude-sonnet-5-5', 'claude-sonnet-5'], ['gpt-x', 'claude-sonnet-5-5']] as const) {
    for (const size of [FULL, COMPACT, TREE]) {
      const f = frame(model, requested, size)
      assert.doesNotMatch(`${all(f.top)}\n${f.bottom === null ? '' : all(f.bottom)}`, /→|vs requested|coder-1 [↓↑]/, `${model} ${size.columns}`)
    }
  }
  assert.match(all(frame('claude-sonnet-5-5', 'claude-sonnet-5').bottom), /coder · claude-sonnet-5-5/)
})

test('an unpriced side shows the badge with no saving and no mark', () => {
  const f = frame('claude-haiku-5-5', 'claude-opus-0')
  assert.match(all(f.bottom), /opus → haiku/)
  assert.doesNotMatch(all(f.bottom), /vs requested/)
  assert.doesNotMatch(all(f.top), /coder-1 [↓↑]/)
})

test('the badge and the saving are whole or absent at every width', () => {
  const s = routed(...DOWN)
  const stats = agentStats(s, 'a1', at(2))!
  for (let w = 10; w <= 110; w++) {
    for (const compact of [false, true]) {
      const g = new Grid(w, compact ? 1 : 6, CANVAS)
      drawSpotlight(g, rect(0, 0, w, compact ? 1 : 6), stats, s.agents.a1!, at(2), compact)
      const rows = gridText(g)
      for (const row of rows) {
        if (/sonnet|→/.test(row)) assert.match(row, /sonnet → haiku/, `width ${w}: ${row}`)
        if (/saves|vs req/.test(row)) assert.match(row, /· saves ≈\$1\.14 vs requested/, `width ${w}: ${row}`)
      }
    }
  }
})

// --- golden: the badge in the spotlight (full and compact), the graph label and the tree ---
const GOLDEN = new URL('./golden/route-badge.txt', import.meta.url)

function snapshot(label: string, g: Grid): string[] {
  const letters = new Map<number, string>()
  const map = Array.from({ length: g.rows }, (_, y) => {
    let line = ''
    for (let x = 0; x < g.columns; x++) {
      const fg = g.fg(x, y)
      if (!letters.has(fg)) letters.set(fg, String.fromCharCode(97 + letters.size))
      line += letters.get(fg)
    }
    return line
  })
  return [`## ${label} ${g.columns}x${g.rows}`, '### glyphs', ...gridText(g), '### fg', ...map, '### legend', ...[...letters].map(([fg, l]) => `${l} ${hex(fg)}`)]
}

test('the badge matches its golden', () => {
  const full = frame(...DOWN)
  const dearer = frame(...UP)
  const actual = [
    '# route-badge: coder-1 asked for sonnet, answered by haiku (and the reverse), pinned',
    ...snapshot('full top, sonnet → haiku', full.top),
    ...snapshot('full bottom, sonnet → haiku', full.bottom!),
    ...snapshot('full bottom, haiku → sonnet', dearer.bottom!),
    ...snapshot('compact bottom, sonnet → haiku', frame(...DOWN, COMPACT).bottom!),
    ...snapshot('tree, sonnet → haiku', frame(...DOWN, TREE).top),
    '',
  ].join('\n')
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(GOLDEN, actual)
  assert.ok(existsSync(GOLDEN), 'no golden for route-badge: run with UPDATE_GOLDEN=1, then have the designer review it')
  assert.equal(actual, readFileSync(GOLDEN, 'utf8').replace(/\r\n/g, '\n'))
})
