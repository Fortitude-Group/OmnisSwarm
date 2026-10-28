import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldAll, type SwarmState } from '../../src/core/fold.ts'
import { layoutNodes } from '../../src/render/layout.ts'
import { render } from '../../src/render/frame.ts'
import { gridText } from '../../src/render/grid.ts'
import { emptyView } from '../../src/render/types.ts'
import { ev } from '../helpers.ts'

const leadUse = ev('agent.usage', { model: 'claude-opus-5-5', input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, { atSec: 0 })
const start = (id: string, sec: number) => ev('agent.started', { name: id, role: 'teammate', description: '', parent: 'lead' }, { agent: id, atSec: sec })
/** A lead with `n` workers, all on one layer: the LivingEarth swarm that lost its robots had 9. */
const wide = (n: number): SwarmState =>
  foldAll('s1', [leadUse, ...Array.from({ length: n }, (_, i) => start(`w${i + 1}`, i + 1))])

const rowsOf = (pos: Record<string, { x: number; y: number }>, ids: string[]): Map<number, number[]> => {
  const rows = new Map<number, number[]>()
  for (const id of ids) {
    const p = pos[id]!
    rows.set(p.y, [...(rows.get(p.y) ?? []), p.x])
  }
  return rows
}
const workers = (n: number) => Array.from({ length: n }, (_, i) => `w${i + 1}`)

test('a layer too wide for the gap wraps onto more rows, each spaced at least the gap apart', () => {
  const pos = layoutNodes(wide(9), 'hierarchical', 100, 80, 11)
  const rows = rowsOf(pos, workers(9))
  assert.ok(rows.size >= 2, `expected the workers on 2+ rows, got ${rows.size}`)
  for (const xs of rows.values()) {
    xs.sort((a, b) => a - b)
    for (let i = 1; i < xs.length; i++) assert.ok(xs[i]! - xs[i - 1]! >= 11, `gap ${xs[i]! - xs[i - 1]!}`)
  }
  // the lead stays alone at the top, and every worker row sits below it
  for (const y of rows.keys()) assert.ok(y > pos.lead!.y)
})

test('a layer that fits keeps the one-row layout it had before', () => {
  const s = wide(4)
  assert.deepEqual(layoutNodes(s, 'hierarchical', 100, 80, 11), layoutNodes(s, 'hierarchical', 100, 80))
})

test('nine robots in a 100-column pane are drawn, not swapped for the agent list', () => {
  for (const style of ['robot', 'globe'] as const) {
    const f = render(wide(9), { ...emptyView(), style }, 10_000, { columns: 100, rows: 40 })
    const body = gridText(f.top).slice(2)
    assert.ok(!body.some(l => l.includes(' tok · ')), `${style}: the graph fell back to the tree`)
  }
})
