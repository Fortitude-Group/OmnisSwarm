import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldAll, type SwarmState } from '../../src/core/fold.ts'
import { MARGIN, depthsOf, layoutNodes, nodesKey, orderAgents, parentsOf, structuralEdges } from '../../src/render/layout.ts'
import { ev } from '../helpers.ts'

const leadUse = (sec = 0) => ev('agent.usage', { model: 'claude-opus-5-5', input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, { atSec: sec })
const start = (id: string, parent: string, sec: number) => ev('agent.started', { name: id, role: 'coder', description: '', parent }, { agent: id, atSec: sec })
const state = (...events: Parameters<typeof foldAll>[1]): SwarmState => foldAll('s1', events)

test('drawing order: the lead first, then by start time, placeholders last', () => {
  const s = state(leadUse(), start('b', 'lead', 2), start('a', 'lead', 1), ev('message.sent', { to: 'zz', summary: 'hi' }, { agent: 'a', atSec: 3 }))
  assert.deepEqual(orderAgents(s).map(a => a.id), ['lead', 'a', 'b', '?zz'])
})

test('parents follow the chain, and a missing parent falls back to the lead', () => {
  const s = state(leadUse(), start('a', 'lead', 1), start('b', 'a', 2), start('c', 'nobody', 3))
  const p = parentsOf(s)
  assert.deepEqual([p.get('lead'), p.get('a'), p.get('b'), p.get('c')], [null, 'lead', 'a', 'lead'])
  assert.deepEqual([...depthsOf(p)].sort(), [['a', 1], ['b', 2], ['c', 1], ['lead', 0]])
})

test('agents on a parent loop hang off the lead; agents below the loop keep their parent', () => {
  const two = parentsOf(state(leadUse(), start('a', 'b', 1), start('b', 'a', 2), start('c', 'a', 3)))
  assert.deepEqual([two.get('a'), two.get('b'), two.get('c')], ['lead', 'lead', 'a'])
  const three = parentsOf(state(leadUse(), start('a', 'b', 1), start('b', 'c', 2), start('c', 'a', 3)))
  assert.deepEqual([three.get('a'), three.get('b'), three.get('c')], ['lead', 'lead', 'lead'])
  const leaderless = parentsOf(state(start('a', 'b', 1), start('b', 'a', 2)))
  assert.deepEqual([leaderless.get('a'), leaderless.get('b')], [null, null])
})

test('a 2-step and a 3-step parent cycle terminate and every node is placed, in every topology', () => {
  const cycles = [
    state(leadUse(), start('a1', 'a2', 1), start('a2', 'a1', 2), start('k', 'a1', 3)),
    state(leadUse(), start('a1', 'a3', 1), start('a2', 'a1', 2), start('a3', 'a2', 3)),
  ]
  for (const s of cycles) {
    for (const t of ['hierarchical', 'mesh', 'star'] as const) {
      const pos = layoutNodes(s, t, 200, 60)
      assert.equal(Object.keys(pos).length, Object.keys(s.agents).length)
      for (const p of Object.values(pos)) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y))
    }
    assert.equal(depthsOf(parentsOf(s)).size, Object.keys(s.agents).length)
  }
})

test('a long loop of fifty agents still lays out', () => {
  const events = [leadUse(), ...Array.from({ length: 50 }, (_, i) => start(`n${i}`, `n${(i + 1) % 50}`, i + 1))]
  const pos = layoutNodes(state(...events), 'hierarchical', 200, 60)
  assert.equal(Object.keys(pos).length, 51)
  for (const p of Object.values(pos)) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y))
})

test('hierarchical: the lead on top, layers by depth, spread evenly', () => {
  const pos = layoutNodes(state(leadUse(), start('a', 'lead', 1), start('b', 'a', 2)), 'hierarchical', 100, 40)
  assert.deepEqual(pos.lead, { x: 50, y: MARGIN.top })
  assert.deepEqual(pos.a, { x: 50, y: MARGIN.top + (40 - MARGIN.bottom - MARGIN.top) / 2 })
  assert.deepEqual(pos.b, { x: 50, y: 40 - MARGIN.bottom })
})

test('mesh: a ring with the lead at twelve o\'clock; star: the lead in the centre', () => {
  const s = state(leadUse(), start('a', 'lead', 1), start('b', 'lead', 2), start('c', 'lead', 3))
  const ring = layoutNodes(s, 'mesh', 100, 40)
  assert.ok(Math.abs(ring.lead!.x - 50) < 1e-9)
  assert.ok(Math.abs(ring.lead!.y - MARGIN.top) < 1e-9)
  const cx = 50
  const cy = (MARGIN.top + 40 - MARGIN.bottom) / 2
  const rx = 50 - MARGIN.x
  const ry = (40 - MARGIN.bottom - MARGIN.top) / 2
  for (const p of Object.values(ring)) assert.ok(Math.abs(((p.x - cx) / rx) ** 2 + ((p.y - cy) / ry) ** 2 - 1) < 1e-9)
  const star = layoutNodes(s, 'star', 100, 40)
  assert.deepEqual(star.lead, { x: cx, y: cy })
  for (const p of [star.a!, star.b!, star.c!]) assert.ok(Math.abs(((p.x - cx) / rx) ** 2 + ((p.y - cy) / ry) ** 2 - 1) < 1e-9)
})

test('every node sits inside the canvas, and a lone node sits in the middle', () => {
  const pos = layoutNodes(state(leadUse(), start('a', 'lead', 1), start('b', 'lead', 2)), 'mesh', 30, 12)
  for (const p of Object.values(pos)) assert.ok(p.x >= 0 && p.x <= 30 && p.y >= 0 && p.y <= 12)
  const lone = layoutNodes(state(leadUse()), 'mesh', 100, 40)
  assert.deepEqual(lone.lead, { x: 50, y: (MARGIN.top + 40 - MARGIN.bottom) / 2 })
  assert.deepEqual(layoutNodes(state(), 'mesh', 100, 40), {})
})

test('structural edges: parent links for a tree, spokes for a star, none for a mesh', () => {
  const s = state(leadUse(), start('a', 'lead', 1), start('b', 'a', 2))
  assert.deepEqual(structuralEdges(s, 'hierarchical'), [{ from: 'lead', to: 'a' }, { from: 'a', to: 'b' }])
  assert.deepEqual(structuralEdges(s, 'star'), [{ from: 'lead', to: 'a' }, { from: 'lead', to: 'b' }])
  assert.deepEqual(structuralEdges(s, 'mesh'), [])
})

test('nodesKey changes when an agent joins and not otherwise', () => {
  const a = state(leadUse(), start('a', 'lead', 1))
  const b = state(leadUse(), start('a', 'lead', 1))
  const c = state(leadUse(), start('a', 'lead', 1), start('b', 'lead', 2))
  assert.equal(nodesKey(a), nodesKey(b))
  assert.notEqual(nodesKey(a), nodesKey(c))
})

test('an oversized canvas is held to the Raster limits', () => {
  const pos = layoutNodes(state(leadUse(), start('a', 'lead', 1)), 'hierarchical', 5000, 5000)
  for (const p of Object.values(pos)) assert.ok(p.x <= 512 && p.y <= 512)
})

test('non-finite canvas sizes give finite positions', () => {
  const s = state(leadUse(), start('a', 'lead', 1))
  for (const [w, h] of [[NaN, 40], [100, NaN], [Infinity, -Infinity]] as const) {
    for (const p of Object.values(layoutNodes(s, 'hierarchical', w, h))) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y))
  }
})

test('three siblings spread at a quarter, a half and three quarters of the width', () => {
  const pos = layoutNodes(state(leadUse(), start('a', 'lead', 1), start('b', 'lead', 2), start('c', 'lead', 3)), 'hierarchical', 100, 40)
  const x0 = MARGIN.x
  const span = 100 - 2 * MARGIN.x
  assert.deepEqual([pos.a!.x, pos.b!.x, pos.c!.x], [x0 + span * 0.25, x0 + span * 0.5, x0 + span * 0.75])
})

test('a star with no lead falls back to the ring, with no spokes', () => {
  const s = state(start('a', 'x', 1), start('b', 'x', 2), start('c', 'x', 3))
  const pos = layoutNodes(s, 'star', 100, 40)
  assert.equal(Object.keys(pos).length, 3)
  assert.deepEqual(pos, layoutNodes(s, 'mesh', 100, 40))
  assert.deepEqual(structuralEdges(s, 'star'), [])
})

test('a chain ten thousand deep lays out without overflowing the stack', () => {
  const events = [leadUse(), ...Array.from({ length: 10000 }, (_, i) => start(`n${i}`, i === 0 ? 'lead' : `n${i - 1}`, i + 1))]
  assert.equal(Object.keys(layoutNodes(state(...events), 'hierarchical', 200, 60)).length, 10001)
})
