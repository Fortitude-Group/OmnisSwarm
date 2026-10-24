import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldAll, type SwarmState } from '../../src/core/fold.ts'
import { MAX_TASKS, cyclePath, newlyReady, readyTasks, strandedBy, waitsOn, wouldCycle } from '../../src/core/ready.ts'
import type { TaskState } from '../../src/core/events.ts'
import { ev } from '../helpers.ts'

let sec = 0
const create = (id: string, dependsOn: string[] = []) => ev('task.created', { id, title: `Task ${id}`, dependsOn }, { src: 'mcp', atSec: ++sec })
const set = (id: string, state: TaskState) => ev('task.updated', { id, state }, { src: 'mcp', atSec: ++sec })
const ids = (tasks: { id: string }[]) => tasks.map(t => t.id)

const chain = () => [create('t1'), create('t2', ['t1']), create('t3', ['t2'])]

test('a chain: only the head is ready, and finishing it frees the next', () => {
  const before = foldAll('s1', chain())
  assert.deepEqual(ids(readyTasks(before)), ['t1'])
  assert.deepEqual(waitsOn(before, 't3'), [{ id: 't2', state: 'pending' }])
  const after = foldAll('s1', [...chain(), set('t1', 'done')])
  assert.deepEqual(ids(readyTasks(after)), ['t2'])
  assert.deepEqual(ids(newlyReady(before.tasks, after.tasks)), ['t2'])
})

test('a fan-in is ready only when every dependency is done', () => {
  const base = [create('t1'), create('t2'), create('t3', ['t1', 't2'])]
  const one = foldAll('s1', [...base, set('t1', 'done')])
  assert.deepEqual(ids(readyTasks(one)), ['t2'])
  assert.deepEqual(waitsOn(one, 't3'), [{ id: 't2', state: 'pending' }])
  const both = foldAll('s1', [...base, set('t1', 'done'), set('t2', 'done')])
  assert.deepEqual(ids(readyTasks(both)), ['t3'])
  assert.deepEqual(waitsOn(both, 't3'), [])
})

test('ready tasks come in id order: t2 before t10', () => {
  const s = foldAll('s1', [create('t10'), create('t2'), create('t1')])
  assert.deepEqual(ids(readyTasks(s)), ['t1', 't2', 't10'])
})

test('only pending tasks are ready', () => {
  const s = foldAll('s1', [create('t1'), create('t2'), create('t3'), set('t1', 'active'), set('t2', 'done'), set('t3', 'failed')])
  assert.deepEqual(readyTasks(s), [])
})

test('newlyReady across one update names only what that update freed', () => {
  const log = [create('t1'), create('t2', ['t1']), create('t3', ['t1']), create('t4', ['t2'])]
  const base = foldAll('s1', log)
  const next = foldAll('s1', [...log, set('t1', 'done')])
  assert.deepEqual(ids(newlyReady(base.tasks, next.tasks)), ['t2', 't3'])
  assert.deepEqual(newlyReady(next.tasks, next.tasks), [])
})

test('the fold feed says the same tasks are ready as newlyReady does', () => {
  const log = [create('t1'), create('t2', ['t1']), create('t3', ['t1', 't4']), create('t4'), create('t5', ['t2'])]
  for (const closing of ['t1', 't4']) {
    const before = foldAll('s1', log)
    const after = foldAll('s1', [...log, set(closing, 'done')])
    const fed = after.feed.map(f => f.text).filter(t => t.endsWith(' ready')).map(t => t.split(' ')[1])
    assert.deepEqual(fed, ids(newlyReady(before.tasks, after.tasks)), closing)
  }
})

test('a stranded task: its dependency failed', () => {
  const s = foldAll('s1', [create('t1'), create('t2', ['t1']), create('t3', ['t2']), set('t1', 'failed')])
  assert.deepEqual(strandedBy(s, 't2'), ['t1'])
  assert.deepEqual(strandedBy(s, 't3'), [])
  assert.deepEqual(waitsOn(s, 't2'), [{ id: 't1', state: 'failed' }])
  assert.deepEqual(readyTasks(s), [])
  assert.deepEqual(strandedBy(s, 't1'), [])
  assert.deepEqual(strandedBy(s, 'nope'), [])
})

test('a dependency on a task that does not exist is ignored, not waited on for ever', () => {
  const s = foldAll('s1', [create('t1', ['t9'])])
  assert.deepEqual(ids(readyTasks(s)), ['t1'])
  assert.deepEqual(waitsOn(s, 't1'), [])
})

test('wouldCycle: a self-loop, a two-loop and a long loop', () => {
  const tasks = foldAll('s1', [create('t1'), create('t2', ['t1']), create('t3', ['t2']), create('t4', ['t3']), create('t5')]).tasks
  assert.equal(wouldCycle(tasks, 't1', ['t1']), true)
  assert.deepEqual(cyclePath(tasks, 't1', ['t1']), ['t1', 't1'])
  assert.deepEqual(cyclePath(tasks, 't1', ['t2']), ['t1', 't2', 't1'])
  assert.deepEqual(cyclePath(tasks, 't1', ['t5', 't4']), ['t1', 't4', 't3', 't2', 't1'])
  assert.equal(wouldCycle(tasks, 't1', ['t5']), false)
  assert.equal(cyclePath(tasks, 't1', ['t5']), null)
  assert.equal(wouldCycle(tasks, 't5', ['t4', 't3']), false)
  assert.equal(wouldCycle(tasks, 't1', []), false)
  assert.equal(wouldCycle(tasks, 't2', ['t4']), true)
})

test('a long chain closed into a loop is found', () => {
  const log = [create('t1'), ...Array.from({ length: 30 }, (_, i) => create(`t${i + 2}`, [`t${i + 1}`]))]
  const tasks = foldAll('s1', log).tasks
  const path = cyclePath(tasks, 't1', ['t31'])!
  assert.equal(path.length, 32)
  assert.equal(path[0], 't1')
  assert.equal(path.at(-1), 't1')
})

test('forged cyclic dependsOn in folded state: every walk still ends', () => {
  const state = foldAll('s1', [create('t1'), create('t2'), create('t3')]) as SwarmState
  state.tasks.t1!.dependsOn = ['t2']
  state.tasks.t2!.dependsOn = ['t3']
  state.tasks.t3!.dependsOn = ['t1', 't1', 't2']
  assert.deepEqual(readyTasks(state), [])
  assert.deepEqual(waitsOn(state, 't1').map(w => w.id), ['t2'])
  assert.deepEqual(strandedBy(state, 't1'), [])
  assert.deepEqual(newlyReady(state.tasks, state.tasks), [])
  assert.equal(wouldCycle(state.tasks, 't9', ['t1']), false)
  assert.equal(wouldCycle(state.tasks, 't9', ['t1', 't9']), true)
})

test('a huge forged graph ends after MAX_TASKS steps', () => {
  const state = foldAll('s1', []) as SwarmState
  const n = MAX_TASKS * 3
  for (let i = 0; i < n; i++) {
    const id = `t${i}`
    state.tasks[id] = { id, title: id, state: 'pending', assignee: null, dependsOn: [`t${(i + 1) % n}`, `t${(i + 7) % n}`], createdAt: 0, updatedAt: 0, note: null, owns: [], worktree: null, gate: null, gatePin: null }
  }
  assert.equal(wouldCycle(state.tasks, 'tx', ['t0']), false)
  assert.equal(readyTasks(state).length, 0)
})
