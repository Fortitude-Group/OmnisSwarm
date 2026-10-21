import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hex } from '../../src/render/color.ts'
import { type Grid, gridText } from '../../src/render/grid.ts'
import type { Frame } from '../../src/render/types.ts'
import { FIVE_T0 } from '../fixtures/swarm-five.ts'
import { GOLDEN_CASES, goldenFrame, type GoldenCase } from './golden-cases.ts'

// Golden snapshots: each frame's glyphs, a map of its colour pairs with a legend (for review against
// docs/design/pane.md), and a hash of the exact cells. Regenerate with UPDATE_GOLDEN=1 after an intended change,
// then have the designer review the diff.
const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), 'golden')
const LETTERS = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!$%&*+-/:;<=>?@^_~']

function colours(grid: Grid): { map: string[]; legend: string[] } {
  const letter = new Map<string, string>()
  const count = new Map<string, number>()
  const map: string[] = []
  for (let y = 0; y < grid.rows; y++) {
    let line = ''
    for (let x = 0; x < grid.columns; x++) {
      const key = `fg ${hex(grid.fg(x, y))} bg ${hex(grid.bg(x, y))}`
      if (!letter.has(key)) letter.set(key, LETTERS[letter.size] ?? '.')
      count.set(key, (count.get(key) ?? 0) + 1)
      line += letter.get(key)
    }
    map.push(line)
  }
  const legend = [...letter].filter(([, l]) => l !== '.').map(([key, l]) => `${l} ${key} x${count.get(key)}`)
  if (letter.size > LETTERS.length) legend.push(`. ${letter.size - LETTERS.length} more pairs`)
  return { map, legend }
}

function snapshot(c: GoldenCase, f: Frame): string {
  const part = (label: string, g: Grid): string[] => {
    const { map, legend } = colours(g)
    const sha = createHash('sha256').update(g.encode()).digest('hex').slice(0, 16)
    return [`## ${label} ${g.columns}x${g.rows} sha ${sha}`, '### glyphs', ...gridText(g), '### colours', ...map, '### legend', ...legend]
  }
  return [
    `# ${c.name}: ${c.topology} at +${c.at - FIVE_T0} ms in ${c.size.columns}x${c.size.rows}; step ${f.step}, fps ${f.fps}, spotlight ${f.spotlight}`,
    ...part('top', f.top),
    ...(f.bottom === null ? ['## bottom none'] : part('bottom', f.bottom)),
    '## chips',
    ...f.chips.map(ch => `${ch.pinned ? '◉' : '●'} ${hex(ch.color)} ${ch.label} (${ch.id})`),
    '',
  ].join('\n')
}

for (const c of GOLDEN_CASES) {
  test(`golden: ${c.name}`, () => {
    const actual = snapshot(c, goldenFrame(c))
    const file = join(GOLDEN, `${c.name}.txt`)
    if (process.env.UPDATE_GOLDEN === '1') {
      mkdirSync(GOLDEN, { recursive: true })
      writeFileSync(file, actual)
      return
    }
    assert.ok(existsSync(file), `no golden for ${c.name}: run with UPDATE_GOLDEN=1, then have the designer review it`)
    assert.equal(actual, readFileSync(file, 'utf8').replace(/\r\n/g, '\n'))
  })
}
