import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldAll, LEAD } from '../../src/core/fold.ts'
import type { SwarmEvent } from '../../src/core/events.ts'
import { guardWords } from '../../src/render/guard-badge.ts'
import { render } from '../../src/render/frame.ts'
import { gridText } from '../../src/render/grid.ts'
import { emptyView, type View } from '../../src/render/types.ts'
import { at, ev } from '../helpers.ts'

const start = ev('agent.started', { name: 'coder-b', role: 'coder', description: '', parent: LEAD }, { agent: 'a1', atSec: 0 })
const warnedTime: SwarmEvent[] = [start, ev('guard.warned', { limit: 'time', value: 20, threshold: 20 }, { agent: 'a1', atSec: 1200 })]

test('the words name the limit and the figures', () => {
  assert.equal(guardWords(foldAll('s1', [start]).agents.a1!, at(60)), null)
  assert.equal(guardWords(foldAll('s1', warnedTime).agents.a1!, at(21 * 60)), 'over time-box 21m/20m')
  const nudged = foldAll('s1', [...warnedTime, ev('guard.nudged', { limit: 'time', value: 30, threshold: 30, delivered: true }, { agent: 'a1', atSec: 1800 })])
  assert.equal(guardWords(nudged.agents.a1!, at(31 * 60)), 'nudged 31m/30m')
})

test('cost words use dollars; the limit furthest past wins', () => {
  const s = foldAll('s1', [
    ...warnedTime,
    ev('agent.usage', { model: 'claude-opus-5-5', input: 0, output: 160_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, { agent: 'a1', atSec: 1210 }),
    ev('guard.warned', { limit: 'agentCost', value: 3.2, threshold: 3 }, { agent: 'a1', atSec: 1211 }),
  ])
  assert.equal(guardWords(s.agents.a1!, at(20 * 60 + 15)), 'over $3.20/$3')
})

const top = (view: View = emptyView(), size = { columns: 120, rows: 44 }) => gridText(render(foldAll('s1', warnedTime), view, at(21 * 60), size).top)

test('the header shows swarm cost against its limit from the warn level, and BLOCKED while spawns are denied', () => {
  assert.doesNotMatch(top().join('\n'), /BLOCKED|\/\$20/)
  assert.match(top({ ...emptyView(), budget: { swarmUsd: 11.2, limit: 20, warn: 10, blocked: false } })[0]!, /≈\$11\.20\/\$20/)
  assert.doesNotMatch(top({ ...emptyView(), budget: { swarmUsd: 4, limit: 20, warn: 10, blocked: false } })[0]!, /\/\$20/)
  const blocked = top({ ...emptyView(), budget: { swarmUsd: 20.4, limit: 20, warn: 10, blocked: true } })
  assert.match(blocked[1]!, / BLOCKED /)
  assert.match(blocked[1]!, /new agents/)
  assert.match(blocked[1]!, /\/omnis budget <usd>/)
  assert.match(blocked[1]!, /1 over budget/)
})

test('the spotlight carries the words', () => {
  const f = render(foldAll('s1', warnedTime), { ...emptyView(), pinned: 'a1' }, at(21 * 60), { columns: 120, rows: 44 })
  assert.match(gridText(f.bottom!).join('\n'), /over time-box 21m\/20m/)
})

test('the tree says over after the figures', () => {
  const f = render(foldAll('s1', warnedTime), emptyView(), at(21 * 60), { columns: 60, rows: 13 })
  assert.equal(f.step, 'tree')
  assert.match(gridText(f.top).join('\n'), /coder-b .*tok · .* over/)
})

test('a one-row header shows BLOCKED right-aligned before the gaps marker', () => {
  const gapped = foldAll('s1', [...warnedTime, ev('agent.started', { name: 'z', role: 'r', description: '', parent: LEAD, dropped: 2 } as never, { agent: 'a2', atSec: 1300 })])
  const lines = gridText(render(gapped, { ...emptyView(), budget: { swarmUsd: 21, limit: 20, warn: 10, blocked: true } }, at(21 * 60), { columns: 100, rows: 12 }).top)
  assert.match(lines[0]!, / BLOCKED {2}\S+ 2 gaps $/, lines.join(String.fromCharCode(10)))
})
