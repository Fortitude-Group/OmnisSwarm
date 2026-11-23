import { expect, test, type TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'
import { DEFAULT_RULES } from '../core/model-rules.ts'
import { KIT, RUN, engine } from './test-engine.ts'

type Engine = Parameters<TestBody>[0]
const LAST = '4. * ~ test, tests, testing, commit, commits, lint, linting, format, formatting, typecheck, run the build, build and test = sonnet'
const UNSAVED = " It applies for this session but couldn't be saved to your settings; set it in /config."

/** The test engine, plus config.set (refused when `deny` is set), env.get and agent.spawn, which answer what they were given. */
function boot(on: On) {
  const seen = { sets: [] as Array<{ key: string; value: unknown }>, spawned: [] as string[], deny: false }
  engine(on)
  on('config.set', (_$, e) => {
    seen.sets.push({ key: e.key, value: e.value })
    return seen.deny ? { deny: 'locked' } : { value: e.value }
  })
  on('env.get', () => ({ value: undefined }))
  let id = 0
  on('agent.spawn', (_$, e) => {
    seen.spawned.push(`${e.subagentType}:${e.model ?? '-'}`)
    return { model: e.model ?? 'claude-opus-5-5', agentId: `a${++id}` }
  })
  return seen
}
const start = ($: Engine) => $.session.start({ cwd: '/p', surface: null, isInteractive: true })
const run = async ($: Engine, args: string) => (await $.command.run({ command: 'omnis', args, ...RUN })).text ?? ''
let n = 0
const spawn = ($: Engine, subagentType: string, description = 'look around') => $.agent.spawn({
  tool_use_id: `toolu_${++n}`, subagentType, description, prompt: 'p', provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5', background: true, fork: false,
} as never)

test('/omnis models shows the switch, the numbered rules and the count', KIT, async ($, on) => {
  boot(on)
  await start($)
  await spawn($, 'Explore')
  expect(await run($, 'models')).toBe([
    'Model defaults: on. Agents defaulted this session: 1.',
    'Rules, the first that matches wins:',
    '1. Plan = none',
    '2. * ~ review, security, audit = none',
    '3. Explore = sonnet',
    LAST,
  ].join('\n'))
})

test('/omnis models add puts the rule first, saves it and applies it at once', KIT, async ($, on) => {
  const seen = boot(on)
  await start($)
  expect(await run($, 'models add Explore = HAIKU')).toBe('Added as rule 1: explore = haiku.')
  expect(seen.sets).toEqual([{ key: 'omnis-swarm.modelDefaultRules', value: `explore = haiku; ${DEFAULT_RULES}` }])
  await spawn($, 'Explore')
  expect(seen.spawned).toEqual(['Explore:haiku'])
  expect((await run($, 'models')).split('\n')[2]).toBe('1. explore = haiku')
})

test('/omnis models add with words rejoins them, and refuses a rule that does not parse', KIT, async ($, on) => {
  const seen = boot(on)
  await start($)
  expect(await run($, 'models add general-purpose ~ Write   Docs = haiku')).toBe('Added as rule 1: general-purpose ~ write docs = haiku.')
  const bad = await run($, 'models add Explore = gpt')
  expect(bad.startsWith('Skipped "explore = gpt": the model must be haiku, sonnet, opus, fable or none. Usage: /omnis models')).toBe(true)
  expect(await run($, 'models add a = haiku; b = haiku')).toBe(`Add one rule at a time. Usage: /omnis models shows the model default rules; /omnis models on|off; /omnis models add <rule> puts a rule first; /omnis models remove <n>; /omnis models reset.`)
  expect(seen.sets.length).toBe(1)
})

test('/omnis models remove and reset', KIT, async ($, on) => {
  const seen = boot(on)
  await start($)
  expect(await run($, 'models remove 3')).toBe('Removed rule 3: Explore = sonnet.')
  await spawn($, 'Explore')
  expect(seen.spawned).toEqual(['Explore:-'])
  expect(await run($, 'models remove 9')).toBe('Give a rule number from 1 to 3.')
  expect(await run($, 'models remove x')).toBe('Give a rule number from 1 to 3.')
  expect(await run($, 'models reset')).toBe('Model default rules are back to the defaults.')
  expect(seen.sets.map(s => s.value)).toEqual([
    'Plan = none; * ~ review, security, audit = none; * ~ test, tests, testing, commit, commits, lint, linting, format, formatting, typecheck, run the build, build and test = sonnet',
    DEFAULT_RULES,
  ])
})

test('/omnis models off stops filling at once and saves the switch; on starts it again', KIT, async ($, on) => {
  const seen = boot(on)
  await start($)
  expect(await run($, 'models off')).toBe('Model defaults off.')
  await spawn($, 'Explore')
  expect(await run($, 'models on')).toBe('Model defaults on.')
  await spawn($, 'Plan')
  await spawn($, 'general-purpose', 'run the tests')
  expect(seen.spawned).toEqual(['Explore:-', 'Plan:-', 'general-purpose:sonnet'])
  expect(seen.sets).toEqual([{ key: 'omnis-swarm.modelDefaults', value: 'off' }, { key: 'omnis-swarm.modelDefaults', value: 'on' }])
})

test('a refused save still applies for the session and says so', KIT, async ($, on) => {
  const seen = boot(on)
  seen.deny = true
  await start($)
  expect(await run($, 'models off')).toBe(`Model defaults off.${UNSAVED}`)
  expect((await run($, 'models')).split('\n')[0]).toBe('Model defaults: off. Agents defaulted this session: 0.')
  expect(await run($, 'models add Plan = haiku')).toBe(`Added as rule 1: plan = haiku.${UNSAVED}`)
})

test('off at load: on is saved for the next session', { ...KIT, options: { modelDefaults: 'off' } }, async ($, on) => {
  const seen = boot(on)
  await start($)
  expect((await run($, 'models')).split('\n')[0]).toBe('Model defaults: off. Agents defaulted this session: 0.')
  expect(await run($, 'models on')).toBe('Model defaults on. Model defaults were off when the session started, so this takes effect from the next session.')
  expect((await run($, 'models')).split('\n')[0]).toBe('Model defaults: on from the next session. Agents defaulted this session: 0.')
  await spawn($, 'Explore')
  expect(seen.spawned).toEqual(['Explore:-'])
})

test('rules that did not parse are shown, and anything else answers the usage', { ...KIT, options: { modelDefaultRules: 'Explore = sonnet; nonsense' } }, async ($, on) => {
  boot(on)
  await start($)
  expect(await run($, 'models')).toBe([
    'Model defaults: on. Agents defaulted this session: 0.',
    'Rules, the first that matches wins:',
    '1. Explore = sonnet',
    "Rules that didn't parse:",
    '- Skipped "nonsense": it needs "= <model>".',
  ].join('\n'))
  expect((await run($, 'models frobnicate')).startsWith('Usage: /omnis models')).toBe(true)
  expect((await run($, 'models on now')).startsWith('Usage: /omnis models')).toBe(true)
})
