import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { foldAll } from '../../src/core/fold.ts'
import { swarmTotals } from '../../src/core/stats.ts'
import { Grid, gridText } from '../../src/render/grid.ts'
import { drawHeader } from '../../src/render/header.ts'
import { CANVAS, TEXT } from '../../src/render/tokens.ts'
import { rect } from '../../src/render/types.ts'
import { VERSION } from '../../src/version.ts'
import { FIVE_AT, FIVE_SWARM, fiveAgentEvents } from '../fixtures/swarm-five.ts'

const s = foldAll(FIVE_SWARM, fiveAgentEvents())
const row1 = (columns: number, version?: string): string => {
  const g = new Grid(columns, 2, CANVAS, TEXT.primary)
  drawHeader(g, rect(0, 0, columns, 2), s, swarmTotals(s, FIVE_AT.mid), { notes: [], short: null, ...(version !== undefined && { version }) })
  return gridText(g)[1]!
}

test('VERSION matches the plugin manifest and package.json, so a release bumps them together', () => {
  const read = (p: string) => JSON.parse(readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8')).version
  assert.equal(VERSION, read('.claude-plugin/plugin.json'))
  assert.equal(VERSION, read('package.json'))
})

test('the header ends row 1 with the version, and row 0 is untouched', () => {
  const g = (version?: string) => {
    const grid = new Grid(200, 2, CANVAS, TEXT.primary)
    drawHeader(grid, rect(0, 0, 200, 2), s, swarmTotals(s, FIVE_AT.mid), { notes: [], short: null, ...(version !== undefined && { version }) })
    return gridText(grid)
  }
  assert.match(g('9.8.7')[1]!, /v9\.8\.7\s*$/)
  assert.equal(g('9.8.7')[0], g()[0])
})

test('the tasks keep their place, and a pane too narrow for the version leaves it out', () => {
  for (const columns of [40, 60, 80, 100, 120]) {
    const tasks = row1(columns).split('   ')[0]!
    assert.ok(row1(columns, '9.8.7').startsWith(tasks), `${columns} columns`)
  }
  assert.match(row1(80, '9.8.7'), /v9\.8\.7\s*$/)
  assert.doesNotMatch(row1(40, '9.8.7'), /v9\.8\.7/)
})

test('a note wins over the version when both do not fit', () => {
  const note = 'x'.repeat(40) // 44 cells free at 120 columns: room for the note, not for the note and the version
  const grid = new Grid(120, 2, CANVAS, TEXT.primary)
  drawHeader(grid, rect(0, 0, 120, 2), s, swarmTotals(s, FIVE_AT.mid), { notes: [[note, TEXT.primary]], short: null, version: '9.8.7' })
  const line = gridText(grid)[1]!
  assert.ok(line.includes(note))
  assert.doesNotMatch(line, /v9\.8\.7/)
})
