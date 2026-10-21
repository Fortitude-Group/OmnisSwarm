import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldAll } from '../../src/core/fold.ts'
import { isSwarmState } from '../../src/core/state-check.ts'
import { ev } from '../helpers.ts'

const rich = () => foldAll('s1', [
  ev('swarm.started', { name: 'Demo', topology: 'mesh', goal: 'ship it', implicit: false }),
  ev('agent.started', { name: 'bob', role: 'coder', description: 'writes', parent: 'lead' }, { agent: 'a1', atSec: 1 }),
  ev('agent.usage', { model: 'claude-sonnet-4-6', input: 10, output: 5, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, { agent: 'a1', atSec: 2 }),
  ev('agent.tool', { phase: 'start', tool: 'Edit', kind: 'edit', subject: 'src/a.ts', isError: false }, { agent: 'a1', atSec: 3 }),
  ev('message.sent', { to: 'lead', summary: 'hello' }, { agent: 'a1', atSec: 4 }),
  ev('memory.put', { key: 'k/1', bytes: 3, preview: 'abc' }, { agent: 'a1', atSec: 5 }),
  ev('task.created', { id: 't1', title: 'Do it', assignee: 'bob', dependsOn: ['t0'] }, { atSec: 6 }),
  ev('agent.finished', { outcome: 'answer' }, { agent: 'a1', atSec: 7 }),
])

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const clone = (): any => JSON.parse(JSON.stringify(rich()))

test('a folded state passes, also after a JSON round trip', () => {
  assert.ok(isSwarmState(rich(), 's1'))
  assert.ok(isSwarmState(clone(), 's1'))
  assert.ok(!isSwarmState(clone(), 's2'))
})

test('wrong shapes are rejected', () => {
  const nullAgents = clone(); nullAgents.agents = null
  const extra = clone(); extra.extra = 1
  const nestedExtra = clone(); nestedExtra.agents.a1.tokens.more = 1
  const negative = clone(); negative.events = -1
  const badTool = clone(); delete badTool.agents.a1.tools.web
  const longFeed = clone(); longFeed.feed = Array.from({ length: 201 }, () => clone().feed[0])
  const badOutcome = clone(); badOutcome.agents.a1.outcome = 'nope'
  for (const bad of [nullAgents, extra, nestedExtra, negative, badTool, longFeed, badOutcome, null, [], 'x']) {
    assert.ok(!isSwarmState(bad, 's1'))
  }
})

test('unsafe keys are rejected', () => {
  const bad: unknown = JSON.parse(JSON.stringify(rich()).replace('"a1":', '"__proto__":'))
  assert.ok(!isSwarmState(bad, 's1'))
})

test('control and format characters are rejected, and so are over-long strings', () => {
  const esc = clone(); esc.agents.a1.name = '\u001b]0;pwn\u0007'
  const bidi = clone(); bidi.swarm.name = 'a‮b'
  const long = clone(); long.agents.a1.name = 'x'.repeat(65)
  const key = clone(); key.memory['k\u001b'] = key.memory['k/1']; delete key.memory['k/1']
  for (const bad of [esc, bidi, long, key]) assert.ok(!isSwarmState(bad, 's1'))
})
