import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldAll } from '../../src/core/fold.ts'
import { isSwarmState } from '../../src/core/state-check.ts'
import { reportMarkdown } from '../../src/core/report.ts'
import type { SwarmEvent } from '../../src/core/events.ts'
import { ev } from '../helpers.ts'

const base = (): SwarmEvent[] => [
  ev('swarm.started', { name: 'auth', topology: 'hierarchical', implicit: false }, { src: 'mcp', atSec: 0 }),
  ev('agent.started', { name: 'dev-2', role: 'dev', description: '', parent: 'lead' }, { agent: 'a2', atSec: 1 }),
  ev('task.created', { id: 't3', title: 'Parser', assignee: 'dev-2' }, { src: 'mcp', atSec: 2 }),
]
const handoff = (why: 'stuck' | 'finished' | 'lead', atSec: number, agent = 'a2') => ev('task.handoff', { task: 't3', agent, why }, { src: 'mcp', atSec })
const report = (events: SwarmEvent[]) => reportMarkdown(foldAll('s1', events), Date.parse('2026-10-21T11:00:00.000Z'), 0)

test('the report lists a handed-on task under Problems with the agent and why', () => {
  const md = report([...base(), handoff('stuck', 5)])
  assert.match(md, /## Problems\n\n(.*\n)*- t3 was handed on from dev-2 \(stuck\)\.\n/)
})

test('a task handed on twice shows the last one, once', () => {
  const md = report([...base(), handoff('stuck', 5), handoff('lead', 6)])
  assert.equal(md.split('\n').filter(l => l.includes('was handed on')).length, 1)
  assert.match(md, /- t3 was handed on from dev-2 \(lead, 2 times\)\./)
})

test('an agent the fold does not know is named by its id; a swarm with no handoff has no such line', () => {
  assert.match(report([...base(), handoff('finished', 5, 'zz9')]), /- t3 was handed on from zz9 \(finished\)\./)
  assert.doesNotMatch(report(base()), /handed on/)
})

test('the name and the id are escaped like the rest of the report', () => {
  const events = base()
  events[1] = ev('agent.started', { name: 'dev_*2', role: 'dev', description: '', parent: 'lead' }, { agent: 'a2', atSec: 1 })
  assert.match(report([...events, handoff('stuck', 5)]), /- t3 was handed on from dev\\_\\\*2 \(stuck\)\./)
})

test('the folded handoff is kept on the task and passes the state check, with or without it', () => {
  const s = foldAll('s1', [...base(), handoff('stuck', 5)])
  assert.deepEqual(s.tasks.t3!.handedOn, { from: 'dev-2', why: 'stuck' })
  assert.equal(isSwarmState(JSON.parse(JSON.stringify(s)), 's1'), true)
  assert.equal(Object.hasOwn(foldAll('s1', base()).tasks.t3!, 'handedOn'), false)
  const bad = JSON.parse(JSON.stringify(s))
  bad.tasks.t3.handedOn = { from: 'dev-2', why: 'because' }
  assert.equal(isSwarmState(bad, 's1'), false)
  bad.tasks.t3.handedOn = { from: 3, why: 'stuck' }
  assert.equal(isSwarmState(bad, 's1'), false)
  bad.tasks.t3.handedOn = { from: 'dev-2', why: 'stuck', extra: 1 }
  assert.equal(isSwarmState(bad, 's1'), false)
})
