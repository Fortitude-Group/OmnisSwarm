import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendEvent, readCurrent, readEvents, swarmLogPath, writeCurrent } from '../../src/core/log.ts'
import { handleMessage } from '../../src/mcp/protocol.ts'
import { Session } from '../../src/mcp/session.ts'
import { MAX_TASKS, createTools } from '../../src/mcp/tools.ts'
import { InputError, optStringList } from '../../src/mcp/validate.ts'
import { ev, tmpRoot } from '../helpers.ts'

const NOW = new Date('2026-10-21T10:00:00.000Z')
const setup = () => {
  const root = tmpRoot()
  const tools = createTools({ root, now: () => NOW, session: new Session(root) })
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
  const seeded: Record<string, unknown> = {}
  for (let i = 0; i < 512; i++) seeded[`k${i}`] = { value: 'v', writer: 'lead', at: NOW.toISOString() }
  writeFileSync(join(root, '.omnis-swarm', 'memory', `${readCurrent(root)!}.json`), JSON.stringify(seeded))
  const reply = handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'omnis_memory_put', arguments: { key: 'k512', value: 'v' } } },
    tools,
    { name: 't', version: '0' },
  )
  const result = reply?.result as { isError: boolean; content: { text: string }[] }
  assert.equal(result.isError, true)
  assert.match(result.content[0]!.text, /Memory is full/)
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

// Fix round 1

const twoSessions = () => {
  const root = tmpRoot()
  const make = () => {
    const tools = createTools({ root, now: () => NOW, session: new Session(root) })
    return (name: string, args: Record<string, unknown> = {}) => tools.find(t => t.name === name)!.handler(args)
  }
  return { root, a: make(), b: make() }
}

test('two sessions in one project keep their own swarms', () => {
  const { root, a, b } = twoSessions()
  a('omnis_swarm_init', { name: 'Alpha', topology: 'mesh' })
  a('omnis_memory_put', { key: 'k', value: 'from-a' })
  b('omnis_swarm_init', { name: 'Beta', topology: 'star' })
  assert.equal(readCurrent(root), 'beta')
  // B started its own swarm and did not end A's.
  assert.equal(readEvents(swarmLogPath(root, 'alpha')).events.some(e => e.type === 'swarm.ended'), false)
  // A still reads and writes its own memory and tasks.
  assert.equal(a('omnis_memory_get', { key: 'k' }).text, 'from-a')
  b('omnis_memory_put', { key: 'k', value: 'from-b' })
  assert.equal(a('omnis_memory_get', { key: 'k' }).text, 'from-a')
  assert.match(a('omnis_task_create', { title: 'x' }).text, /t1/)
  assert.equal(readEvents(swarmLogPath(root, 'alpha')).events.at(-1)?.type, 'task.created')
  // A ending its swarm leaves B's current alone.
  a('omnis_swarm_end')
  assert.equal(readCurrent(root), 'beta')
  assert.match(b('omnis_swarm_status').text, /Beta \[beta\]/)
  // B ending clears current; A then has nothing running.
  b('omnis_swarm_end')
  assert.equal(readCurrent(root), null)
  assert.throws(() => a('omnis_task_update', { id: 't1', state: 'done' }), InputError)
})

test('a swarm ended elsewhere is no longer mine', () => {
  const { root, a } = twoSessions()
  a('omnis_swarm_init', { name: 'Gone', topology: 'mesh' })
  appendEvent(root, ev('swarm.ended', {}, { swarm: 'gone', src: 'mcp' }))
  assert.throws(() => a('omnis_memory_list'), InputError)
})

test('an explicit init does not rename another session swarm', () => {
  const { root, a, b } = twoSessions()
  a('omnis_memory_put', { key: 'k', value: 'v' }) // implicit swarm
  const implicit = readCurrent(root)!
  b('omnis_swarm_init', { name: 'Own', topology: 'mesh' })
  assert.equal(readEvents(swarmLogPath(root, implicit)).events.filter(e => e.type === 'swarm.started').length, 1)
})

test('free text with control or formatting characters is refused', () => {
  const { call } = setup()
  for (const bad of ['a\nb', 'a‮b', 'a​b']) {
    assert.throws(() => call('omnis_swarm_init', { name: bad, topology: 'mesh' }), InputError)
  }
  call('omnis_swarm_init', { name: 'ok', topology: 'mesh' })
  assert.throws(() => call('omnis_swarm_init', { name: 'ok', topology: 'mesh', goal: 'x\u0007' }), InputError)
  assert.throws(() => call('omnis_task_create', { title: 'x\ny' }), InputError)
  call('omnis_task_create', { title: 'fine' })
  assert.throws(() => call('omnis_task_update', { id: 't1', state: 'done', note: 'n\r' }), InputError)
  assert.throws(() => call('omnis_swarm_end', { outcome: 'o\u0000' }), InputError)
})

test('token-shaped values are redacted in the log preview but stored raw', () => {
  const { root, call } = setup()
  call('omnis_swarm_init', { name: 'Sec', topology: 'mesh' })
  const secret = 'ghp_ABCDEFsecrettoken123'
  call('omnis_memory_put', { key: 'k', value: `token ${secret} and ${'Z'.repeat(40)}` })
  const log = readFileSync(swarmLogPath(root, 'sec'), 'utf8')
  assert.equal(log.includes(secret), false)
  assert.equal(log.includes('ZZZZZZZZ'), false)
  assert.match(log, /\[redacted\]/)
  assert.ok(call('omnis_memory_get', { key: 'k' }).text.includes(secret))
})

test('a failed id claim leaves the old swarm running', () => {
  const { root, call, events } = setup()
  call('omnis_swarm_init', { name: 'Old', topology: 'mesh' })
  const before = events('old').length
  const dir = join(root, '.omnis-swarm', 'swarms')
  const hidden = `${dir}-away`
  renameSync(dir, hidden)
  writeFileSync(dir, 'not a folder')
  assert.throws(() => call('omnis_swarm_init', { name: 'New', topology: 'mesh' }))
  rmSync(dir)
  renameSync(hidden, dir)
  assert.equal(readCurrent(root), 'old')
  assert.equal(events('old').length, before)
})

test('task limit, and dependsOn must exist and is de-duplicated', () => {
  const { root, call, events } = setup()
  call('omnis_swarm_init', { name: 'Lim', topology: 'mesh' })
  assert.throws(() => call('omnis_task_create', { title: 'x', dependsOn: ['t5'] }), InputError)
  call('omnis_task_create', { title: 'first' })
  call('omnis_task_create', { title: 'second', dependsOn: ['t1', 't1'] })
  const created = events('lim').filter(e => e.type === 'task.created')
  assert.deepEqual((created[1]?.data as { dependsOn?: string[] }).dependsOn, ['t1'])
  for (let i = 3; i <= MAX_TASKS; i++) appendEvent(root, ev('task.created', { id: `t${i}`, title: 'bulk' }, { swarm: 'lim', src: 'mcp' }))
  assert.throws(() => call('omnis_task_create', { title: 'one too many' }), InputError)
})

test('unexpected failures give a fixed message with no path', () => {
  const { root, call } = setup()
  call('omnis_swarm_init', { name: 'First', topology: 'mesh' })
  rmSync(join(root, '.omnis-swarm', 'current'))
  mkdirSync(join(root, '.omnis-swarm', 'current'))
  let message = ''
  try {
    call('omnis_swarm_init', { name: 'Second', topology: 'mesh' })
  } catch (err) {
    message = (err as Error).message
  }
  assert.match(message, /Could not update the swarm files/)
  assert.equal(message.includes(root), false)
})

test('status lists agents and a file clash', () => {
  const { root, call } = setup()
  call('omnis_swarm_init', { name: 'Clash', topology: 'mesh' })
  for (const agent of ['alice', 'bob']) {
    appendEvent(root, ev('agent.started', { name: agent, role: 'coder', description: 'd', parent: '' }, { swarm: 'clash', agent }))
    appendEvent(root, ev('agent.tool', { phase: 'start', tool: 'Edit', kind: 'edit', subject: 'src/a.ts', isError: false }, { swarm: 'clash', agent }))
  }
  const text = call('omnis_swarm_status').text
  assert.match(text, /- alice \[coder\]/)
  assert.match(text, /- bob \[coder\]/)
  assert.match(text, /File clashes: 1/)
})

test('optStringList refuses bad items and long lists', () => {
  assert.throws(() => optStringList({ l: ['t1', 5] }, 'l', 20, 8), InputError)
  assert.throws(() => optStringList({ l: ['bad id'] }, 'l', 20, 8, /^t[0-9]+$/), InputError)
  assert.throws(() => optStringList({ l: Array.from({ length: 21 }, (_, i) => `t${i}`) }, 'l', 20, 8), InputError)
  assert.deepEqual(optStringList({ l: ['t1'] }, 'l', 20, 8), ['t1'])
})

test('memory get and list say so when no swarm is running', () => {
  const { call } = setup()
  assert.throws(() => call('omnis_memory_get', { key: 'k' }), InputError)
  assert.throws(() => call('omnis_memory_list'), InputError)
})

test('task_update takes an assignee, and swarm_end logs its outcome', () => {
  const { root, call, events } = setup()
  call('omnis_swarm_init', { name: 'Upd', topology: 'mesh' })
  call('omnis_task_create', { title: 'x' })
  call('omnis_task_update', { id: 't1', state: 'active', assignee: 'coder' })
  const upd = events('upd').find(e => e.type === 'task.updated')
  assert.deepEqual(upd?.data, { id: 't1', state: 'active', assignee: 'coder' })
  call('omnis_swarm_end', { outcome: 'shipped' })
  assert.deepEqual(events('upd').at(-1)?.data, { outcome: 'shipped' })
  assert.equal(readCurrent(root), null)
})

test('schemas carry the length hints', () => {
  const { tools } = setup()
  const props = (n: string) => tools.find(t => t.name === n)!.inputSchema.properties as Record<string, Record<string, unknown>>
  assert.equal(props('omnis_swarm_init').name?.minLength, 1)
  assert.equal(props('omnis_task_create').title?.minLength, 1)
  assert.equal(props('omnis_memory_put').value?.maxLength, 4096)
})

// Fix round 2

test('adopting another session swarm does not let init end it', () => {
  const { root, a, b } = twoSessions()
  a('omnis_swarm_init', { name: 'First', topology: 'mesh' })
  b('omnis_memory_put', { key: 'k', value: 'v' }) // B adopts 'first'
  b('omnis_swarm_init', { name: 'Second', topology: 'mesh' })
  assert.equal(readEvents(swarmLogPath(root, 'first')).events.some(e => e.type === 'swarm.ended'), false)
  assert.equal(readCurrent(root), 'second')
})

test('swarm_end on an adopted swarm lets go without ending it', () => {
  const { root, a, b } = twoSessions()
  a('omnis_swarm_init', { name: 'First', topology: 'mesh' })
  b('omnis_memory_get', { key: 'k' })
  assert.match(b('omnis_swarm_end').text, /another session/)
  assert.equal(readEvents(swarmLogPath(root, 'first')).events.some(e => e.type === 'swarm.ended'), false)
  assert.equal(readCurrent(root), 'first')
})

test('an ended current is replaced by a new swarm, not written into', () => {
  const { root, call, events } = setup()
  call('omnis_swarm_init', { name: 'Done', topology: 'mesh' })
  appendEvent(root, ev('swarm.ended', {}, { swarm: 'done', src: 'mcp' }))
  call('omnis_task_create', { title: 'x' })
  const id = readCurrent(root)!
  assert.notEqual(id, 'done')
  assert.equal(events('done').some(e => e.type === 'task.created'), false)
  assert.equal(events(id).some(e => e.type === 'task.created'), true)
})

test('JWT-shaped values are redacted in the log preview', () => {
  const { root, call } = setup()
  call('omnis_swarm_init', { name: 'Jwt', topology: 'mesh' })
  call('omnis_memory_put', { key: 'k', value: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIx.sig' })
  assert.equal(readFileSync(swarmLogPath(root, 'jwt'), 'utf8').includes('eyJhbGciOiJI'), false)
})

test('line and paragraph separators are refused in free text', () => {
  const { call } = setup()
  assert.throws(() => call('omnis_swarm_init', { name: 'a b', topology: 'mesh' }), InputError)
  assert.throws(() => call('omnis_swarm_init', { name: 'a b', topology: 'mesh' }), InputError)
})

test('losing the race to publish current means adopting the winner without owning it', () => {
  const { root, call } = setup()
  // Another session publishes `current` while this one is between claiming its id and publishing it.
  let calls = 0
  const racing = new Date(NOW)
  racing.toISOString = () => {
    if (++calls === 2) writeCurrent(root, 'winner')
    return NOW.toISOString()
  }
  const tools = createTools({ root, now: () => racing, session: new Session(root) })
  const run = (name: string, args: Record<string, unknown> = {}) => tools.find(t => t.name === name)!.handler(args)
  run('omnis_task_create', { title: 'x' })
  assert.equal(readCurrent(root), 'winner')
  assert.match(run('omnis_swarm_end').text, /another session/)
  assert.equal(readCurrent(root), 'winner')
  assert.equal(call('omnis_swarm_status').text.includes('winner'), true)
})

test('status shows this session swarm, not the shared current', () => {
  const { a, b } = twoSessions()
  a('omnis_swarm_init', { name: 'First', topology: 'mesh' })
  b('omnis_swarm_init', { name: 'Second', topology: 'mesh' })
  assert.match(a('omnis_swarm_status').text, /First \[first\]/)
  assert.match(b('omnis_swarm_status').text, /Second \[second\]/)
})
