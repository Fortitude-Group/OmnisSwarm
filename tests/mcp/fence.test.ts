import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendEvent } from '../../src/core/log.ts'
import { FENCE_TOOL } from '../../src/core/recording.ts'
import { toolFactories } from '../../src/mcp/registry.ts'
import { Session } from '../../src/mcp/session.ts'
import { createFenceTools } from '../../src/mcp/tools/fence.ts'
import { createTools } from '../../src/mcp/tools.ts'
import { InputError } from '../../src/mcp/validate.ts'
import { ev, tmpRoot } from '../helpers.ts'

const real = (p: string): string => realpathSync.native(p)

function setup(root = tmpRoot()) {
  const session = new Session(root)
  const ctx = { root, session }
  const [fence] = createFenceTools(ctx)
  const tools = createTools(ctx)
  const tool = (name: string, args: Record<string, unknown> = {}) => tools.find(t => t.name === name)!.handler(args)
  const ask = (agent: unknown) => JSON.parse(fence!.handler({ agent }).text as string) as Record<string, unknown>
  return { root, session, fence: fence!, tool, ask }
}

/** A swarm with coder-1 (id a1) and coder-2 (id a2) started. */
function swarm(root?: string) {
  const s = setup(root)
  s.tool('omnis_swarm_init', { name: 'auth', topology: 'hierarchical' })
  appendEvent(s.root, ev('agent.started', { name: 'coder-1', role: 'coder', description: '', parent: 'lead' }, { agent: 'a1', swarm: 'auth', atSec: 1 }))
  appendEvent(s.root, ev('agent.started', { name: 'coder-2', role: 'coder', description: '', parent: 'lead' }, { agent: 'a2', swarm: 'auth', atSec: 1 }))
  return s
}

test('omnis_fence is internal, named from FENCE_TOOL, and registered with the server', () => {
  const { fence } = setup()
  assert.equal(fence.name, FENCE_TOOL)
  assert.match(fence.description, /^Internal/)
  const names = toolFactories.flatMap(f => f({ root: tmpRoot(), session: new Session(tmpRoot()) })).map(t => t.name)
  assert.ok(names.includes(FENCE_TOOL))
})

test('an agent with a pending or active task that owns paths is fenced to the union of them', () => {
  const { root, tool, ask } = swarm()
  tool('omnis_task_create', { title: 'one', assignee: 'coder-1', owns: ['src/a/**', 'docs/'] })
  tool('omnis_task_create', { title: 'two', assignee: 'coder-1', owns: ['src/a/**', 'tests/a.test.ts'] })
  tool('omnis_task_update', { id: 't2', state: 'active' })
  assert.deepEqual(ask('a1'), { fenced: true, tasks: ['t1', 't2'], owns: ['src/a/**', 'docs/', 'tests/a.test.ts'], roots: [real(root)] })
})

test('done and failed tasks, tasks with no owns and other agents\' tasks do not fence', () => {
  const { tool, ask } = swarm()
  tool('omnis_task_create', { title: 'free', assignee: 'coder-1' })
  tool('omnis_task_create', { title: 'theirs', assignee: 'coder-2', owns: ['src/b/**'] })
  tool('omnis_task_create', { title: 'closed', assignee: 'coder-1', owns: ['src/c/**'] })
  tool('omnis_task_update', { id: 't3', state: 'done' })
  tool('omnis_task_create', { title: 'broken', assignee: 'coder-1', owns: ['src/d/**'] })
  tool('omnis_task_update', { id: 't4', state: 'failed' })
  assert.deepEqual(ask('a1'), { fenced: false })
  assert.deepEqual(ask('a2'), { fenced: true, tasks: ['t2'], owns: ['src/b/**'], roots: (ask('a2').roots as string[]) })
  tool('omnis_task_update', { id: 't2', state: 'active', owns: [] })
  assert.deepEqual(ask('a2'), { fenced: false })
})

test('the lead, an unknown agent and a session with no swarm are never fenced', () => {
  const none = setup()
  assert.deepEqual(none.ask('a1'), { fenced: false })
  const { tool, ask } = swarm()
  tool('omnis_task_create', { title: 'lead work', assignee: 'lead', owns: ['src/**'] })
  tool('omnis_task_create', { title: 'main work', assignee: 'main', owns: ['src/**'] })
  assert.deepEqual(ask('lead'), { fenced: false })
  assert.deepEqual(ask('a9'), { fenced: false })
})

/** Registers a worktree folder with the repo at `root` the way git does, with no git process. */
function addWorktree(root: string, name: string): string {
  const wt = join(tmpRoot(), name)
  const entry = join(root, '.git', 'worktrees', name)
  mkdirSync(wt, { recursive: true })
  mkdirSync(entry, { recursive: true })
  writeFileSync(join(entry, 'gitdir'), `${join(wt, '.git')}\n`)
  writeFileSync(join(entry, 'HEAD'), 'ref: refs/heads/x\n')
  writeFileSync(join(wt, '.git'), `gitdir: ${entry}\n`)
  return wt
}

test('roots are the project and its registered worktrees', () => {
  const { root, tool, ask } = swarm()
  const wt = addWorktree(root, 'wt-a')
  tool('omnis_task_create', { title: 'one', assignee: 'coder-1', owns: ['src/**'] })
  assert.deepEqual(ask('a1').roots, [real(root), real(wt)])
  assert.equal(ask('a1').home, undefined)
})

test('a project reached through a junction answers both the link and the real folder as roots', () => {
  const target = tmpRoot()
  const link = join(tmpRoot(), 'linked')
  try {
    symlinkSync(target, link, 'junction')
  } catch {
    return // this machine cannot make links
  }
  const { tool, ask } = swarm(link)
  tool('omnis_task_create', { title: 'one', assignee: 'coder-1', owns: ['src/**'] })
  assert.deepEqual(ask('a1').roots, [real(target), link])
})

test('when every fencing task names a worktree, home is that worktree in each spelling', () => {
  const { root, tool, ask } = swarm()
  const wt = addWorktree(root, 'wt-a')
  const wt2 = addWorktree(root, 'wt-b')
  tool('omnis_task_create', { title: 'one', assignee: 'coder-1', owns: ['src/**'], worktree: wt })
  assert.deepEqual(ask('a1').home, [real(wt)])
  tool('omnis_task_create', { title: 'two', assignee: 'coder-1', owns: ['docs/'], worktree: wt2 })
  assert.deepEqual(ask('a1').home, [real(wt), real(wt2)])
  tool('omnis_task_create', { title: 'three', assignee: 'coder-1', owns: ['lib/'] })
  assert.equal(ask('a1').home, undefined)
})

test('the owns union is capped at 200 patterns', () => {
  const { tool, ask } = swarm()
  for (let t = 0; t < 11; t++) tool('omnis_task_create', { title: `t${t}`, assignee: 'coder-1', owns: Array.from({ length: 20 }, (_, i) => `p${t}/f${i}/**`) })
  assert.equal((ask('a1').owns as string[]).length, 200)
})

test('agent must be an agent id', () => {
  const { fence } = setup()
  for (const agent of [undefined, '', 'a b', '../x', 'x'.repeat(65), 7]) {
    assert.throws(() => fence.handler(agent === undefined ? {} : { agent }), InputError, String(agent))
  }
  assert.deepEqual(fence.inputSchema.required, ['agent'])
})
