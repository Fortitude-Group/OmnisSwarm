import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendEvent, ensureLogDirs, logPaths, readEvents, swarmLogPath } from '../../src/core/log.ts'
import { HANDOFF_TOOL } from '../../src/core/recording.ts'
import { toolFactories } from '../../src/mcp/registry.ts'
import { MAX_KEYS, MAX_VALUE_BYTES, readMemory } from '../../src/mcp/memory-store.ts'
import { Session } from '../../src/mcp/session.ts'
import { createHandoffTools } from '../../src/mcp/tools/handoff.ts'
import { createTools } from '../../src/mcp/tools.ts'
import { InputError } from '../../src/mcp/validate.ts'
import { ev, tmpRoot } from '../helpers.ts'

/** Fills the swarm's memory with `n` keys in one write: 500 locked puts would take seconds. */
function fillMemory(root: string, n: number): void {
  ensureLogDirs(root)
  const at = new Date().toISOString()
  const seed = Object.fromEntries(Array.from({ length: n }, (_, i) => [`fill/${i}`, { value: 'x', writer: 'lead', at }]))
  writeFileSync(join(logPaths(root).memory, 'auth.json'), JSON.stringify(seed))
}

function setup() {
  const root = tmpRoot()
  const session = new Session(root)
  const ctx = { root, session }
  const [handoff] = createHandoffTools(ctx)
  const tools = createTools(ctx)
  const tool = (name: string, args: Record<string, unknown> = {}) => tools.find(t => t.name === name)!.handler(args)
  tool('omnis_swarm_init', { name: 'auth', topology: 'hierarchical' })
  appendEvent(root, ev('agent.started', { name: 'coder-1', role: 'coder', description: '', parent: 'lead' }, { agent: 'a1', swarm: 'auth', atSec: 1 }))
  appendEvent(root, ev('agent.started', { name: 'coder-2', role: 'coder', description: '', parent: 'lead' }, { agent: 'a2', swarm: 'auth', atSec: 1 }))
  const ask = (args: Record<string, unknown>) => JSON.parse(handoff!.handler(args).text as string) as { notes: string[] }
  const state = () => session.state('auth').state
  return { root, session, handoff: handoff!, tool, ask, state }
}

test('omnis_handoff is internal, named from HANDOFF_TOOL, and registered with the server', () => {
  const { handoff } = setup()
  assert.equal(handoff.name, HANDOFF_TOOL)
  assert.match(handoff.description, /^Internal/)
  const names = toolFactories.flatMap(f => f({ root: tmpRoot(), session: new Session(tmpRoot()) })).map(t => t.name)
  assert.ok(names.includes(HANDOFF_TOOL))
})

test('an agent with no open task gets no note and nothing is written', async () => {
  const { root, tool, ask, state } = setup()
  tool('omnis_task_create', { title: 'closed one', assignee: 'coder-1' })
  tool('omnis_task_create', { title: 'theirs', assignee: 'coder-2' })
  await tool('omnis_task_update', { id: 't1', state: 'failed' })
  assert.deepEqual(ask({ agent: 'a1', why: 'stuck' }), { notes: [] })
  assert.deepEqual(Object.keys(readMemory(root, 'auth')), [])
  assert.equal(state().tasks.t1!.handoffs, undefined)
})

test('an unknown agent, the lead and a session with no swarm answer no notes', () => {
  const { tool, ask } = setup()
  tool('omnis_task_create', { title: 'one', assignee: 'lead' })
  assert.deepEqual(ask({ agent: 'a9', why: 'stuck' }), { notes: [] })
  assert.deepEqual(ask({ agent: 'lead', why: 'stuck' }), { notes: [] })
  const root = tmpRoot()
  const [bare] = createHandoffTools({ root, session: new Session(root) })
  assert.deepEqual(JSON.parse(bare!.handler({ agent: 'a1', why: 'stuck' }).text as string), { notes: [] })
})

test('active tasks come first, then pending by id, and a note is stored for each', async () => {
  const { root, tool, ask, state } = setup()
  tool('omnis_task_create', { title: 'first pending', assignee: 'coder-1' })
  tool('omnis_task_create', { title: 'the active one', assignee: 'coder-1' })
  tool('omnis_task_create', { title: 'theirs', assignee: 'coder-2' })
  await tool('omnis_task_update', { id: 't2', state: 'active' })
  assert.deepEqual(ask({ agent: 'a1', why: 'finished' }), { notes: ['handoff/t2', 'handoff/t1'] })
  const memory = readMemory(root, 'auth')
  assert.match(memory['handoff/t2']!.value, /^Handoff for t2: the active one\nFrom coder-1\./)
  assert.equal(memory['handoff/t2']!.writer, 'omnis')
  assert.equal(memory['handoff/t3'], undefined)
  const s = state()
  assert.equal(s.tasks.t2!.handoffs, 1)
  assert.equal(s.tasks.t1!.handoffs, 1)
  assert.equal(s.tasks.t3!.handoffs, undefined)
  // The task keeps its state and assignee: only the lead moves it.
  assert.deepEqual([s.tasks.t2!.state, s.tasks.t2!.assignee, s.tasks.t1!.state, s.tasks.t1!.assignee], ['active', 'coder-1', 'pending', 'coder-1'])
  assert.ok(s.feed.some(f => f.text === 'task t2 handoff note from coder-1'))
  assert.ok(s.memory['handoff/t2'] !== undefined, 'the memory.put event is in the log')
})

test('at most 3 tasks get a note, ordered by number not by text (t2 before t10)', async () => {
  const { tool, ask } = setup()
  for (let i = 0; i < 11; i++) tool('omnis_task_create', { title: `job ${i}`, assignee: 'coder-1' })
  await tool('omnis_task_update', { id: 't10', state: 'active' })
  assert.deepEqual(ask({ agent: 'a1', why: 'stuck' }), { notes: ['handoff/t10', 'handoff/t1', 'handoff/t2'] })
})

test('a full memory store skips the note and keeps the ones already written', () => {
  const { root, tool, ask, state } = setup()
  tool('omnis_task_create', { title: 'one', assignee: 'coder-1' })
  tool('omnis_task_create', { title: 'two', assignee: 'coder-1' })
  fillMemory(root, MAX_KEYS - 1)
  assert.deepEqual(ask({ agent: 'a1', why: 'stuck' }), { notes: ['handoff/t1'] })
  assert.equal(state().tasks.t2!.handoffs, undefined)
  assert.deepEqual(ask({ agent: 'a1', why: 'stuck' }), { notes: ['handoff/t1'] }, 'the first key already exists, so it can be replaced')
})

test('a note is never over the memory value limit', () => {
  const { root, tool, ask } = setup()
  tool('omnis_task_create', { title: 'one', assignee: 'coder-1' })
  ask({ agent: 'a1', why: 'stuck' })
  assert.ok(Buffer.byteLength(readMemory(root, 'auth')['handoff/t1']!.value) <= MAX_VALUE_BYTES)
})

test('agent must be an agent id and why one of stuck or finished', () => {
  const { handoff } = setup()
  assert.throws(() => handoff.handler({ agent: 'bad id!', why: 'stuck' }), InputError)
  assert.throws(() => handoff.handler({ agent: 'a1' }), InputError)
  assert.throws(() => handoff.handler({ agent: 'a1', why: 'lead' }), InputError)
  assert.throws(() => handoff.handler({ agent: 'a1', why: 'whatever' }), InputError)
  assert.throws(() => handoff.handler({ why: 'stuck' }), InputError)
})

// handoff: true on omnis_task_update (spec 3.4)

const worked = (root: string, agent = 'a1') =>
  appendEvent(root, ev('agent.tool', { phase: 'start', tool: 'Read', kind: 'read', subject: 'src/a.ts', isError: false }, { agent, swarm: 'auth', atSec: 2 }))
const text = async (r: ReturnType<ReturnType<typeof setup>['tool']>) => (await r).text as string

test('handoff: true writes the note from the assignee before the call, and the same call can reassign', async () => {
  const { root, tool, state } = setup()
  tool('omnis_task_create', { title: 'Build the parser', assignee: 'coder-1' })
  worked(root)
  const reply = await text(tool('omnis_task_update', { id: 't1', state: 'pending', assignee: 'coder-2', handoff: true, note: 'coder-1 stuck on the parser' }))
  assert.equal(reply, 'Task t1 is now pending.\nHandoff note saved as handoff/t1.')
  const note = readMemory(root, 'auth')['handoff/t1']!.value
  assert.match(note, /^Handoff for t1: Build the parser\nFrom coder-1\. \d+ min, 1 tool call, 0 failed\.\nRead, not edited: src\/a\.ts$/)
  assert.doesNotMatch(note, /Note on the task/, 'the note on this call is applied after the note is written')
  assert.equal(state().tasks.t1!.assignee, 'coder-2')
  const events = readEvents(swarmLogPath(root, 'auth')).events.filter(e => e.type === 'task.handoff')
  assert.deepEqual(events.map(e => e.data), [{ task: 't1', agent: 'a1', why: 'lead' }])
  assert.equal(state().tasks.t1!.handoffs, 1)
})

test('handoff: true is refused for a task with no assignee, or an assignee that never made a tool call', async () => {
  const { root, tool } = setup()
  tool('omnis_task_create', { title: 'free' })
  tool('omnis_task_create', { title: 'idle', assignee: 'coder-1' })
  tool('omnis_task_create', { title: 'ghost', assignee: 'nobody' })
  for (const id of ['t1', 't2', 't3']) await assert.rejects(async () => tool('omnis_task_update', { id, state: 'pending', handoff: true }), new InputError(`${id} has no agent's work to hand on.`))
  assert.deepEqual(Object.keys(readMemory(root, 'auth')), [])
})

test('handoff: true with state done is refused, and a refused call changes nothing', async () => {
  const { root, tool, state } = setup()
  tool('omnis_task_create', { title: 'one', assignee: 'coder-1' })
  worked(root)
  await assert.rejects(async () => tool('omnis_task_update', { id: 't1', state: 'done', handoff: true }), new InputError('A done task has nothing to hand on.'))
  assert.equal(state().tasks.t1!.state, 'pending')
  assert.deepEqual(Object.keys(readMemory(root, 'auth')), [])
})

test('handoff: false does nothing', async () => {
  const { root, tool } = setup()
  tool('omnis_task_create', { title: 'one', assignee: 'coder-1' })
  worked(root)
  assert.equal(await text(tool('omnis_task_update', { id: 't1', state: 'active', handoff: false })), 'Task t1 is now active.')
  assert.deepEqual(Object.keys(readMemory(root, 'auth')), [])
})

test('with the memory store full the update still goes ahead and the reply says no note was saved', async () => {
  const { root, tool, state } = setup()
  tool('omnis_task_create', { title: 'one', assignee: 'coder-1' })
  worked(root)
  fillMemory(root, MAX_KEYS)
  const reply = await text(tool('omnis_task_update', { id: 't1', state: 'pending', assignee: 'coder-2', handoff: true }))
  assert.equal(reply, 'Task t1 is now pending.\nMemory is full, so no handoff note was saved.')
  assert.equal(state().tasks.t1!.assignee, 'coder-2')
  assert.equal(state().tasks.t1!.handoffs, undefined)
})
