import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { KIT } from './test-engine.ts'

// The kit loads the plugin's own register.ts, so these drive model defaults through the real hooks, the spawn hold
// beneath them included. The hooks here stand for the engine (agent.spawn starts a1, a2, ... and answers the model it
// resolved), its file system (a small tree of agent files), its environment and the MCP server.

const SID = 'abcdef12-3456-7890-abcd-ef1234567890'
const T0 = Date.parse('2026-11-23T10:00:00.000Z')
const OPUS = 'claude-opus-5-5'
const SONNET = 'claude-sonnet-4-6'
type Rec = { type: string; agent?: string; data: Record<string, unknown> }
type Seen = { records: Rec[]; started: string[]; waits: Array<() => void>; refuse: number; reads: number }

/** The files the stub file system holds; folders are every prefix of a path. */
const FILES: Record<string, string> = {
  '/p/.claude/agents/omnis/dev.md': '---\nname: dev\ndescription: builds\nmodel: opus\n---\nYou build.',
  '/p/.claude/agents/writer.md': '---\r\nname: "writer"\r\ndescription: writes\r\n---\r\nYou write.',
  '/home/u/.claude/agents/clerk.md': '---\nmodel: inherit\n---\n',
  '/home/u/.claude/agents/sub/porter.md': '---\nname: porter\ndescription: carries\n---\n',
  '/home/u/.claude/plugins/installed_plugins.json': JSON.stringify({
    version: 2,
    plugins: { 'kit@market': [{ scope: 'user', installPath: '/plug/kit', version: '1.0.0' }] },
  }),
  '/plug/kit/agents/helper.md': '---\nname: helper\nmodel: haiku\n---\n',
  '/plug/kit/agents/plain.md': '---\nname: plain\n---\n',
}

function engine(on: On, env: Record<string, string> = { HOME: '/home/u' }): Seen {
  const seen: Seen = { records: [], started: [], waits: [], refuse: 0, reads: 0 }
  let id = 0
  // The engine resolves a path before the hooks see it: on Windows /p/x arrives as c:\p\x, so it is put back.
  const posix = (path: string) => path.replace(/^[A-Za-z]:/, '').replaceAll('\\', '/').replace(/\/$/, '')
  const isDir = (path: string) => Object.keys(FILES).some(f => f.startsWith(`${path}/`))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SID }))
  on('state.get', () => ({ value: { value: undefined, version: 0 } }))
  on('state.set', () => ({ value: { isSet: true as const, version: 1 } }))
  on('agent.list', () => ({ value: [] }))
  on('env.get', (_$, e) => ({ value: env[e.name] }))
  // The working directory ('.', which the kit resolves to the plugin's folder, outside this tree) lands at /p.
  on('fs.stat', (_$, e) => {
    const path = posix(e.path)
    const inTree = FILES[path] !== undefined || isDir(path)
    return { value: { kind: FILES[path] === undefined ? 'dir' as const : 'file' as const, size: 0, mtimeMs: 0, isLink: false, ...(e.resolve && { realPath: inTree ? path : '/p' }) } }
  })
  on('fs.exists', (_$, e) => ({ value: FILES[posix(e.path)] !== undefined || isDir(posix(e.path)) }))
  on('fs.list', (_$, e) => {
    const dir = posix(e.path)
    if (!isDir(dir)) throw new Error('ENOENT')
    const names = new Map<string, 'file' | 'dir'>()
    for (const f of Object.keys(FILES)) {
      if (!f.startsWith(`${dir}/`)) continue
      const rest = f.slice(dir.length + 1).split('/')
      names.set(rest[0]!, rest.length === 1 ? 'file' : 'dir')
    }
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', (_$, e) => {
    seen.reads++
    const text = FILES[posix(e.path)]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'plugin:omnis-swarm:omnis-swarm' } }))
  on('mcp.call', (_$, e) => {
    const ok = { value: { content: [{ type: 'text' as const, text: 'ok s1' }], isError: false } }
    if (e.tool === 'omnis_wait') return new Promise(resolve => seen.waits.push(() => resolve(ok)))
    const a = e.args as Rec
    seen.records.push({ type: a.type, ...(a.agent !== undefined && { agent: a.agent }), data: a.data })
    return ok
  })
  on('agent.spawn', (_$, e) => {
    if (seen.refuse > 0) {
      seen.refuse--
      return { deny: 'refused' }
    }
    const agentId = `a${++id}`
    seen.started.push(`${agentId}:${e.subagentType}:${e.model ?? '-'}`)
    return { model: e.model === 'sonnet' ? SONNET : e.model === 'haiku' ? 'claude-haiku-4-5' : OPUS, agentId }
  })
  on('turn.step', async function* (_$, e) {
    yield { kind: 'text' as const, index: 0, text: 'hi' }
    return { turnId: e.turnId, index: e.index, answer: 'hi', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  on('turn.complete', () => ({ text: '' }))
  return seen
}

async function boot($: Engine, on: On, env?: Record<string, string>) {
  const clock = mock.clock(on, { now: T0 })
  const seen = engine(on, env)
  await $.session.start({ cwd: '/p', surface: null, isInteractive: false })
  await clock.settle()
  return { clock, seen }
}

let n = 0
function spawn($: Engine, subagentType: string, description = 'look around', extra: Record<string, unknown> = {}) {
  const box: { done: boolean } = { done: false }
  const p = $.agent.spawn({
    tool_use_id: `toolu_${++n}`, subagentType, description, prompt: 'p', provider: { plugin: 'engine', tier: 'core' },
    parentModel: OPUS, background: true, fork: false, ...extra,
  } as never).then(r => {
    box.done = true
    return r
  })
  return { box, p }
}
async function drain<R>(stream: AsyncGenerator<unknown, R>): Promise<R> {
  let next = await stream.next()
  while (next.done !== true) next = await stream.next()
  return next.value
}
const step = ($: Engine, agentId: string) => drain($.turn.step({ turnId: `t${++n}`, index: 0, model: SONNET, messageCount: 1, agentId }))
const defaults = (seen: Seen) => seen.records.filter(r => r.type === 'model.defaulted')

test('no model: filled with the rule\'s alias and recorded with what core resolved', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  const r = await spawn($, 'Explore').p
  await clock.settle()
  expect(r).toEqual({ model: SONNET, agentId: 'a1' })
  expect(seen.started).toEqual(['a1:Explore:sonnet'])
  expect(defaults(seen)).toEqual([{ type: 'model.defaulted', agent: 'a1', data: { role: 'Explore', model: 'sonnet', rule: 'Explore = sonnet', resolved: SONNET } }])
})

test('an explicit model is left alone and nothing is recorded', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await spawn($, 'Explore', 'look around', { model: 'opus' }).p
  await spawn($, 'general-purpose', 'run tests', { model: 'haiku' }).p
  await clock.settle()
  expect(seen.started).toEqual(['a1:Explore:opus', 'a2:general-purpose:haiku'])
  expect(defaults(seen)).toEqual([])
})

test('a project agent file with its own model is left alone, one with none is filled', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await spawn($, 'dev', 'run tests').p
  await spawn($, 'writer', 'Run the tests').p
  await clock.settle()
  expect(seen.started).toEqual(['a1:dev:-', 'a2:writer:sonnet'])
  // The default rule is 127 characters and the event carries up to 200, so it's recorded whole.
  const rule = String(defaults(seen)[0]!.data.rule)
  expect(rule).toBe('* ~ test, tests, testing, commit, commits, lint, linting, format, formatting, typecheck, run the build, build and test = sonnet')
})

test('a user agent file with model: inherit is left alone, one with none is filled', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await spawn($, 'clerk', 'run tests').p
  await spawn($, 'porter', 'run tests').p
  await clock.settle()
  expect(seen.started).toEqual(['a1:clerk:-', 'a2:porter:sonnet'])
})

test('CLAUDE_CONFIG_DIR is where user agents are read from', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on, { HOME: '/nowhere', CLAUDE_CONFIG_DIR: '/home/u/.claude' })
  await spawn($, 'porter', 'run tests').p
  await clock.settle()
  expect(seen.started).toEqual(['a1:porter:sonnet'])
})

test('a plugin agent with its own model is left alone, one without is filled', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await spawn($, 'kit:helper', 'run tests').p
  await spawn($, 'kit:plain', 'run tests').p
  await spawn($, 'gone:plain', 'run tests').p
  await clock.settle()
  expect(seen.started).toEqual(['a1:kit:helper:-', 'a2:kit:plain:sonnet', 'a3:gone:plain:-'])
})

test('an unknown type, claude-code-guide and Plan are left alone', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await spawn($, 'mystery', 'run tests').p
  await spawn($, 'claude-code-guide', 'run tests').p
  await spawn($, 'Plan', 'run tests').p
  await spawn($, 'web-fetch', 'run tests').p
  await spawn($, 'statusline-setup', 'run tests').p
  await clock.settle()
  expect(seen.started).toEqual(['a1:mystery:-', 'a2:claude-code-guide:-', 'a3:Plan:-', 'a4:web-fetch:-', 'a5:statusline-setup:-'])
  expect(defaults(seen)).toEqual([])
})

test('a description rule fills general-purpose, a title does not', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await spawn($, 'general-purpose', 'Run tests and commit').p
  await spawn($, 'general-purpose', 'Build film mode core').p
  await spawn($, 'Explore', 'Security review of the auth').p
  await clock.settle()
  expect(seen.started).toEqual(['a1:general-purpose:sonnet', 'a2:general-purpose:-', 'a3:Explore:-'])
})

test('CLAUDE_CODE_SUBAGENT_MODEL or its FORCE set: left alone', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on, { HOME: '/home/u', CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' })
  await spawn($, 'Explore').p
  await clock.settle()
  expect(seen.started).toEqual(['a1:Explore:-'])
  expect(defaults(seen)).toEqual([])
})

test('CLAUDE_CODE_SUBAGENT_MODEL_FORCE set: left alone', KIT, async ($, on) => {
  const { seen } = await boot($, on, { HOME: '/home/u', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' })
  await spawn($, 'Explore').p
  expect(seen.started).toEqual(['a1:Explore:-'])
})

test('a parent already on sonnet, or on an unknown family, is not filled', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  // Different types, so the spawn hold doesn't make the second wait on the first.
  await spawn($, 'Explore', 'x', { parentModel: SONNET }).p
  await spawn($, 'general-purpose', 'run tests', { parentModel: 'gpt-5' }).p
  await clock.settle()
  expect(seen.started).toEqual(['a1:Explore:-', 'a2:general-purpose:-'])
  expect(defaults(seen)).toEqual([])
})

test('forks, resumed, teammate and workflow agents are left alone', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await spawn($, 'Explore', 'x', { fork: true }).p
  await spawn($, 'Explore', 'x', { resume: { agentId: 'old' } }).p
  await spawn($, 'Explore', 'x', { isTeammate: true }).p
  await spawn($, 'Explore', 'x', { workflow: { runId: 'wf_1', agentIndex: 1 } }).p
  await clock.settle()
  expect(seen.started).toEqual(['a1:Explore:-', 'a2:Explore:-', 'a3:Explore:-', 'a4:Explore:-'])
})

test('a denied spawn records nothing', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  seen.refuse = 1
  expect(await spawn($, 'Explore').p).toEqual({ deny: 'refused' })
  await clock.settle()
  expect(defaults(seen)).toEqual([])
})

test('off: nothing is filled', { ...KIT, options: { modelDefaults: 'off' } }, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await spawn($, 'Explore').p
  await clock.settle()
  expect(seen.started).toEqual(['a1:Explore:-'])
  expect(defaults(seen)).toEqual([])
})

test('the rules setting is used in place of the defaults', { ...KIT, options: { modelDefaultRules: 'Explore = haiku; garbage' } }, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await spawn($, 'Explore').p
  await spawn($, 'general-purpose', 'run tests').p
  await clock.settle()
  expect(seen.started).toEqual(['a1:Explore:haiku', 'a2:general-purpose:-'])
})

test('agent files are read once per type within 30 seconds', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await spawn($, 'writer', 'run tests').p
  const reads = seen.reads
  expect(reads > 0).toBe(true)
  // Its first answer lets the next writer start without a hold.
  await step($, 'a1')
  await spawn($, 'writer', 'run tests').p
  await clock.settle()
  expect(seen.started).toEqual(['a1:writer:sonnet', 'a2:writer:sonnet'])
  expect(seen.reads).toBe(reads)
})

test('the spawn hold groups defaulted agents on the filled-in model', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await spawn($, 'Explore').p
  const second = spawn($, 'Explore')
  await clock.settle()
  expect(second.box.done).toBe(false)
  expect(seen.started).toEqual(['a1:Explore:sonnet'])
  await step($, 'a1')
  await second.p
  await clock.settle()
  expect(seen.started).toEqual(['a1:Explore:sonnet', 'a2:Explore:sonnet'])
  expect(defaults(seen).map(r => r.agent)).toEqual(['a1', 'a2'])
  expect(seen.records.filter(r => r.type === 'spawn.held').map(r => r.data.phase)).toEqual(['start', 'end'])
})

test('an explicit opus Explore and a defaulted one do not hold each other', KIT, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await spawn($, 'Explore', 'x', { model: 'opus' }).p
  await spawn($, 'Explore').p
  await clock.settle()
  expect(seen.started).toEqual(['a1:Explore:opus', 'a2:Explore:sonnet'])
  expect(seen.records.filter(r => r.type === 'spawn.held')).toEqual([])
})
