import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldAll } from '../../src/core/fold.ts'
import { reportMarkdown } from '../../src/core/report.ts'
import { at, ev } from '../helpers.ts'

const swarm = (...extra: ReturnType<typeof ev>[]) => foldAll('s1', [
  ev('swarm.started', { name: 'n', topology: 'mesh', implicit: false }, { atSec: 0 }),
  ev('task.created', { id: 't1', title: 'a' }, { atSec: 1 }),
  ev('task.created', { id: 't2', title: 'b', dependsOn: ['t1'] }, { atSec: 2 }),
  ev('task.created', { id: 't3', title: 'c', dependsOn: ['t1', 't2'] }, { atSec: 3 }),
  ...extra,
])

test('Tasks names each pending task stuck behind a failed one', () => {
  const md = reportMarkdown(swarm(ev('task.updated', { id: 't1', state: 'failed' }, { atSec: 5 })), at(60), 0)
  assert.match(md, /## Tasks\n\n.*\n- Failed: t1 a\n- Never started: t2, waiting on failed t1\.\n- Never started: t3, waiting on failed t1\.\n/)
})

test('no Never started line when nothing failed, or the stranded task has moved on', () => {
  assert.doesNotMatch(reportMarkdown(swarm(), at(60), 0), /Never started/)
  const md = reportMarkdown(swarm(ev('task.updated', { id: 't1', state: 'failed' }, { atSec: 5 }), ev('task.updated', { id: 't2', state: 'active' }, { atSec: 6 })), at(60), 0)
  assert.doesNotMatch(md, /Never started: t2/)
  assert.match(md, /Never started: t3, waiting on failed t1\./)
})
