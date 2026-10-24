import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { APPROVE_TOOL, GATE_PLAN_TOOL } from '../../src/core/recording.ts'
import { takeApproval } from '../../src/mcp/gate/approvals.ts'
import { Session } from '../../src/mcp/session.ts'
import { createGatePlanTools } from '../../src/mcp/tools/gate-plan.ts'
import { createRecordTools } from '../../src/mcp/tools/record.ts'
import { createTools, type GateOptions } from '../../src/mcp/tools.ts'
import { InputError } from '../../src/mcp/validate.ts'
import { tmpRoot } from '../helpers.ts'
import { syncResult } from './sync.ts'

const NOW = new Date('2026-10-24T10:00:00.000Z')
const BLOCK = { env: { OMNIS_GATE_COMMAND: 'npm run ci' } }
const sha = (x: string) => createHash('sha256').update(x).digest('hex')
const SID = 'abcdef12-3456-7890-abcd-ef1234567890'
const NO_MOD = "The gate needs OmnisSwarm's mod, and it isn't running in this session. Turn mods on, or mark the task done with skipGate and a note."

function setup(gate?: GateOptions, root = tmpRoot()) {
  const session = new Session(root)
  const ctx = { root, session, now: () => NOW, ...(gate !== undefined && { gate }) }
  const [plan, approve] = createGatePlanTools(ctx)
  const tools = createTools(ctx)
  const ask = (args: Record<string, unknown>) => JSON.parse(syncResult(plan!.handler(args)).text) as Record<string, unknown>
  const run = async (name: string, args: Record<string, unknown>) => tools.find(t => t.name === name)!.handler(args)
  return { root, session, plan: plan!, approve: approve!, ask, run }
}

test('the tool is the internal omnis_gate_plan, taking id, worktree and skipGate', () => {
  const { plan } = setup()
  assert.equal(plan.name, GATE_PLAN_TOOL)
  assert.equal(GATE_PLAN_TOOL, 'omnis_gate_plan')
  assert.deepEqual(Object.keys(plan.inputSchema.properties as object).sort(), ['id', 'skipGate', 'worktree'])
  assert.match(plan.description, /^Internal to the OmnisSwarm plugin/)
})

test('with the gate off (no settings given) nothing would run', async () => {
  const s = setup()
  await s.run('omnis_swarm_init', { name: 'P', topology: 'mesh' })
  await s.run('omnis_task_create', { title: 'x' })
  assert.deepEqual(s.ask({ id: 't1' }), { run: false })
  assert.deepEqual(setup({ env: { OMNIS_VERIFY_GATE: 'off', OMNIS_GATE_COMMAND: 'npm run ci' } }).ask({ id: 't1' }), { run: false })
})

test('the gateCommand setting runs in the project root', () => {
  const s = setup(BLOCK)
  assert.deepEqual(s.ask({ id: 't1' }), { run: true, id: 't1', dir: realpathSync.native(s.root), command: 'npm run ci', digest: sha('npm run ci') })
  assert.deepEqual(setup({ env: { OMNIS_VERIFY_GATE: 'warn', OMNIS_GATE_COMMAND: 'x' } }).ask({ id: 't1' }).run, true)
})

test('skipGate means nothing would run', () => {
  assert.deepEqual(setup(BLOCK).ask({ id: 't1', skipGate: true }), { run: false })
  assert.equal(setup(BLOCK).ask({ id: 't1', skipGate: false }).run, true)
})

test('no gate found means nothing would run; a detected one is answered as the gate would run it', () => {
  const s = setup({ env: {} })
  assert.deepEqual(s.ask({ id: 't1' }), { run: false })
  writeFileSync(join(s.root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
  assert.deepEqual(s.ask({ id: 't1' }), { run: true, id: 't1', dir: realpathSync.native(s.root), command: 'npm test', digest: sha('node --test') })
})

test('the worktree argument, else the task\'s stored worktree, is where it would run', async () => {
  const root = tmpRoot()
  const wt = tmpRoot()
  mkdirSync(join(root, '.git', 'worktrees', 'w1'), { recursive: true })
  writeFileSync(join(root, '.git', 'worktrees', 'w1', 'gitdir'), `${join(wt, '.git')}\n`)
  // git's two-way link: a HEAD in the entry, and the worktree's .git file pointing back at it.
  writeFileSync(join(root, '.git', 'worktrees', 'w1', 'HEAD'), 'ref: refs/heads/w1\n')
  writeFileSync(join(wt, '.git'), `gitdir: ${join(root, '.git', 'worktrees', 'w1')}\n`)
  writeFileSync(join(wt, 'package.json'), JSON.stringify({ scripts: { check: 'tsc' } }))
  const s = setup({ env: {} }, root)
  await s.run('omnis_swarm_init', { name: 'P', topology: 'mesh' })
  await s.run('omnis_task_create', { title: 'x' })
  await s.run('omnis_task_create', { title: 'y', worktree: wt })
  assert.deepEqual(s.ask({ id: 't1' }), { run: false }, 'nothing in the root')
  const there = { run: true, dir: realpathSync.native(wt), command: 'npm run check', digest: sha('tsc') }
  assert.deepEqual(s.ask({ id: 't1', worktree: wt }), { ...there, id: 't1' })
  assert.deepEqual(s.ask({ id: 't2' }), { ...there, id: 't2' })
})

test('a task that does not exist yet is answered for the project root, never as nothing to run', () => {
  const s = setup(BLOCK)
  assert.deepEqual(s.ask({ id: 't42' }), { run: true, id: 't42', dir: realpathSync.native(s.root), command: 'npm run ci', digest: sha('npm run ci') })
})

test('bad input is an InputError', () => {
  const { plan } = setup(BLOCK)
  for (const args of [{}, { id: 'x1' }, { id: 't1', worktree: '/not/a/worktree' }, { id: 't1', skipGate: 'yes' }]) {
    assert.throws(() => plan.handler(args), InputError, JSON.stringify(args))
  }
})

test('omnis_gate_approve stores a one-shot approval for the task', async () => {
  const s = setup(BLOCK)
  await s.run('omnis_swarm_init', { name: 'P', topology: 'mesh' })
  s.session.noteSession(SID)
  assert.equal(s.approve.name, APPROVE_TOOL)
  assert.match(s.approve.description, /^Internal to the OmnisSwarm plugin/)
  const a = { dir: realpathSync.native(s.root), command: 'npm run ci', digest: sha('npm run ci') }
  assert.deepEqual(syncResult(s.approve.handler({ id: 't1', ...a })), { text: 'approved' })
  assert.deepEqual(takeApproval(s.root, 'p', 't1', NOW.getTime()), a)
  assert.equal(takeApproval(s.root, 'p', 't1', NOW.getTime()), null)
})

test('omnis_gate_approve refuses bad input', () => {
  const { approve, session } = setup(BLOCK)
  session.noteSession(SID)
  const ok = { id: 't1', dir: '/p', command: 'npm test', digest: 'a'.repeat(64) }
  for (const bad of [{ ...ok, id: 'x' }, { ...ok, digest: 'A'.repeat(64) }, { ...ok, digest: 'a'.repeat(63) }, { ...ok, dir: '' }, { ...ok, command: '' }, { id: 't1' }]) {
    assert.throws(() => approve.handler(bad), InputError, JSON.stringify(bad))
  }
})

test('omnis_gate_approve is refused until the recorder mod has been heard from in this server', () => {
  const s = setup(BLOCK)
  const ok = { id: 't1', dir: realpathSync.native(s.root), command: 'npm run ci', digest: sha('npm run ci') }
  assert.throws(() => s.approve.handler(ok), (err: unknown) => err instanceof InputError && err.message === NO_MOD)
  assert.equal(takeApproval(s.root, '', 't1', NOW.getTime()), null, 'nothing was stored')
  const [record] = createRecordTools({ root: s.root, session: s.session, now: () => NOW })
  record!.handler({ sessionId: SID, ts: NOW.toISOString(), type: 'agent.tool', agent: 'lead', data: { phase: 'start', tool: 'Bash', kind: 'bash', subject: 'ls', isError: false } })
  assert.deepEqual(syncResult(s.approve.handler(ok)), { text: 'approved' })
})

test('an omnis_record call that is refused does not count as the mod', () => {
  const s = setup(BLOCK)
  const [record] = createRecordTools({ root: s.root, session: s.session, now: () => NOW })
  assert.throws(() => record!.handler({ sessionId: 'bad id', ts: NOW.toISOString(), type: 'agent.tool', data: {} }))
  assert.throws(() => s.approve.handler({ id: 't1', dir: '/p', command: 'x', digest: 'a'.repeat(64) }), (err: unknown) => err instanceof Error && err.message === NO_MOD)
})
