import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldAll, LEAD } from '../../src/core/fold.ts'
import { at, ev } from '../helpers.ts'

const quakes = (atSec: number) =>
  ev('agent.started', { name: 'quakes', role: 'teammate', description: 'Quake cron', parent: LEAD }, { agent: 'aq1', atSec })

test('a message to a name before its agent starts moves onto the agent, and the placeholder goes', () => {
  const s = foldAll('s1', [
    ev('message.sent', { to: 'quakes', summary: 'carry on' }, { agent: LEAD, atSec: 1 }),
    quakes(2),
    ev('message.sent', { to: 'quakes', summary: 'and again' }, { agent: LEAD, atSec: 3 }),
  ])
  assert.equal(Object.hasOwn(s.agents, '?quakes'), false)
  assert.deepEqual(Object.keys(s.links), ['lead->aq1'])
  assert.deepEqual(s.links['lead->aq1'], { from: LEAD, to: 'aq1', count: 2, lastAt: at(3), recent: ['carry on', 'and again'] })
  assert.equal(s.agents.aq1!.messagesIn, 2)
  assert.deepEqual(s.feed.filter(f => f.kind === 'message').map(f => f.to), ['aq1', 'aq1'])
})

test('an agent spawned without a name leaves a placeholder alone', () => {
  const s = foldAll('s1', [
    ev('message.sent', { to: 'quakes', summary: 'hello?' }, { agent: LEAD, atSec: 1 }),
    ev('agent.started', { name: '', role: 'teammate', description: 'quakes', parent: LEAD }, { agent: 'aq1', atSec: 2 }),
  ])
  assert.equal(s.agents['?quakes']!.placeholder, true)
})

test('each message to a placeholder counts as activity on it', () => {
  const s = foldAll('s1', [
    ev('message.sent', { to: 'ghost', summary: 'one' }, { agent: LEAD, atSec: 1 }),
    ev('message.sent', { to: 'ghost', summary: 'two' }, { agent: LEAD, atSec: 7 }),
  ])
  assert.equal(s.agents['?ghost']!.lastActivity, at(7))
})
