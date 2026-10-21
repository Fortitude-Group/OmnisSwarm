import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readCurrent, readEvents, swarmLogPath } from '../../src/core/log.ts'
import { putMemory } from '../../src/mcp/memory-store.ts'
import { handleMessage } from '../../src/mcp/protocol.ts'
import { createTools } from '../../src/mcp/tools.ts'
import { InputError } from '../../src/mcp/validate.ts'
import { tmpRoot } from '../helpers.ts'

const NOW = new Date('2026-10-21T10:00:00.000Z')
const setup = () => {
  const root = tmpRoot()
  const tools = createTools({ root, now: () => NOW })
  const call = (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.find(t => t.name === name)
    if (tool === undefined) throw new Error(`no tool ${name}`)
    return tool.handler(args)
  }
  const events = (id: string) => readEvents(swarmLogPath(root, id)).events
  return { root, tools, call, events }
}

test('exactly the eight omnis tools are offered, each with an object schema', () => {
  const { tools } = setup()
  assert.deepEqual(tools.map(t => t.name).sort(), [
    'omnis_memory_get', 'omnis_memory_list', 'omnis_memory_put', 'omnis_swarm_end',
    'omnis_swarm_init', 'omnis_swarm_status', 'omnis_task_create', 'omnis_task_update',
  ])
  for (const t of tools) assert.equal(t.inputSchema.type, 'object')
})

test('swarm_init starts a named swarm and makes it current', () => {
  const { root, call, events } = setup()
  const r = call('omnis_swarm_init', { name: 'Auth Refactor', topology: 'mesh', goal: 'ship it' })
  assert.match(r.text, /auth-refactor/)
  assert.equal(readCurrent(root), 'auth-refactor')
  assert.deepEqual(events('auth-refactor')[0]?.data, { name: 'Auth Refactor', topology: 'mesh', goal: 'ship it', implicit: false })
})

test('swarm_init with a Windows reserved name still gets a valid id', () => {
  const { root, call } = setup()
  call('omnis_swarm_init', { name: 'NUL', topology: 'mesh' })
  const id = readCurrent(root)
  assert.ok(id !== null && /^[a-z0-9][a-z0-9-]*$/.test(id) && id !== 'nul', `id was ${id}`)
})

test('swarm_init names the implicit session swarm instead of starting another', () => {
  const { root, call, events } = setup()
  call('omnis_memory_put', { key: 'k', value: 'v' })
  const implicit = readCurrent(root)!
  assert.equal(implicit, 'session-20261021-100000')
  call('omnis_swarm_init', { name: 'Auth', topology: 'star' })
  assert.equal(readCurrent(root), implicit)
  const started = events(implicit).filter(e => e.type === 'swarm.started')
  assert.equal(started.length, 2)
  assert.deepEqual(started[1]?.data, { name: 'Auth', topology: 'star', implicit: false })
})

test('swarm_init while an explicit swarm runs ends it and starts the new one', () => {
  const { root, call, events } = setup()
  call('omnis_swarm_init', { name: 'First', topology: 'mesh' })
  call('omnis_swarm_init', { name: 'Second', topology: 'mesh' })
  assert.equal(readCurrent(root), 'second')
  assert.deepEqual(events('first').at(-1)?.data, { outcome: 'replaced' })
})

test('bad input is refused with an InputError', () => {
  const { call } = setup()
  assert.throws(() => call('omnis_swarm_init', { name: 'x', topology: 'ring' }), InputError)
  assert.throws(() => call('omnis_swarm_init', { topology: 'mesh' }), InputError)
  assert.throws(() => call('omnis_memory_put', { key: 'bad key!', value: 'v' }), InputError)
  assert.throws(() => call('omnis_memory_put', { key: '__proto__', value: 'v' }), InputError)
  assert.throws(() => call('omnis_memory_put', { key: 'k', value: 'é'.repeat(2049) }), InputError)
})

test('memory put, get and list round-trip and log a preview', () => {
  const { root, call, events } = setup()
  call('omnis_swarm_init', { name: 'Mem', topology: 'mesh' })
  call('omnis_memory_put', { key: 'design/auth', value: 'use the repo pattern', agent: 'coder' })
  assert.equal(call('omnis_memory_get', { key: 'design/auth' }).text, 'use the repo pattern')
  assert.match(call('omnis_memory_get', { key: 'nope' }).text, /No value/)
  assert.match(call('omnis_memory_list', {}).text, /design\/auth · coder/)
  assert.match(call('omnis_memory_list', { prefix: 'zzz' }).text, /No keys/)
  const put = events(readCurrent(root)!).find(e => e.type === 'memory.put')
  assert.equal(put?.agent, 'coder')
  assert.deepEqual(put?.data, { key: 'design/auth', bytes: 20, preview: 'use the repo pattern' })
})

test('the 513th distinct key comes back as an error result, not a crash', () => {
  const { root, tools, call } = setup()
  call('omnis_swarm_init', { name: 'Full', topology: 'mesh' })
  for (let i = 0; i < 512; i++) putMemory(root, readCurrent(root)!, `k${i}`, 'v', 'lead', NOW)
  const reply = handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'omnis_memory_put', arguments: { key: 'k512', value: 'v' } } },
    tools,
    { name: 't', version: '0' },
  )
  const result = reply?.result as { isError: boolean; content: { text: string }[] }
  assert.equal(result.isError, true)
  assert.match(result.content[0]!.text, /full/)
})

test('tasks are created with sequential ids and updated', () => {
  const { root, call, events } = setup()
  call('omnis_swarm_init', { name: 'Tasks', topology: 'hierarchical' })
  assert.match(call('omnis_task_create', { title: 'Write auth', assignee: 'coder' }).text, /t1/)
  assert.match(call('omnis_task_create', { title: 'Test auth', dependsOn: ['t1'] }).text, /t2/)
  call('omnis_task_update', { id: 't1', state: 'done', note: 'merged' })
  assert.throws(() => call('omnis_task_update', { id: 't9', state: 'done' }), InputError)
  const types = events(readCurrent(root)!).map(e => e.type)
  assert.deepEqual(types.filter(t => t.startsWith('task.')), ['task.created', 'task.created', 'task.updated'])
})

test('status describes the swarm, and end clears it', () => {
  const { call } = setup()
  assert.match(call('omnis_swarm_status').text, /No swarm is running/)
  call('omnis_swarm_init', { name: 'Status', topology: 'mesh' })
  call('omnis_task_create', { title: 'x' })
  const text = call('omnis_swarm_status').text
  assert.match(text, /Status \[status\] \(mesh\)/)
  assert.match(text, /Tasks: 1 pending/)
  call('omnis_swarm_end', { outcome: 'done' })
  assert.match(call('omnis_swarm_status').text, /No swarm is running/)
  assert.throws(() => call('omnis_swarm_end'), InputError)
})

test('null-prototype arguments work', () => {
  const { call } = setup()
  const args = Object.assign(Object.create(null) as Record<string, unknown>, { name: 'NP', topology: 'star' })
  assert.match(call('omnis_swarm_init', args).text, /np/)
})
