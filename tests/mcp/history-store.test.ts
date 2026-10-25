import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendEvent } from '../../src/core/log.ts'
import { rowLine, type HistoryRow } from '../../src/core/history.ts'
import { ensureBackfill, hintBlock, hintsOptions, loadRows, projectKey, readRows, recordRun } from '../../src/mcp/history-store.ts'
import { Session } from '../../src/mcp/session.ts'
import { ev, tmpRoot } from '../helpers.ts'

const store = (root: string) => join(root, '.omnis-swarm', 'history.jsonl')
const lines = (file: string) => readFileSync(file, 'utf8').split('\n').filter(Boolean)

/** One swarm `id` with one finished agent `agent` on `model`. */
function runSwarm(root: string, id: string, agent: string, model = 'claude-sonnet-5-5') {
  appendEvent(root, ev('swarm.started', { name: id, topology: 'hierarchical', implicit: false }, { swarm: id, src: 'mcp' }))
  appendEvent(root, ev('agent.started', { name: agent, role: 'omnis-developer', description: 'secret prompt words', parent: 'lead' }, { swarm: id, agent, atSec: 1 }))
  appendEvent(root, ev('agent.usage', { model, input: 10, output: 10, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, { swarm: id, agent, atSec: 2 }))
  appendEvent(root, ev('agent.finished', { outcome: 'answer' }, { swarm: id, agent, atSec: 60 }))
}
const on = (machineDir: string | null) => ({ mode: 'on' as const, machineDir })

test('hintsOptions: on by default, project and off honoured, the data folder only when on, absolute and expanded', () => {
  assert.deepEqual(hintsOptions({}), { mode: 'on', machineDir: null })
  assert.equal(hintsOptions({ OMNIS_MODEL_HINTS: 'project', OMNIS_DATA_DIR: '/d' }).machineDir, null)
  assert.equal(hintsOptions({ OMNIS_MODEL_HINTS: 'off' }).mode, 'off')
  assert.equal(hintsOptions({ OMNIS_MODEL_HINTS: 'nonsense' }).mode, 'on')
  assert.equal(hintsOptions({ OMNIS_DATA_DIR: '${CLAUDE_PLUGIN_DATA}' }).machineDir, null)
  assert.equal(hintsOptions({ OMNIS_DATA_DIR: 'relative/dir' }).machineDir, null)
  assert.notEqual(hintsOptions({ OMNIS_DATA_DIR: tmpRoot() }).machineDir, null)
})

test('projectKey is 16 lowercase hex and stable for the same folder', () => {
  const root = tmpRoot()
  assert.match(projectKey(root), /^[0-9a-f]{16}$/)
  assert.equal(projectKey(root), projectKey(`${root}/`))
})

test('recordRun writes each finished agent once to the project and machine stores, with no prompt text', () => {
  const root = tmpRoot()
  const machine = tmpRoot()
  runSwarm(root, 'alpha', 'dev-1')
  const session = new Session(root)
  recordRun(root, session, 'alpha', on(machine))
  recordRun(root, session, 'alpha', on(machine))
  assert.equal(lines(store(root)).length, 1)
  assert.equal(lines(join(machine, 'history.jsonl')).length, 1)
  assert.equal(readFileSync(store(root), 'utf8').includes('secret prompt words'), false)
})

test('off writes nothing; project never touches the machine store', () => {
  const root = tmpRoot()
  const machine = tmpRoot()
  runSwarm(root, 'alpha', 'dev-1')
  recordRun(root, new Session(root), 'alpha', { mode: 'off', machineDir: machine })
  assert.equal(existsSync(store(root)), false)
  recordRun(root, new Session(root), 'alpha', { mode: 'project', machineDir: machine })
  assert.equal(lines(store(root)).length, 1)
  assert.equal(existsSync(join(machine, 'history.jsonl')), false)
})

test('a machine store that cannot be written is skipped and the project store still gets the row', () => {
  const root = tmpRoot()
  runSwarm(root, 'alpha', 'dev-1')
  const blocker = join(tmpRoot(), 'file')
  writeFileSync(blocker, 'x')
  recordRun(root, new Session(root), 'alpha', on(join(blocker, 'sub')))
  assert.equal(lines(store(root)).length, 1)
})

test('backfill folds every old log once, the first time the store is missing', () => {
  const root = tmpRoot()
  runSwarm(root, 'alpha', 'dev-1')
  runSwarm(root, 'beta', 'dev-2', 'claude-opus-5-5')
  ensureBackfill(root)
  assert.deepEqual(lines(store(root)).map(l => (JSON.parse(l) as HistoryRow).id).sort(), ['alpha/dev-1', 'beta/dev-2'])
  runSwarm(root, 'gamma', 'dev-3')
  ensureBackfill(root)
  assert.equal(lines(store(root)).length, 2)
})

test('backfill with no log folder creates nothing', () => {
  const root = tmpRoot()
  ensureBackfill(root)
  assert.equal(existsSync(join(root, '.omnis-swarm')), false)
})

test('readRows reads newest first, skips bad lines, caps at 500 and refuses a link', () => {
  const root = tmpRoot()
  mkdirSync(join(root, '.omnis-swarm'))
  const row = (i: number): HistoryRow => ({ v: 1, id: `s/a${i}`, role: 'r', model: 'claude-opus-5-5', clean: true, costUsd: 0, minutes: 0, at: '2026-10-25T10:00:00.000Z', project: '0123456789abcdef' })
  writeFileSync(store(root), [...Array.from({ length: 600 }, (_, i) => rowLine(row(i))), 'not json\n'].join(''))
  const rows = readRows(store(root))
  assert.equal(rows.length, 500)
  assert.equal(rows[0]!.id, 's/a599')
  const link = join(root, 'link.jsonl')
  try {
    symlinkSync(store(root), link)
  } catch {
    return // no symlink rights on this machine
  }
  assert.deepEqual(readRows(link), [])
  assert.deepEqual(readRows(join(root, 'missing.jsonl')), [])
})

test('hintBlock is empty without enough evidence and lists hints when there is', () => {
  const root = tmpRoot()
  assert.equal(hintBlock(root, on(null)), '')
  for (let i = 0; i < 5; i++) runSwarm(root, `s${i}`, `a${i}`, 'claude-sonnet-5-5')
  for (let i = 5; i < 10; i++) runSwarm(root, `s${i}`, `a${i}`, 'claude-opus-5-5')
  const block = hintBlock(root, on(null))
  assert.match(block, /^\n\nModel hints from past runs:\n- omnis-developer: Sonnet finished clean 5 of 5 /)
  assert.equal(hintBlock(root, { mode: 'off', machineDir: null }), '')
  assert.deepEqual(loadRows(root, { mode: 'off', machineDir: null }), { project: [], machine: [] })
})
