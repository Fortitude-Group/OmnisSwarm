import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { GATE_PLAN_TOOL } from '../../src/core/recording.ts'
import { Session } from '../../src/mcp/session.ts'
import { createGatePlanTools } from '../../src/mcp/tools/gate-plan.ts'
import { createTools, type GateOptions } from '../../src/mcp/tools.ts'
import { InputError } from '../../src/mcp/validate.ts'
import { tmpRoot } from '../helpers.ts'
import { syncResult } from './sync.ts'

const NOW = new Date('2026-10-24T10:00:00.000Z')
const BLOCK = { env: { OMNIS_GATE_COMMAND: 'npm run ci' } }

function setup(gate?: GateOptions, root = tmpRoot()) {
  const session = new Session(root)
  const ctx = { root, session, now: () => NOW, ...(gate !== undefined && { gate }) }
  const [plan] = createGatePlanTools(ctx)
  const tools = createTools(ctx)
  const ask = (args: Record<string, unknown>) => JSON.parse(syncResult(plan!.handler(args)).text) as Record<string, unknown>
  const run = async (name: string, args: Record<string, unknown>) => tools.find(t => t.name === name)!.handler(args)
  return { root, plan: plan!, ask, run }
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
  assert.deepEqual(s.ask({ id: 't1' }), { run: true, command: 'npm run ci', dir: realpathSync.native(s.root) })
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
  assert.deepEqual(s.ask({ id: 't1' }), { run: true, command: 'npm test', dir: realpathSync.native(s.root) })
})

test('the worktree argument, else the task\'s stored worktree, is where it would run', async () => {
  const root = tmpRoot()
  const wt = tmpRoot()
  mkdirSync(join(root, '.git', 'worktrees', 'w1'), { recursive: true })
  writeFileSync(join(root, '.git', 'worktrees', 'w1', 'gitdir'), `${join(wt, '.git')}\n`)
  writeFileSync(join(wt, 'package.json'), JSON.stringify({ scripts: { check: 'tsc' } }))
  const s = setup({ env: {} }, root)
  await s.run('omnis_swarm_init', { name: 'P', topology: 'mesh' })
  await s.run('omnis_task_create', { title: 'x' })
  await s.run('omnis_task_create', { title: 'y', worktree: wt })
  assert.deepEqual(s.ask({ id: 't1' }), { run: false }, 'nothing in the root')
  assert.deepEqual(s.ask({ id: 't1', worktree: wt }), { run: true, command: 'npm run check', dir: realpathSync.native(wt) })
  assert.deepEqual(s.ask({ id: 't2' }), { run: true, command: 'npm run check', dir: realpathSync.native(wt) })
})

test('a task that does not exist yet is answered for the project root, never as nothing to run', () => {
  const s = setup(BLOCK)
  assert.deepEqual(s.ask({ id: 't42' }), { run: true, command: 'npm run ci', dir: realpathSync.native(s.root) })
})

test('bad input is an InputError', () => {
  const { plan } = setup(BLOCK)
  for (const args of [{}, { id: 'x1' }, { id: 't1', worktree: '/not/a/worktree' }, { id: 't1', skipGate: 'yes' }]) {
    assert.throws(() => plan.handler(args), InputError, JSON.stringify(args))
  }
})
