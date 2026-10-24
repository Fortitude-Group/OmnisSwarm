import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { clip } from '../../src/core/events.ts'
import { appendEvent, readEvents, swarmLogPath } from '../../src/core/log.ts'
import type { CallContext, ToolResult } from '../../src/mcp/protocol.ts'
import { Session } from '../../src/mcp/session.ts'
import { createTools, type GateOptions } from '../../src/mcp/tools.ts'
import { InputError } from '../../src/mcp/validate.ts'
import { gapOf } from '../../src/mcp/gate/gate.ts'
import { emptyState } from '../../src/core/fold.ts'
import { ev, tmpRoot } from '../helpers.ts'

const NOW = new Date('2026-10-24T10:00:00.000Z')
const node = (code: string) => `"${process.execPath}" -e "${code}"`
const PASS = node("console.log('all green')")
const FAIL = node("console.log('one');console.error('broken test');process.exit(3)")
const SLOW = node('setTimeout(()=>{},30000)')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
/** Seconds vary with the machine; the rest of a reply is exact. */
const secs = (text: string) => text.replace(/(\d+) s([),])/g, 'N s$2').replace(/in \d+ s/, 'in N s')

async function setup(env: Record<string, string> = {}, gate: Partial<GateOptions> = {}, rootDir?: string) {
  const root = rootDir ?? tmpRoot()
  const tools = createTools({ root, now: () => NOW, session: new Session(root), gate: { env, ...gate } })
  const find = (name: string) => {
    const t = tools.find(x => x.name === name)
    if (t === undefined) throw new Error(`no tool ${name}`)
    return t
  }
  const run = async (name: string, args: Record<string, unknown>, ctx?: CallContext): Promise<ToolResult> => find(name).handler(args, ctx)
  await run('omnis_swarm_init', { name: 'Gate', topology: 'hierarchical' })
  await run('omnis_task_create', { title: 'build it', assignee: 'coder' })
  await run('omnis_task_update', { id: 't1', state: 'active' })
  const events = () => readEvents(swarmLogPath(root, 'gate')).events
  const gates = () => events().filter(e => e.type === 'gate.ran').map(e => e.data as Record<string, unknown>)
  const closed = () => events().some(e => e.type === 'task.updated' && (e.data as { state: string }).state === 'done')
  const done = (extra: Record<string, unknown> = {}, ctx?: CallContext) => run('omnis_task_update', { id: 't1', state: 'done', ...extra }, ctx)
  return { root, run, events, gates, closed, done }
}

test('verifyGate off keeps the old path: no gate runs and the task closes', async () => {
  const s = await setup({ OMNIS_VERIFY_GATE: 'off', OMNIS_GATE_COMMAND: FAIL })
  const r = await s.done()
  assert.deepEqual(r, { text: 'Task t1 is now done.' })
  assert.equal(s.gates().length, 0)
  assert.ok(s.closed())
  assert.equal(existsSync(join(s.root, '.omnis-swarm', 'gates')), false)
})

test('states other than done never run the gate', async () => {
  const s = await setup({ OMNIS_GATE_COMMAND: FAIL })
  assert.deepEqual(await s.run('omnis_task_update', { id: 't1', state: 'failed' }), { text: 'Task t1 is now failed.' })
  assert.equal(s.gates().length, 0)
})

test('block, passed: the task closes and gate.ran records the run', async () => {
  const s = await setup({ OMNIS_GATE_COMMAND: PASS })
  const r = await s.done()
  assert.equal(secs(r.text), `Task t1 is now done. Gate passed in N s (${clip(PASS, 80)}).`)
  assert.notEqual(r.isError, true)
  assert.ok(s.closed())
  const [g] = s.gates()
  assert.equal(g!.result, 'passed')
  assert.equal(g!.exit, 0)
  assert.equal(g!.mode, 'block')
  assert.equal(g!.log, '.omnis-swarm/gates/gate-t1-1.log')
  assert.equal(typeof g!.command, 'string')
  assert.equal(typeof g!.ms, 'number')
  const order = s.events().map(e => e.type)
  assert.ok(order.lastIndexOf('gate.ran') < order.lastIndexOf('task.updated'), 'gate.ran is written before task.updated')
  assert.match(readFileSync(join(s.root, '.omnis-swarm', 'gates', 'gate-t1-1.log'), 'utf8'), /all green/)
})

test('block, failed: the task keeps its state and the reply is an error with the tail and log', async () => {
  const s = await setup({ OMNIS_GATE_COMMAND: FAIL })
  const r = await s.done()
  assert.equal(r.isError, true)
  assert.equal(secs(r.text), `Gate failed for t1 (exit 3, N s): ${clip(FAIL, 80)}. The task stays active.\nLast lines:\none\nbroken test\nFull log: .omnis-swarm/gates/gate-t1-1.log`)
  assert.equal(s.closed(), false)
  assert.deepEqual({ ...s.gates()[0], ms: 0 }, { task: 't1', result: 'failed', ms: 0, command: clip(FAIL, 120), exit: 3, log: '.omnis-swarm/gates/gate-t1-1.log', mode: 'block' })
})

test('block, timeout: the reply says how long it was given', async () => {
  const s = await setup({ OMNIS_GATE_COMMAND: SLOW, OMNIS_GATE_MINUTES: '2' }, { limitMs: 800 })
  const r = await s.done()
  assert.equal(r.isError, true)
  assert.equal(secs(r.text), `Gate failed for t1 (timed out after 2 min, N s): ${clip(SLOW, 80)}. The task stays active.\nLast lines:\n\nFull log: .omnis-swarm/gates/gate-t1-1.log`)
  assert.equal(s.gates()[0]!.result, 'timeout')
  assert.equal(s.gates()[0]!.exit, undefined)
  assert.equal(s.closed(), false)
})

test('block, error: a gate that could not start keeps the task open', async () => {
  const s = await setup({ OMNIS_GATE_COMMAND: PASS })
  mkdirSync(join(s.root, '.omnis-swarm', 'gates', 'gate-t1-1.log'), { recursive: true }) // the log can't be opened
  const r = await s.done()
  assert.equal(r.isError, true)
  assert.match(secs(r.text), /^Gate failed for t1 \(could not start: could not write the log \(E[A-Z]+\), N s\): /)
  assert.equal(s.gates()[0]!.result, 'error')
  assert.equal(s.closed(), false)
})

test('warn, failed: the task closes and the reply carries the failure', async () => {
  const s = await setup({ OMNIS_VERIFY_GATE: 'warn', OMNIS_GATE_COMMAND: FAIL })
  const r = await s.done()
  assert.notEqual(r.isError, true)
  assert.equal(secs(r.text), `Task t1 is now done, but its gate failed (exit 3, N s): ${clip(FAIL, 80)}. verifyGate is warn, so it closed anyway.\nLast lines:\none\nbroken test\nFull log: .omnis-swarm/gates/gate-t1-1.log`)
  assert.ok(s.closed())
  assert.equal(s.gates()[0]!.mode, 'warn')
})

test('warn, timeout: closes too', async () => {
  const s = await setup({ OMNIS_VERIFY_GATE: 'warn', OMNIS_GATE_COMMAND: SLOW, OMNIS_GATE_MINUTES: '1' }, { limitMs: 600 })
  const r = await s.done()
  assert.match(r.text, /^Task t1 is now done, but its gate failed \(timed out after 1 min, \d+ s\)/)
  assert.ok(s.closed())
})

test('none: no gate found closes the task and says where it looked', async () => {
  const s = await setup()
  const r = await s.done()
  assert.equal(r.text, `Task t1 is now done. No gate found in ${realpathSync.native(s.root)}, so nothing was run.`)
  assert.ok(s.closed())
  assert.deepEqual(s.gates(), [{ task: 't1', result: 'none', ms: 0, mode: 'block' }])
})

test('none in warn mode records mode warn', async () => {
  const s = await setup({ OMNIS_VERIFY_GATE: 'warn' })
  await s.done()
  assert.equal(s.gates()[0]!.mode, 'warn')
})

test('a detected gate runs: package.json check script through npm', async () => {
  const s = await setup()
  writeFileSync(join(s.root, 'package.json'), JSON.stringify({ name: 'x', private: true, scripts: { check: "node -e \"console.log('checked')\"" } }))
  const r = await s.done()
  assert.equal(secs(r.text), 'Task t1 is now done. Gate passed in N s (npm run check).')
  assert.equal(s.gates()[0]!.command, 'npm run check')
})

test('skipGate closes without running and records skipped', async () => {
  const s = await setup({ OMNIS_GATE_COMMAND: FAIL })
  const r = await s.done({ skipGate: true, note: 'flaky network test, tracked in t9' })
  assert.equal(r.text, 'Task t1 is now done. Gate skipped.')
  assert.ok(s.closed())
  assert.deepEqual(s.gates(), [{ task: 't1', result: 'skipped', ms: 0, mode: 'block' }])
  assert.equal(existsSync(join(s.root, '.omnis-swarm', 'gates')), false)
})

test('skipGate needs a note', async () => {
  const s = await setup({ OMNIS_GATE_COMMAND: PASS })
  await assert.rejects(s.done({ skipGate: true }), (err: unknown) => err instanceof InputError && err.message === 'skipGate needs a note saying why.')
})

test('each run of a task gets the next log number', async () => {
  const s = await setup({ OMNIS_GATE_COMMAND: FAIL })
  await s.done()
  const r = await s.done()
  assert.match(r.text, /Full log: \.omnis-swarm\/gates\/gate-t1-2\.log$/)
  assert.deepEqual(s.gates().map(g => g.log), ['.omnis-swarm/gates/gate-t1-1.log', '.omnis-swarm/gates/gate-t1-2.log'])
})

test('progress is reported while the gate runs', async () => {
  const s = await setup({ OMNIS_GATE_COMMAND: node('setTimeout(()=>{},900)') }, { progressMs: 200 })
  const seen: string[] = []
  const ctx: CallContext = { signal: new AbortController().signal, progress: m => seen.push(m) }
  await s.done({}, ctx)
  assert.ok(seen.length >= 2, `saw ${seen.length}`)
  for (const m of seen) assert.match(m, /^gate running, \d+(\.\d)? min$/)
})

test('a cancelled call kills the gate and answers the block text with why cancelled', async () => {
  const s = await setup({ OMNIS_VERIFY_GATE: 'warn', OMNIS_GATE_COMMAND: SLOW })
  const controller = new AbortController()
  const pending = s.done({}, { signal: controller.signal, progress: () => {} })
  await sleep(500)
  controller.abort()
  const r = await pending
  assert.equal(r.isError, true)
  assert.equal(secs(r.text), `Gate failed for t1 (cancelled, N s): ${clip(SLOW, 80)}. The task stays active.\nLast lines:\n\nFull log: .omnis-swarm/gates/gate-t1-1.log`)
  assert.equal(s.closed(), false, 'not closed even in warn mode')
  assert.equal(s.gates()[0]!.result, 'failed')
})

test('a second done for the same directory while one runs is refused', async () => {
  const s = await setup({ OMNIS_GATE_COMMAND: node('setTimeout(()=>{},1200)') })
  const first = s.done()
  await sleep(100)
  await assert.rejects(s.done(), (err: unknown) => err instanceof InputError && err.message === `A gate is already running in ${realpathSync.native(s.root)}. Wait for it, then try again.`)
  assert.match((await first).text, /Gate passed/)
  assert.equal(s.gates().length, 1)
})

test('the gate runs in the worktree argument, else the stored worktree', async () => {
  const root = tmpRoot()
  const wt = tmpRoot()
  mkdirSync(join(root, '.git', 'worktrees', 'w1'), { recursive: true })
  writeFileSync(join(root, '.git', 'worktrees', 'w1', 'gitdir'), `${join(wt, '.git')}\n`)
  writeFileSync(join(wt, '.git'), 'gitdir: x')
  const s = await setup({ OMNIS_GATE_COMMAND: node("require('fs').writeFileSync('ran-here','x')") }, {}, root)
  await s.done({ worktree: wt })
  assert.ok(existsSync(join(wt, 'ran-here')))
  assert.equal(existsSync(join(root, 'ran-here')), false)
  await s.run('omnis_task_create', { title: 'two', worktree: wt })
  await s.run('omnis_task_update', { id: 't2', state: 'done' })
  assert.equal(s.gates().filter(g => g.task === 't2').length, 1)
  await assert.rejects(s.done({ worktree: tmpRoot() }), InputError)
})

test('the test-gap note: source edits and no test edits by the assignee', async () => {
  const s = await setup({ OMNIS_GATE_COMMAND: PASS })
  const edit = (subject: string, atSec: number) => appendEvent(s.root, ev('agent.tool', { phase: 'start', tool: 'Edit', kind: 'edit', subject, isError: false }, { agent: 'a1', swarm: 'gate', atSec }))
  appendEvent(s.root, ev('agent.started', { name: 'coder', role: 'dev', description: '', parent: 'lead' }, { agent: 'a1', swarm: 'gate', atSec: 1 }))
  edit('src/a.ts', 2)
  edit('src/b.py', 3)
  edit('README.md', 4)
  const r = await s.done()
  assert.match(r.text, /\nNote: coder changed 2 source file\(s\) and no test files\.$/)
  assert.equal(s.gates()[0]!.gap, 2)
  edit('tests/a.test.ts', 5)
  const r2 = await s.done()
  assert.doesNotMatch(r2.text, /Note:/)
  assert.equal(s.gates()[1]!.gap, undefined)
})

test('the test-gap note also follows a failure, and never for none or skipped', async () => {
  const s = await setup({ OMNIS_GATE_COMMAND: FAIL })
  appendEvent(s.root, ev('agent.started', { name: 'coder', role: 'dev', description: '', parent: 'lead' }, { agent: 'a1', swarm: 'gate', atSec: 1 }))
  appendEvent(s.root, ev('agent.tool', { phase: 'start', tool: 'Write', kind: 'edit', subject: 'src/x.ts', isError: false }, { agent: 'a1', swarm: 'gate', atSec: 2 }))
  const r = await s.done()
  assert.match(r.text, /Full log: \S+\nNote: coder changed 1 source file\(s\) and no test files\.$/)
  const skipped = await s.done({ skipGate: true, note: 'ok' })
  assert.doesNotMatch(skipped.text, /Note:/)
})

test('gapOf: which files count as tests and as source', () => {
  const state = emptyState('s')
  state.byName.coder = 'a1'
  const put = (path: string, agent = 'a1', blocked = false) => { state.edits[path] = [{ agent, at: 1, ...(blocked && { blocked: true as const }) }] }
  put('src/a.ts')
  put('lib\\b.cs')
  put('docs/x.md')
  put('src/other.ts', 'a2')
  put('src/refused.ts', 'a1', true)
  assert.equal(gapOf(state, 'coder'), 2)
  assert.equal(gapOf(state, 'nobody'), 0)
  for (const t of ['tests/x.ts', 'a/__tests__/b.js', 'spec/c.rb', 'src/d.spec.tsx', 'src/e.test.mjs', 'App/FooTests.cs', 'App/BarTest.fs']) {
    const s2 = emptyState('s')
    s2.byName.coder = 'a1'
    s2.edits['src/a.ts'] = [{ agent: 'a1', at: 1 }]
    s2.edits[t] = [{ agent: 'a1', at: 2 }]
    assert.equal(gapOf(s2, 'coder'), 0, t)
  }
})

test('a link where the gates folder should be is refused with the fixed message', async t => {
  const s = await setup({ OMNIS_GATE_COMMAND: PASS })
  const elsewhere = tmpRoot()
  try {
    symlinkSync(elsewhere, join(s.root, '.omnis-swarm', 'gates'), 'junction')
  } catch {
    t.skip('links cannot be made here')
    return
  }
  await assert.rejects(s.done(), (err: unknown) => err instanceof Error && !(err instanceof InputError) && err.message === 'Could not update the swarm files in .omnis-swarm/ (see the server log).')
  assert.equal(s.closed(), false)
})

test('without a gate option the tools never read the real environment: the gate is off', async () => {
  const saved = process.env.OMNIS_GATE_COMMAND
  process.env.OMNIS_GATE_COMMAND = FAIL
  try {
    const root = tmpRoot()
    const tools = createTools({ root, now: () => NOW, session: new Session(root) })
    const run = async (name: string, args: Record<string, unknown>) => tools.find(t => t.name === name)!.handler(args)
    await run('omnis_swarm_init', { name: 'Gate', topology: 'mesh' })
    await run('omnis_task_create', { title: 'x' })
    assert.deepEqual(await run('omnis_task_update', { id: 't1', state: 'done' }), { text: 'Task t1 is now done.' })
    assert.equal(readEvents(swarmLogPath(root, 'gate')).events.some(e => e.type === 'gate.ran'), false)
  } finally {
    if (saved === undefined) delete process.env.OMNIS_GATE_COMMAND
    else process.env.OMNIS_GATE_COMMAND = saved
  }
})
