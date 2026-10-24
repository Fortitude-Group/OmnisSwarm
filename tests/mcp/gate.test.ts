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
import { CHANGED_WHY, NO_CHECK_TEXT, PINNED_WHY, differsWhy, gapOf } from '../../src/mcp/gate/gate.ts'
import { createGatePlanTools } from '../../src/mcp/tools/gate-plan.ts'
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
  const ctx = { root, now: () => NOW, session: new Session(root), gate: { env, ...gate } }
  const tools = [...createTools(ctx), ...createGatePlanTools(ctx)]
  const find = (name: string) => {
    const t = tools.find(x => x.name === name)
    if (t === undefined) throw new Error(`no tool ${name}`)
    return t
  }
  const run = async (name: string, args: Record<string, unknown>, ctx?: CallContext): Promise<ToolResult> => find(name).handler(args, ctx)
  ctx.session.noteSession('abcdef12-3456-7890-abcd-ef1234567890') // as the recorder mod's first omnis_record does
  await run('omnis_swarm_init', { name: 'Gate', topology: 'hierarchical' })
  await run('omnis_task_create', { title: 'build it', assignee: 'coder' })
  await run('omnis_task_update', { id: 't1', state: 'active' })
  const events = () => readEvents(swarmLogPath(root, 'gate')).events
  const gates = () => events().filter(e => e.type === 'gate.ran').map(e => e.data as Record<string, unknown>)
  const closed = () => events().some(e => e.type === 'task.updated' && (e.data as { state: string }).state === 'done')
  /** What the mod's gate guard does once the user's rules allow the command: ask for the plan, then approve it. */
  const approve = async (extra: Record<string, unknown> = {}) => {
    const plan = JSON.parse((await run('omnis_gate_plan', { id: extra.id ?? 't1', ...(extra.worktree !== undefined && { worktree: extra.worktree }) })).text)
    if (plan.run === true) await run('omnis_gate_approve', { id: plan.id, dir: plan.dir, command: plan.command, digest: plan.digest })
  }
  /** omnis_task_update(done) with no approval, as when the mod is off. */
  const bare = (extra: Record<string, unknown> = {}, ctx?: CallContext) => run('omnis_task_update', { id: 't1', state: 'done', ...extra }, ctx)
  const done = async (extra: Record<string, unknown> = {}, ctx?: CallContext) => {
    if (extra.skipGate !== true) await approve(extra)
    return bare(extra, ctx)
  }
  return { root, run, events, gates, closed, done, bare, approve }
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

test('a log name already taken, by a file, a folder or a link, is stepped over and never written through', async t => {
  const s = await setup({ OMNIS_GATE_COMMAND: PASS })
  const gates = join(s.root, '.omnis-swarm', 'gates')
  mkdirSync(join(gates, 'gate-t1-1.log'), { recursive: true })
  writeFileSync(join(gates, 'gate-t1-2.log'), 'an older log')
  const target = join(tmpRoot(), 'target.txt')
  writeFileSync(target, 'not to be touched')
  let linked = true
  try {
    symlinkSync(target, join(gates, 'gate-t1-3.log'), 'file')
  } catch {
    linked = false // links can't be made here; the file and folder cases still run
  }
  const r = await s.done()
  assert.match(r.text, /Gate passed/)
  const n = linked ? 4 : 3
  assert.equal(s.gates()[0]!.log, `.omnis-swarm/gates/gate-t1-${n}.log`)
  assert.equal(readFileSync(join(gates, 'gate-t1-2.log'), 'utf8'), 'an older log')
  assert.equal(readFileSync(target, 'utf8'), 'not to be touched')
  if (!linked) t.diagnostic('file links could not be made; the link case was not checked')
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
  // git's two-way link: a HEAD in the entry, and the worktree's .git file pointing back at it.
  writeFileSync(join(root, '.git', 'worktrees', 'w1', 'HEAD'), 'ref: refs/heads/w1\n')
  writeFileSync(join(wt, '.git'), `gitdir: ${join(root, '.git', 'worktrees', 'w1')}\n`)
  const s = await setup({ OMNIS_GATE_COMMAND: node("require('fs').writeFileSync('ran-here','x')") }, {}, root)
  await s.done({ worktree: wt })
  assert.ok(existsSync(join(wt, 'ran-here')))
  assert.equal(existsSync(join(root, 'ran-here')), false)
  await s.run('omnis_task_create', { title: 'two', worktree: wt })
  await s.done({ id: 't2' })
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

test('without an approval from the mod nothing runs and the task stays open, in block and warn alike', async () => {
  for (const mode of ['block', 'warn']) {
    const s = await setup({ OMNIS_VERIFY_GATE: mode, OMNIS_GATE_COMMAND: PASS })
    assert.deepEqual(await s.bare(), { text: NO_CHECK_TEXT, isError: true }, mode)
    assert.equal(s.closed(), false, mode)
    assert.deepEqual(s.gates(), [], mode)
  }
  assert.equal(NO_CHECK_TEXT, "The gate needs OmnisSwarm's mod to check permission first, and no check arrived. Make sure mods are on, or mark the task done with skipGate and a note.")
})

test('an approval is used once', async () => {
  const s = await setup({ OMNIS_GATE_COMMAND: FAIL })
  assert.equal((await s.done()).isError, true)
  assert.deepEqual(await s.bare(), { text: NO_CHECK_TEXT, isError: true })
  assert.equal(s.gates().length, 1)
})

test('skipGate and no gate found need no approval', async () => {
  const s = await setup()
  assert.match((await s.bare()).text, /No gate found/)
  const k = await setup({ OMNIS_GATE_COMMAND: FAIL })
  assert.equal((await k.bare({ skipGate: true, note: 'ok' })).text, 'Task t1 is now done. Gate skipped.')
})

test('a gate that changed after its approval is refused, even in warn mode', async () => {
  for (const mode of ['block', 'warn']) {
    const s = await setup({ OMNIS_VERIFY_GATE: mode })
    writeFileSync(join(s.root, 'package.json'), JSON.stringify({ scripts: { check: 'node -e 0' } }))
    await s.approve()
    writeFileSync(join(s.root, 'package.json'), JSON.stringify({ scripts: { check: 'node -e 1' } }))
    const r = await s.bare()
    assert.deepEqual(r, { text: `Gate failed for t1 (${CHANGED_WHY}, 0 s): npm run check. The task stays active.`, isError: true }, mode)
    assert.equal(s.closed(), false, mode)
    assert.deepEqual(s.gates(), [{ task: 't1', result: 'error', ms: 0, command: 'npm run check', mode }], mode)
  }
  assert.equal(CHANGED_WHY, 'the gate changed after it was approved')
})

/** A project with a gate script, and a worktree of it with its own copy. */
async function withScript(env: Record<string, string>, rootScript: string, wtScript: string) {
  const root = tmpRoot()
  const wt = tmpRoot()
  mkdirSync(join(root, '.git', 'worktrees', 'w1'), { recursive: true })
  writeFileSync(join(root, '.git', 'worktrees', 'w1', 'gitdir'), `${join(wt, '.git')}\n`)
  writeFileSync(join(root, '.git', 'worktrees', 'w1', 'HEAD'), 'ref: refs/heads/w1\n')
  writeFileSync(join(wt, '.git'), `gitdir: ${join(root, '.git', 'worktrees', 'w1')}\n`)
  const s = await setup(env, {}, root) // t1 is created before any gate exists, so nothing is pinned for it
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { check: rootScript } }))
  writeFileSync(join(wt, 'package.json'), JSON.stringify({ scripts: { check: wtScript } }))
  return { s, wt }
}

/** A task t2 created once the project has a gate, so its gate is pinned then. */
async function pinned(env: Record<string, string>, script: string, worktree?: string, rootDir?: string) {
  const s = await setup(env, {}, rootDir)
  writeFileSync(join(s.root, 'package.json'), JSON.stringify({ scripts: { check: script } }))
  if (worktree !== undefined) writeFileSync(join(worktree, 'package.json'), JSON.stringify({ scripts: { check: script } }))
  await s.run('omnis_task_create', { title: 'pinned', ...(worktree !== undefined && { worktree }) })
  await s.run('omnis_task_update', { id: 't2', state: 'active' })
  return s
}

test('a gate changed since its task was created is refused, in block and warn alike', async () => {
  assert.equal(PINNED_WHY, 'the gate changed since the task was created')
  for (const mode of ['block', 'warn']) {
    const s = await pinned({ OMNIS_VERIFY_GATE: mode }, "node -e \"console.log('real')\"")
    writeFileSync(join(s.root, 'package.json'), JSON.stringify({ scripts: { check: 'node -e 0' } }))
    const r = await s.done({ id: 't2' })
    assert.deepEqual(r, { text: `Gate failed for t2 (${PINNED_WHY}, 0 s): npm run check. The task stays active.`, isError: true }, mode)
    assert.deepEqual(s.gates(), [{ task: 't2', result: 'error', ms: 0, command: 'npm run check', mode }], mode)
    assert.equal(s.closed(), false, mode)
  }
})

test('the pin survives a server restart: a new server over the same project still refuses a changed gate', async () => {
  const s = await pinned({}, "node -e \"console.log('real')\"")
  const pins = s.events().filter(e => e.type === 'task.created').map(e => (e.data as { gatePin?: string }).gatePin)
  assert.equal(pins[0], undefined, 't1 was created before any gate existed')
  assert.match(pins[1]!, /^[0-9a-f]{64}$/)
  writeFileSync(join(s.root, 'package.json'), JSON.stringify({ scripts: { check: 'node -e 0' } }))
  const again = createTools({ root: s.root, now: () => NOW, session: new Session(s.root), gate: { env: {} } })
  const update = again.find(t => t.name === 'omnis_task_update')!
  const r = await update.handler({ id: 't2', state: 'done' })
  assert.deepEqual(r, { text: `Gate failed for t2 (${PINNED_WHY}, 0 s): npm run check. The task stays active.`, isError: true })
  assert.equal(s.closed(), false)
})

test('a gate removed since its task was created is refused, not closed as no gate', async () => {
  const s = await pinned({}, 'node -e 0')
  writeFileSync(join(s.root, 'package.json'), JSON.stringify({ scripts: {} }))
  const r = await s.bare({ id: 't2' })
  assert.deepEqual(r, { text: `Gate failed for t2 (${PINNED_WHY}, 0 s): no gate found. The task stays active.`, isError: true })
  assert.deepEqual(s.gates(), [{ task: 't2', result: 'error', ms: 0, mode: 'block' }])
  assert.equal(s.closed(), false)
})

test('a gate unchanged since its task was created runs', async () => {
  const s = await pinned({}, 'node -e 0')
  const r = await s.done({ id: 't2' })
  assert.equal(secs(r.text), 'Task t2 is now done. Gate passed in N s (npm run check).')
})

test('skipGate still closes a task whose gate changed since it was created', async () => {
  const s = await pinned({}, 'node -e 0')
  writeFileSync(join(s.root, 'package.json'), JSON.stringify({ scripts: { check: 'node -e 1' } }))
  const r = await s.done({ id: 't2', skipGate: true, note: 'lead closes it' })
  assert.equal(r.text, 'Task t2 is now done. Gate skipped.')
})

test('the pin is taken in the worktree the task was created with, so editing both copies is refused', async () => {
  const root = tmpRoot()
  const wt = tmpRoot()
  mkdirSync(join(root, '.git', 'worktrees', 'w1'), { recursive: true })
  writeFileSync(join(root, '.git', 'worktrees', 'w1', 'gitdir'), `${join(wt, '.git')}\n`)
  writeFileSync(join(root, '.git', 'worktrees', 'w1', 'HEAD'), 'ref: refs/heads/w1\n')
  writeFileSync(join(wt, '.git'), `gitdir: ${join(root, '.git', 'worktrees', 'w1')}\n`)
  const s = await pinned({}, "node -e \"console.log('real')\"", wt, root)
  for (const dir of [root, wt]) writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { check: 'node -e 0' } }))
  const r = await s.done({ id: 't2' })
  assert.deepEqual(r, { text: `Gate failed for t2 (${PINNED_WHY}, 0 s): npm run check. The task stays active.`, isError: true })
})

test('a worktree whose gate script differs from the project root is not run: block refuses', async () => {
  const { s, wt } = await withScript({}, "node -e \"console.log('real')\"", 'node -e 0')
  const r = await s.done({ worktree: wt })
  assert.deepEqual(r, { text: `Gate failed for t1 (${differsWhy('package.json')}, 0 s): npm run check. The task stays active.`, isError: true })
  assert.equal(differsWhy('package.json'), "the gate script in this worktree differs from the project's (package.json)")
  assert.equal(s.gates()[0]!.result, 'error')
  assert.equal(s.closed(), false)
})

test('a worktree whose gate script differs: warn closes with the reason', async () => {
  const { s, wt } = await withScript({ OMNIS_VERIFY_GATE: 'warn' }, "node -e \"console.log('real')\"", 'node -e 0')
  const r = await s.done({ worktree: wt })
  assert.equal(r.text, `Task t1 is now done, but its gate failed (${differsWhy('package.json')}, 0 s): npm run check. verifyGate is warn, so it closed anyway.`)
  assert.ok(s.closed())
})

test('a worktree whose gate script matches the project root runs there', async () => {
  const { s, wt } = await withScript({}, "node -e \"require('fs').writeFileSync('ran-here','x')\"", "node -e \"require('fs').writeFileSync('ran-here','x')\"")
  const r = await s.done({ worktree: wt })
  assert.equal(secs(r.text), 'Task t1 is now done. Gate passed in N s (npm run check).')
  assert.ok(existsSync(join(wt, 'ran-here')))
})
