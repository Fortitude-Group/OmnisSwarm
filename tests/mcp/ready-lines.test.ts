import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Session } from '../../src/mcp/session.ts'
import { createTools } from '../../src/mcp/tools.ts'
import { tmpRoot } from '../helpers.ts'
import { syncResult } from './sync.ts'

const NOW = new Date('2026-10-24T10:00:00.000Z')
const setup = () => {
  const root = tmpRoot()
  const tools = createTools({ root, now: () => NOW, session: new Session(root), gate: { env: { OMNIS_VERIFY_GATE: 'off' } } })
  const find = (name: string) => tools.find(t => t.name === name)!
  const call = (name: string, args: Record<string, unknown> = {}) => syncResult(find(name).handler(args))
  const update = async (args: Record<string, unknown>) => (await find('omnis_task_update').handler(args)).text
  const status = () => call('omnis_swarm_status').text
  call('omnis_swarm_init', { name: 'Ready', topology: 'mesh' })
  return { call, update, status }
}

test('closing a task lists what it made ready, with clipped titles and assignees', async () => {
  const { call, update } = setup()
  call('omnis_task_create', { title: 'a' })
  const long = 'Build the parser '.repeat(5).trim()
  call('omnis_task_create', { title: long, assignee: 'dev-3', dependsOn: ['t1'] })
  call('omnis_task_create', { title: 'Write the docs', dependsOn: ['t1'] })
  const text = await update({ id: 't1', state: 'done' })
  assert.equal(text, `Task t1 is now done.\nNow ready: t2 ${long.slice(0, 39)}… (dev-3), t3 Write the docs (no assignee).`)
})

test('no Now ready line when nothing became ready, or the task only goes active', async () => {
  const { call, update } = setup()
  for (const title of ['a', 'b']) call('omnis_task_create', { title })
  call('omnis_task_create', { title: 'c', dependsOn: ['t1', 't2'] })
  assert.equal(await update({ id: 't1', state: 'done' }), 'Task t1 is now done.')
  assert.equal(await update({ id: 't1', state: 'done' }), 'Task t1 is now done.')
  assert.equal(await update({ id: 't2', state: 'active' }), 'Task t2 is now active.')
})

test('Now ready lists at most 8 tasks, then says how many more', async () => {
  const { call, update } = setup()
  call('omnis_task_create', { title: 'root' })
  for (let i = 0; i < 10; i++) call('omnis_task_create', { title: `n${i}`, dependsOn: ['t1'] })
  const text = await update({ id: 't1', state: 'done' })
  assert.match(text, /^Now ready: t2 n0 \(no assignee\), .*t9 n7 \(no assignee\), and 2 more\.$/m)
  assert.doesNotMatch(text, /t10/)
})

test('a failed task names the pending tasks it strands', async () => {
  const { call, update } = setup()
  call('omnis_task_create', { title: 'a' })
  call('omnis_task_create', { title: 'b', dependsOn: ['t1'] })
  call('omnis_task_create', { title: 'c', dependsOn: ['t1'] })
  call('omnis_task_create', { title: 'd' })
  assert.equal(await update({ id: 't1', state: 'failed' }), 'Task t1 is now failed.\nNow stranded: t2, t3 (they depend on t1).')
  assert.equal(await update({ id: 't4', state: 'failed' }), 'Task t4 is now failed.')
})

test('starting a waiting task goes ahead with a note of what it still waits on', async () => {
  const { call, update } = setup()
  call('omnis_task_create', { title: 'a' })
  call('omnis_task_create', { title: 'b' })
  call('omnis_task_create', { title: 'c', dependsOn: ['t1', 't2'] })
  await update({ id: 't2', state: 'active' })
  assert.equal(await update({ id: 't3', state: 'active' }), 'Task t3 is now active.\nNote: t3 still waits on t1 (pending), t2 (active).')
  assert.equal(await update({ id: 't1', state: 'active' }), 'Task t1 is now active.')
})

test('status shows Ready and Waiting lines, marks stranded tasks and leaves empty ones out', async () => {
  const { call, update, status } = setup()
  assert.doesNotMatch(status(), /Ready:|Waiting:/)
  call('omnis_task_create', { title: 'a', assignee: 'dev-3' })
  call('omnis_task_create', { title: 'b' })
  call('omnis_task_create', { title: 'c', dependsOn: ['t1'] })
  call('omnis_task_create', { title: 'd', dependsOn: ['t1', 't2'] })
  call('omnis_task_create', { title: 'e', dependsOn: ['t2'] })
  let text = status()
  assert.match(text, /Tasks: 5 pending.*\nReady: t1 \(dev-3\), t2 \(no assignee\)\nWaiting: t3 on t1, t4 on t1 t2, t5 on t2\n/)
  await update({ id: 't2', state: 'failed' })
  await update({ id: 't1', state: 'done' })
  text = status()
  assert.match(text, /\nWaiting: t4 on t2 \(failed\), t5 on t2 \(failed\)\n/)
  assert.match(text, /\nReady: t3 \(no assignee\)\n/)
})

test('status caps each list at 10 tasks', async () => {
  const { call, status } = setup()
  call('omnis_task_create', { title: 'root' })
  call('omnis_task_create', { title: 'blocker' })
  for (let i = 0; i < 12; i++) call('omnis_task_create', { title: `w${i}`, dependsOn: ['t2'] })
  for (let i = 0; i < 12; i++) call('omnis_task_create', { title: `r${i}` })
  const lines = status().split('\n')
  const ready = lines.find(l => l.startsWith('Ready: '))!
  const waiting = lines.find(l => l.startsWith('Waiting: '))!
  assert.match(ready, /^Ready: (t\d+ \(no assignee\), ){10}and 4 more$/)
  assert.match(waiting, /^Waiting: (t\d+ on t2, ){10}and 2 more$/)
})
