import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { foldAll } from '../../src/core/fold.ts'
import { serialise } from '../../src/core/events.ts'
import { appendEvent, readEvents, swarmLogPath } from '../../src/core/log.ts'
import { advance, loadSnapshot, loadState, MAX_SNAPSHOT_BYTES, saveSnapshot, SNAPSHOT_EVERY, snapshotPath } from '../../src/core/snapshot.ts'
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

const snapshotted = (): { root: string; file: string } => {
  const root = tmpRoot()
  write(root, 0, 3)
  saveSnapshot(root, loadState(root, 's1'))
  return { root, file: snapshotPath(root, 's1') }
}
const plant = (file: string, state: unknown, offset = 0): void =>
  writeFileSync(file, JSON.stringify({ v: 1, offset, state }))

test('a planted snapshot with a wrong shape is ignored and the log is replayed', () => {
  const { root, file } = snapshotted()
  plant(file, { swarm: { id: 's1' }, agents: null })
  assert.equal(loadSnapshot(root, 's1'), null)
  assert.equal(loadState(root, 's1').state.events, 3)
})

test('a snapshot carrying terminal escapes is ignored', () => {
  const { root, file } = snapshotted()
  const good = JSON.parse(readFileSync(file, 'utf8')) as { state: { agents: Record<string, { name: string }> } }
  good.state.agents['a1']!.name = '\u001b]0;pwn\u0007'
  plant(file, good.state)
  assert.equal(loadState(root, 's1').state.agents['a1']!.name, 'a1')
})

test('an oversize snapshot is ignored', () => {
  const { root, file } = snapshotted()
  writeFileSync(file, ' '.repeat(MAX_SNAPSHOT_BYTES + 1))
  assert.equal(loadSnapshot(root, 's1'), null)
})

test('a snapshot reached through a junction is refused', () => {
  const { root } = snapshotted()
  assert.ok(loadSnapshot(root, 's1') !== null)
  const swarms = dirname(snapshotPath(root, 's1'))
  const elsewhere = `${root}-real`
  mkdirSync(elsewhere)
  for (const f of readdirSync(swarms)) writeFileSync(`${elsewhere}/${f}`, readFileSync(`${swarms}/${f}`))
  rmSync(swarms, { recursive: true })
  symlinkSync(elsewhere, swarms, 'junction')
  assert.equal(loadSnapshot(root, 's1'), null)
})

test('a symlinked snapshot file is refused', t => {
  const { root, file } = snapshotted()
  const real = `${file}.real`
  writeFileSync(real, readFileSync(file))
  rmSync(file)
  try {
    symlinkSync(real, file)
  } catch {
    t.skip('cannot create file symlinks here')
    return
  }
  assert.equal(loadSnapshot(root, 's1'), null)
})

test('a stale .tmp file does not stop saving, and no new temp files are left', () => {
  const { root, file } = snapshotted()
  writeFileSync(`${file}.tmp`, 'junk')
  saveSnapshot(root, loadState(root, 's1'))
  assert.ok(loadSnapshot(root, 's1') !== null)
  assert.deepEqual(readdirSync(dirname(file)).filter(f => f.endsWith('.tmp') && f !== 's1.snap.json.tmp'), [])
})

test('a failed snapshot save is not retried on every advance', () => {
  const root = tmpRoot()
  write(root, 0, 3)
  const loaded = loadState(root, 's1')
  mkdirSync(snapshotPath(root, 's1'))
  write(root, 3, SNAPSHOT_EVERY + 10)
  advance(root, loaded)
  assert.equal(loaded.sinceSnapshot, 0)
})
