import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldAll } from '../../src/core/fold.ts'
import { CLASH_WINDOW_MS, RUNNING_WINDOW_MS, SPEED_WINDOW_MS, agentStatus, fileClashes, speed } from '../../src/core/stats.ts'
import { at, ev } from '../helpers.ts'

const started = () => ev('agent.started', { name: 'a', role: 'r', description: '', parent: 'lead' }, { agent: 'a', atSec: 0 })
const use = (sec: number, output: number) =>
  ev('agent.usage', { model: 'claude-opus-5-5', input: 1, output, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, { agent: 'a', atSec: sec })
const edit = (agent: string, sec: number) =>
  ev('agent.tool', { phase: 'start', tool: 'Edit', kind: 'edit', subject: 'f.ts', isError: false }, { agent, atSec: sec })

test('running lasts exactly RUNNING_WINDOW_MS after the last activity', () => {
  const a = foldAll('s1', [started(), use(1, 10)]).agents.a!
  assert.equal(agentStatus(a, at(1) + RUNNING_WINDOW_MS), 'running')
  assert.equal(agentStatus(a, at(1) + RUNNING_WINDOW_MS + 1), 'waiting')
})

test('speed counts a call exactly SPEED_WINDOW_MS old and drops it a millisecond later', () => {
  const a = foldAll('s1', [started(), use(10, 100)]).agents.a!
  assert.equal(speed(a, at(10) + SPEED_WINDOW_MS), 10)
  assert.equal(speed(a, at(10) + SPEED_WINDOW_MS + 1), null)
})

test('a live clash needs one of its edits within CLASH_WINDOW_MS of now', () => {
  const s = foldAll('s1', [edit('a', 0), edit('b', 60)])
  assert.equal(fileClashes(s, at(60) + CLASH_WINDOW_MS).length, 1)
  assert.equal(fileClashes(s, at(60) + CLASH_WINDOW_MS + 1).length, 0)
  assert.equal(fileClashes(s).length, 1)
})

test('a clash is live when only one of the pair is recent, whichever edited last', () => {
  for (const s of [foldAll('s1', [edit('a', 100), edit('b', 0)]), foldAll('s1', [edit('b', 0), edit('a', 100)])]) {
    assert.equal(fileClashes(s, at(100) + CLASH_WINDOW_MS).length, 1)
    assert.equal(fileClashes(s, at(100) + CLASH_WINDOW_MS + 1).length, 0)
  }
  const stale = foldAll('s1', [edit('a', 0), edit('b', 100)])
  assert.equal(fileClashes(stale, at(0) + CLASH_WINDOW_MS).length, 1)
})

test('two edits exactly CLASH_WINDOW_MS apart clash; one millisecond more does not', () => {
  const sec = CLASH_WINDOW_MS / 1000
  assert.equal(fileClashes(foldAll('s1', [edit('a', 0), edit('b', sec)])).length, 1)
  assert.equal(fileClashes(foldAll('s1', [edit('a', 0), edit('b', sec + 0.001)])).length, 0)
  assert.equal(fileClashes(foldAll('s1', [edit('a', 0), edit('a', 1)])).length, 0)
})
