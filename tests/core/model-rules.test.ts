import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_RULES, formatRules, matchRule, modelRank, parseRules, ruleText } from '../../src/core/model-rules.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const defaults = parseRules(DEFAULT_RULES).rules
const pick = (type: string, description: string) => {
  const rule = matchRule(defaults, type, description)
  return rule === null ? null : ruleText(rule)
}

test('DEFAULT_RULES is the modelDefaultRules default in plugin.json', () => {
  const manifest = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'))
  assert.equal(DEFAULT_RULES, manifest.userConfig.modelDefaultRules.default)
})

test('the default rules parse with no errors, in order', () => {
  const { rules, errors } = parseRules(DEFAULT_RULES)
  assert.deepEqual(errors, [])
  assert.deepEqual(rules.map(ruleText), [
    'Plan = none',
    '* ~ review, security, audit = none',
    'Explore = sonnet',
    '* ~ test, tests, testing, commit, commits, lint, linting, format, formatting, typecheck, run the build, build and test = sonnet',
  ])
  assert.equal(formatRules(rules), DEFAULT_RULES)
})

test('rules split on ; or new lines, spaces and case are tidied', () => {
  const { rules, errors } = parseRules('explore=SONNET\n\n  *   ~  Run   Tests ,lint = haiku ;')
  assert.deepEqual(errors, [])
  assert.deepEqual(rules, [
    { type: 'explore', words: [], model: 'sonnet' },
    { type: '*', words: ['run tests', 'lint'], model: 'haiku' },
  ])
  assert.equal(formatRules(rules), 'explore = sonnet; * ~ run tests, lint = haiku')
})

test('a bad rule is skipped with an error naming it, the rest still parse', () => {
  const { rules, errors } = parseRules('Explore = gpt; = sonnet; Plan; * ~ = haiku; * ~ a,,b = haiku; a b = opus; Explore = sonnet = opus; general-purpose = opus')
  assert.deepEqual(rules.map(ruleText), ['general-purpose = opus'])
  assert.equal(errors.length, 7)
  assert.match(errors[0]!, /"Explore = gpt"/)
  assert.match(errors[0]!, /haiku, sonnet, opus, fable or none/)
  assert.match(errors[2]!, /"Plan"/)
})

test('at most 20 rules and 30 words a rule', () => {
  const many = Array.from({ length: 22 }, (_, i) => `t${i} = haiku`).join('; ')
  const a = parseRules(many)
  assert.equal(a.rules.length, 20)
  assert.equal(a.errors.length, 1)
  assert.match(a.errors[0]!, /20/)
  const words = Array.from({ length: 31 }, (_, i) => `w${i}`).join(', ')
  const b = parseRules(`* ~ ${words} = haiku; Explore = sonnet`)
  assert.deepEqual(b.rules.map(ruleText), ['Explore = sonnet'])
  assert.match(b.errors[0]!, /30 words/)
})

test('types match ignoring case, * matches any, the first match wins', () => {
  assert.equal(pick('Plan', 'Run the tests'), 'Plan = none')
  assert.equal(pick('explore', 'look around'), 'Explore = sonnet')
  assert.equal(pick('Explore', 'security review of auth'), '* ~ review, security, audit = none')
  assert.equal(pick('general-purpose', 'Build film mode core'), null)
  assert.equal(pick('general-purpose', 'Run tests and commit')?.endsWith('= sonnet'), true)
})

test('words match whole words ignoring case, a phrase across any whitespace', () => {
  const rules = parseRules('* ~ test, run the build = haiku').rules
  assert.notEqual(matchRule(rules, 'x', 'TEST it'), null)
  assert.notEqual(matchRule(rules, 'x', 'pre-test check'), null)
  assert.equal(matchRule(rules, 'x', 'Testing'), null)
  assert.equal(matchRule(rules, 'x', 'latest news'), null)
  assert.notEqual(matchRule(rules, 'x', 'then run  the\tbuild'), null)
  assert.equal(matchRule(rules, 'x', 'run the builds'), null)
  assert.equal(matchRule([], 'x', 'test'), null)
})

test('words with regex characters match literally', () => {
  const rules = parseRules('* ~ c++, a.b = haiku').rules
  assert.notEqual(matchRule(rules, 'x', 'fix c++ code'), null)
  assert.notEqual(matchRule(rules, 'x', 'see a.b'), null)
  assert.equal(matchRule(rules, 'x', 'see axb'), null)
})

test('modelRank orders the families by substring, case ignored', () => {
  assert.equal(modelRank('haiku'), 1)
  assert.equal(modelRank('claude-haiku-4-5'), 1)
  assert.equal(modelRank('Sonnet'), 2)
  assert.equal(modelRank('claude-opus-5-5'), 3)
  assert.equal(modelRank('fable'), 4)
  assert.equal(modelRank('claude-mythos-1'), 4)
  assert.equal(modelRank('gpt-5'), null)
  assert.equal(modelRank(''), null)
})
