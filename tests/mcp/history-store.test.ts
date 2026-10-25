import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendEvent } from '../../src/core/log.ts'
import { rowLine, type HistoryRow } from '../../src/core/history.ts'
import { ensureBackfill, hintBlock, hintsOptions, loadRows, projectKey, readRows, recordRun, trimStore } from '../../src/mcp/history-store.ts'
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
/** The stored id of agent `agent` in swarm `swarm`: opaque, so no swarm name leaves the project. */
const stored = (root: string, swarm: string, agent: string) => createHash('sha256').update(`${projectKey(root)}\u0000${swarm}/${agent}`).digest('hex').slice(0, 16)
const ids = (file: string) => lines(file).map(l => (JSON.parse(l) as HistoryRow).id).sort()

test('hintsOptions: on by default, project and off honoured, the data folder only when on, absolute and expanded', () => {
  assert.deepEqual(hintsOptions({}), { mode: 'on', machineDir: null })
  assert.equal(hintsOptions({ OMNIS_MODEL_HINTS: 'project', OMNIS_DATA_DIR: '/d' }).machineDir, null)
  assert.equal(hintsOptions({ OMNIS_MODEL_HINTS: 'off' }).mode, 'off')
  assert.equal(hintsOptions({ OMNIS_MODEL_HINTS: 'nonsense' }).mode, 'project')
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
  assert.deepEqual(ids(store(root)), [stored(root, 'alpha', 'dev-1'), stored(root, 'beta', 'dev-2')].sort())
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

test('hintsOptions fails closed: case and spaces ignored, blank or unexpanded means on, anything unknown means project', () => {
  assert.equal(hintsOptions({ OMNIS_MODEL_HINTS: 'OFF' }).mode, 'off')
  assert.equal(hintsOptions({ OMNIS_MODEL_HINTS: ' Project ' }).mode, 'project')
  assert.equal(hintsOptions({ OMNIS_MODEL_HINTS: 'none' }).mode, 'project')
  assert.equal(hintsOptions({ OMNIS_MODEL_HINTS: '  ' }).mode, 'on')
  assert.equal(hintsOptions({ OMNIS_MODEL_HINTS: '${user_config.modelHints}' }).mode, 'on')
})

test('stored ids are opaque: 16 hex from the project key and the row, and no swarm name in either store', () => {
  const root = tmpRoot()
  const machine = tmpRoot()
  runSwarm(root, 'payroll-secret', 'dev-1')
  recordRun(root, new Session(root), 'payroll-secret', on(machine))
  recordRun(root, new Session(root), 'payroll-secret', on(machine))
  assert.deepEqual(ids(store(root)), [stored(root, 'payroll-secret', 'dev-1')])
  assert.deepEqual(ids(join(machine, 'history.jsonl')), [stored(root, 'payroll-secret', 'dev-1')])
  assert.equal(readFileSync(join(machine, 'history.jsonl'), 'utf8').includes('payroll'), false)
})

test('loadRows ignores project-store rows from another project, such as a history file cloned from elsewhere', () => {
  const root = tmpRoot()
  mkdirSync(join(root, '.omnis-swarm'))
  const row = (project: string): HistoryRow => ({ v: 1, id: 'abc', role: 'r', model: 'claude-opus-5-5', clean: true, costUsd: 0, minutes: 0, at: '2026-10-25T10:00:00.000Z', project })
  writeFileSync(store(root), rowLine(row('0123456789abcdef')) + rowLine(row(projectKey(root))))
  assert.deepEqual(loadRows(root, on(null)).project.map(r => r.project), [projectKey(root)])
})

test('backfill folds only the newest 50 regular logs of 8 MB or less, and skips the swarm being started', () => {
  const root = tmpRoot()
  for (let i = 0; i < 53; i++) runSwarm(root, `s${i}`, 'dev')
  const swarms = join(root, '.omnis-swarm', 'swarms')
  for (let i = 0; i < 53; i++) utimesSync(join(swarms, `s${i}.jsonl`), 1_000_000 + i, 1_000_000 + i)
  truncateSync(join(swarms, 's52.jsonl'), 8 * 1024 * 1024 + 1) // the newest, now too big
  mkdirSync(join(swarms, 'dir.jsonl'))
  // s52 is too big and s51 is the swarm being started, which leaves s0 to s50: the newest 50 are s1 to s50.
  hintBlock(root, on(null), 's51')
  const want = Array.from({ length: 50 }, (_, i) => stored(root, `s${i + 1}`, 'dev')).sort()
  assert.deepEqual(ids(store(root)), want)
})

test('readRows refuses a folder and a file that is not regular', () => {
  const root = tmpRoot()
  mkdirSync(join(root, 'dir.jsonl'))
  assert.deepEqual(readRows(join(root, 'dir.jsonl')), [])
})

test('readRows over 256 KB keeps the first line when the cut falls on a line start, and drops it when the cut is mid-line', () => {
  const root = tmpRoot()
  const row = (i: number, pad: number) => {
    const line = JSON.stringify({ v: 1, id: `a${i}`, role: 'r', model: 'claude-opus-5-5', clean: true, costUsd: 0, minutes: 0, at: '2026-10-25T10:00:00.000Z', project: '0123456789abcdef' })
    return `${line}${' '.repeat(pad - line.length - 1)}\n`
  }
  const file = join(root, 'h.jsonl')
  // 300 lines of exactly 1 KB: the last 256 KB start exactly at line 44.
  writeFileSync(file, Array.from({ length: 300 }, (_, i) => row(i, 1024)).join(''))
  let rows = readRows(file)
  assert.equal(rows.length, 256)
  assert.equal(rows.at(-1)!.id, 'a44')
  // The same with the last line 512 bytes longer: the cut now falls in the middle of line 44.
  writeFileSync(file, Array.from({ length: 300 }, (_, i) => row(i, i === 299 ? 1536 : 1024)).join(''))
  rows = readRows(file)
  assert.equal(rows.length, 255)
  assert.equal(rows.at(-1)!.id, 'a45')
})

test('trimStore rewrites a store over its limit with its newest rows, and leaves a small one alone', () => {
  const root = tmpRoot()
  const file = join(root, 'history.jsonl')
  const row = (i: number): HistoryRow => ({ v: 1, id: `a${i}`, role: 'r', model: 'claude-opus-5-5', clean: true, costUsd: 0, minutes: 0, at: '2026-10-25T10:00:00.000Z', project: '0123456789abcdef' })
  writeFileSync(file, Array.from({ length: 30 }, (_, i) => rowLine(row(i))).join(''))
  trimStore(file, 1_000_000, 10)
  assert.equal(lines(file).length, 30)
  trimStore(file, 100, 10)
  assert.deepEqual(lines(file).map(l => (JSON.parse(l) as HistoryRow).id), Array.from({ length: 10 }, (_, i) => `a${i + 20}`))
  assert.deepEqual(readdirSync(root), ['history.jsonl'])
})

test('trimStore refuses a link', () => {
  const root = tmpRoot()
  const real = join(root, 'real.jsonl')
  writeFileSync(real, 'x\n'.repeat(100))
  const link = join(root, 'history.jsonl')
  try {
    symlinkSync(real, link)
  } catch {
    return // no symlink rights on this machine
  }
  trimStore(link, 10, 1)
  assert.equal(readFileSync(real, 'utf8'), 'x\n'.repeat(100))
})

test('projectKey is the same through a junction to the folder', () => {
  const root = tmpRoot()
  const link = join(tmpRoot(), 'via-link')
  try {
    symlinkSync(root, link, 'junction')
  } catch {
    return // this machine cannot make links
  }
  assert.equal(projectKey(link), projectKey(root))
})
