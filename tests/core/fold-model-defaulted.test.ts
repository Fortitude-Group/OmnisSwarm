import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultText, foldAll, LEAD, MAX_DEFAULTS } from '../../src/core/fold.ts'
import { reportMarkdown } from '../../src/core/report.ts'
import { isSwarmState } from '../../src/core/state-check.ts'
import { at, ev } from '../helpers.ts'

const defaulted = (data: Record<string, unknown>, atSec: number, agent: string | null = 'a1') =>
  ev('model.defaulted', data as never, { atSec, ...(agent !== null && { agent }) })
const roundTrip = (s: unknown) => JSON.parse(JSON.stringify(s))

test('a model.defaulted adds a record and a feed line, and leaves the agent table alone', () => {
  const s = foldAll('s1', [defaulted({ role: 'Explore', model: 'sonnet', rule: 'Explore = sonnet', resolved: 'claude-sonnet-4-6' }, 1)])
  assert.deepEqual(s.defaults, [{ role: 'Explore', model: 'sonnet', rule: 'Explore = sonnet', agent: 'a1', at: at(1) }])
  assert.deepEqual(s.feed.map(f => [f.agent, f.kind, f.text]), [[LEAD, 'agent', 'put Explore agent on sonnet (Explore = sonnet)']])
  assert.equal(Object.hasOwn(s.agents, 'a1'), false)
  assert.equal(defaultText({ role: 'Plan', model: 'opus', rule: 'Plan = opus' }), 'put Plan agent on opus (Plan = opus)')
  assert.equal(isSwarmState(roundTrip(s), 's1'), true)
})

test('a bad model.defaulted is skipped, defaults are capped, and none means no report section', () => {
  const s = foldAll('s1', [
    defaulted({ role: 'Explore', model: 'gpt', rule: 'x' }, 1),
    defaulted({ role: 'Explore', model: 'sonnet', rule: '' }, 2),
    defaulted({ role: '', model: 'sonnet', rule: 'x' }, 3),
    defaulted({ role: 'Explore', model: 'sonnet', rule: 'x' }, 4, null),
  ])
  assert.equal(s.defaults, undefined)
  assert.deepEqual(s.feed, [])
  assert.doesNotMatch(reportMarkdown(s, at(10), 0), /Model defaults/)
  const many = foldAll('s1', Array.from({ length: MAX_DEFAULTS + 5 }, (_, i) => defaulted({ role: 'Explore', model: 'sonnet', rule: 'Explore = sonnet' }, i + 1, `a${i}`)))
  assert.equal(many.defaults!.length, MAX_DEFAULTS)
  assert.equal(many.defaults![0]!.agent, 'a5')
})

test('the state check refuses a planted default of the wrong shape', () => {
  const s = roundTrip(foldAll('s1', [defaulted({ role: 'Explore', model: 'sonnet', rule: 'Explore = sonnet' }, 1)]))
  assert.equal(isSwarmState(s, 's1'), true)
  assert.equal(isSwarmState({ ...s, defaults: [{ ...s.defaults[0], model: 'gpt' }] }, 's1'), false)
  assert.equal(isSwarmState({ ...s, defaults: [{ ...s.defaults[0], extra: 1 }] }, 's1'), false)
  assert.equal(isSwarmState({ ...s, defaults: 'none' }, 's1'), false)
})

test('the report groups defaults by role, model and rule, after the cache holds', () => {
  const s = foldAll('s1', [
    ev('spawn.held', { role: 'Explore', phase: 'end', count: 2, ms: 1000, why: 'answered' }, { atSec: 1 }),
    defaulted({ role: 'Explore', model: 'sonnet', rule: 'Explore = sonnet' }, 2, 'a1'),
    defaulted({ role: 'Plan', model: 'opus', rule: 'Plan = opus' }, 3, 'a2'),
    defaulted({ role: 'Explore', model: 'sonnet', rule: 'Explore = sonnet' }, 4, 'a3'),
    defaulted({ role: 'Explore', model: 'sonnet', rule: 'Explore = sonnet' }, 5, 'a4'),
  ])
  const report = reportMarkdown(s, at(10), 0)
  assert.match(report, /## Model defaults\n\n- 3 Explore agents put on sonnet by "Explore = sonnet"\.\n- 1 Plan agent put on opus by "Plan = opus"\.\n/)
  assert.ok(report.indexOf('## Cache holds') < report.indexOf('## Model defaults'))
})
