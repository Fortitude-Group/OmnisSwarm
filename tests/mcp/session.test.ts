import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadState } from '../../src/core/snapshot.ts'
import { Session } from '../../src/mcp/session.ts'
import { createTools } from '../../src/mcp/tools.ts'
import { tmpRoot } from '../helpers.ts'

const NOW = new Date('2026-10-21T10:00:00.000Z')

test('several tool calls on one swarm do a single full load', () => {
  const root = tmpRoot()
  let loads = 0
  const session = new Session(root, (r, id) => {
    loads++
    return loadState(r, id)
  })
  const tools = createTools({ root, now: () => NOW, session })
  const call = (name: string, args: Record<string, unknown> = {}) => tools.find(t => t.name === name)!.handler(args)
  call('omnis_swarm_init', { name: 'Held', topology: 'mesh' })
  call('omnis_task_create', { title: 'one' })
  call('omnis_task_create', { title: 'two' })
  call('omnis_task_update', { id: 't1', state: 'done' })
  assert.match(call('omnis_swarm_status').text, /Tasks: 1 pending, 0 active, 1 done/)
  assert.equal(loads, 1)
})

test('held state sees events appended after it was loaded', () => {
  const root = tmpRoot()
  const session = new Session(root)
  const tools = createTools({ root, now: () => NOW, session })
  const call = (name: string, args: Record<string, unknown> = {}) => tools.find(t => t.name === name)!.handler(args)
  call('omnis_swarm_init', { name: 'Held', topology: 'mesh' })
  const id = session.runningSwarm()
  assert.equal(Object.keys(session.state(id).state.tasks).length, 0)
  call('omnis_task_create', { title: 'one' })
  assert.equal(Object.keys(session.state(id).state.tasks).length, 1)
})

test('begin and letGo track ownership', () => {
  const session = new Session(tmpRoot())
  assert.equal(session.owned, false)
  session.begin('x')
  assert.equal(session.owned, true)
  session.letGo()
  assert.equal(session.owned, false)
})
