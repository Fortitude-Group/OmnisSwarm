import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { foldAll } from '../../src/core/fold.ts'
import { serialise } from '../../src/core/events.ts'
import { appendEvent, readEvents, swarmLogPath } from '../../src/core/log.ts'
import { advance, loadState, SNAPSHOT_EVERY, snapshotPath } from '../../src/core/snapshot.ts'
import { ev, tmpRoot } from '../helpers.ts'

const msg = (n: number) => ev('message.sent', { to: 'lead', summary: `m${n}` }, { agent: 'a1', atSec: n })
const write = (root: string, from: number, to: number) => { for (let n = from; n < to; n++) appendEvent(root, msg(n)) }

test('loadState folds the whole log on first load', () => {
  const root = tmpRoot()
  write(root, 0, 3)
  const loaded = loadState(root, 's1')
  assert.equal(loaded.state.events, 3)
  assert.equal(loaded.state.links['a1->lead']!.count, 3)
})

test('advance folds only lines added since the last read', () => {
  const root = tmpRoot()
  write(root, 0, 2)
  const loaded = loadState(root, 's1')
  write(root, 2, 5)
  assert.equal(advance(root, loaded), 3)
  assert.equal(loaded.state.events, 5)
  assert.equal(advance(root, loaded), 0)
})

test('a snapshot is written after enough events and gives the same state as a full replay', () => {
  const root = tmpRoot()
  write(root, 0, SNAPSHOT_EVERY + 10)
  loadState(root, 's1')
  assert.ok(existsSync(snapshotPath(root, 's1')))
  write(root, SNAPSHOT_EVERY + 10, SNAPSHOT_EVERY + 20)
  const fromSnapshot = loadState(root, 's1')
  const full = foldAll('s1', readEvents(swarmLogPath(root, 's1')).events)
  assert.deepEqual(fromSnapshot.state, full)
})

test('a corrupt snapshot is ignored', () => {
  const root = tmpRoot()
  write(root, 0, 3)
  loadState(root, 's1')
  writeFileSync(snapshotPath(root, 's1'), '{not json')
  assert.equal(loadState(root, 's1').state.events, 3)
})

test('corrupt lines are counted as gaps', () => {
  const root = tmpRoot()
  write(root, 0, 1)
  writeFileSync(swarmLogPath(root, 's1'), `${serialise(msg(0))}{broken\n`)
  assert.equal(loadState(root, 's1').state.gaps, 1)
})

test('a replaced log rebuilds state from scratch', () => {
  const root = tmpRoot()
  write(root, 0, 5)
  const loaded = loadState(root, 's1')
  writeFileSync(swarmLogPath(root, 's1'), serialise(msg(9)))
  advance(root, loaded)
  assert.equal(loaded.state.events, 1)
})

test('a log over 1 MiB loads completely with one loadState call', () => {
  const root = tmpRoot()
  const long = 'x'.repeat(200)
  for (let n = 0; n < 6000; n++) appendEvent(root, ev('message.sent', { to: 'lead', summary: long }, { agent: 'a1', atSec: n }))
  assert.equal(loadState(root, 's1').state.events, 6000)
})
