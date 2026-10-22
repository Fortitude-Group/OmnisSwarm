import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldAll, LEAD } from '../../src/core/fold.ts'
import { agentStats, type AgentStats } from '../../src/core/stats.ts'
import { Grid, gridText } from '../../src/render/grid.ts'
import { drawSpotlight } from '../../src/render/spotlight.ts'
import { CANVAS, MODEL, routeLabel } from '../../src/render/tokens.ts'
import { drawTree } from '../../src/render/tree.ts'
import { rect } from '../../src/render/types.ts'
import { at, ev } from '../helpers.ts'

const routed = () => foldAll('s1', [
  ev('agent.started', { name: 'coder', role: 'coder', description: '', parent: LEAD }, { agent: 'a1', atSec: 1 }),
  ev('agent.usage', { model: 'claude-haiku-5-5', input: 1000, output: 1000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, requested: 'claude-sonnet-5-5' }, { agent: 'a1', atSec: 2 }),
])
const now = at(3)

test('routeLabel names families when they differ and full ids when they do not', () => {
  assert.equal(routeLabel('claude-sonnet-5-5', 'claude-haiku-5-5'), 'sonnet → haiku')
  assert.equal(routeLabel('claude-sonnet-5-5', 'gpt-5-mini'), 'sonnet → gpt-5-mini')
  assert.equal(routeLabel('claude-sonnet-5-5', 'claude-sonnet-4-6'), 'claude-sonnet-5-5 → claude-sonnet-4-6')
})

test('the spotlight shows the route in place of the model and the saving beside the cost', () => {
  const s = routed()
  const g = new Grid(110, 6, CANVAS)
  drawSpotlight(g, rect(0, 0, 110, 6), agentStats(s, 'a1', now)!, s.agents.a1!, now, false)
  const rows = gridText(g)
  assert.match(rows[0]!, /coder · coder · sonnet → haiku/)
  const col = rows[0]!.indexOf('haiku', rows[0]!.indexOf('→'))
  assert.equal(g.fg(col, 0), MODEL.haiku)
  assert.match(rows[1]!, /saved 95% {2}≈\$/)
})

test('the compact spotlight and the tree carry the saving, an unknown one just says routed', () => {
  const s = routed()
  const stats = agentStats(s, 'a1', now)!
  const c = new Grid(110, 1, CANVAS)
  drawSpotlight(c, rect(0, 0, 110, 1), stats, s.agents.a1!, now, true)
  assert.match(gridText(c)[0]!, /saved 95%/)

  const tree = (st: AgentStats) => {
    const g = new Grid(80, 3, CANVAS)
    drawTree(g, rect(0, 0, 80, 3), s, { [LEAD]: agentStats(s, LEAD, now)!, a1: st })
    return gridText(g).find(r => r.includes('coder'))!
  }
  assert.match(tree(stats), /tok · ≈\$\S+ · saved 95%/)
  assert.match(tree({ ...stats, route: { ...stats.route!, savedPct: null } }), /· routed/)
  assert.match(tree({ ...stats, route: { ...stats.route!, savedPct: -0.5 } }), /· cost \+50%/)
  assert.doesNotMatch(tree({ ...stats, route: null }), /saved|routed/)
})
