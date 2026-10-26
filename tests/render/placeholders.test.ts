import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldAll, LEAD } from '../../src/core/fold.ts'
import { PLACEHOLDER_KEEP_MS, render, withoutStalePlaceholders } from '../../src/render/frame.ts'
import { emptyView } from '../../src/render/types.ts'
import { at, ev } from '../helpers.ts'

const coder = ev('agent.started', { name: 'coder', role: 'coder', description: '', parent: LEAD }, { agent: 'a1', atSec: 1 })
const ask = ev('message.sent', { to: 'ghost', summary: 'anyone?' }, { agent: 'a1', atSec: 2 })
/** The ghost was messaged at 2 s; the coder carries on until `untilMs` (a time from `at`). */
const after = (untilMs: number) => foldAll('s1', [coder, ask, ev('agent.usage', { model: 'claude-sonnet-4-6', input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, { agent: 'a1', atSec: (untilMs - at(0)) / 1000 })])

test('a placeholder is left out once the log runs PLACEHOLDER_KEEP_MS past the last message to it, with its links', () => {
  const kept = withoutStalePlaceholders(after(at(2) + PLACEHOLDER_KEEP_MS - 1))
  assert.equal(Object.hasOwn(kept.agents, '?ghost'), true)
  const s = after(at(2) + PLACEHOLDER_KEEP_MS)
  const gone = withoutStalePlaceholders(s)
  assert.deepEqual(Object.keys(gone.agents), ['a1'])
  assert.deepEqual(Object.keys(gone.links), [])
  // the state itself is untouched
  assert.equal(Object.hasOwn(s.agents, '?ghost'), true)
})

test('a quiet swarm keeps its placeholder however late it is drawn, and comes back as it was', () => {
  const s = foldAll('s1', [coder, ask])
  assert.equal(withoutStalePlaceholders(s), s)
  const drawn = Object.keys(render(s, emptyView(), at(2) + 10 * PLACEHOLDER_KEEP_MS, { columns: 120, rows: 44 }).positions)
  assert.ok(drawn.includes('?ghost'))
})

test('the pane does not draw a stale placeholder', () => {
  const size = { columns: 120, rows: 44 }
  const late = at(2) + PLACEHOLDER_KEEP_MS
  const drawn = Object.keys(render(after(late), emptyView(), late, size).positions)
  assert.ok(!drawn.includes('?ghost'))
  assert.ok(drawn.includes('a1'))
})
