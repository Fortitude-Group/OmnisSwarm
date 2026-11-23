/**
 * The model default rules (docs/superpowers/specs/2026-11-23-model-defaults-design.md, "The rules"): which model a
 * subagent the lead named none for gets, by its type and the words of its description. Pure.
 */
import { MODEL_ALIASES, type ModelAlias } from './events.ts'

/** The modelDefaultRules default in plugin.json, exactly. */
export const DEFAULT_RULES = 'Plan = none; * ~ review, security, audit = none; Explore = sonnet; * ~ test, tests, testing, commit, commits, lint, linting, format, formatting, typecheck, run the build, build and test = sonnet'

export const MAX_RULES = 20
export const MAX_WORDS = 30

/** `type` an agent type or `*`; `words` lower-cased, empty for a rule on the type alone; `none` leaves the agent alone. */
export type Rule = { type: string; words: string[]; model: ModelAlias | 'none' }

const MODELS: readonly string[] = [...MODEL_ALIASES, 'none']
const TYPE = /^(\*|[^\s=~,;*]+)$/

/** One rule, or the reason it doesn't parse. */
function parseOne(text: string): Rule | string {
  const parts = text.split('=')
  if (parts.length !== 2) return parts.length < 2 ? 'it needs "= <model>"' : 'it has more than one "="'
  const model = parts[1]!.trim().toLowerCase()
  if (!MODELS.includes(model)) return 'the model must be haiku, sonnet, opus, fable or none'
  const left = parts[0]!
  const tilde = left.indexOf('~')
  const type = (tilde < 0 ? left : left.slice(0, tilde)).trim()
  if (!TYPE.test(type)) return type === '' ? 'it needs an agent type or *' : 'the agent type must be one word or *'
  let words: string[] = []
  if (tilde >= 0) {
    words = left.slice(tilde + 1).split(',').map(w => w.trim().replace(/\s+/g, ' ').toLowerCase())
    if (words.some(w => w === '' || w.includes('~'))) return 'after "~" it needs words or phrases split by commas'
    if (words.length > MAX_WORDS) return `it has more than ${MAX_WORDS} words`
  }
  return { type, words, model: model as Rule['model'] }
}

/** Rules split on `;` or new lines. A bad one is skipped and named in `errors`; past MAX_RULES the rest are dropped. */
export function parseRules(text: string): { rules: Rule[]; errors: string[] } {
  const rules: Rule[] = []
  const errors: string[] = []
  const pieces = text.split(/[;\n]/).map(p => p.trim()).filter(p => p !== '')
  for (const piece of pieces) {
    if (rules.length === MAX_RULES) {
      errors.push(`Only ${MAX_RULES} rules are read; skipped "${piece}" and any after it.`)
      break
    }
    const got = parseOne(piece)
    if (typeof got === 'string') errors.push(`Skipped "${piece}": ${got}.`)
    else rules.push(got)
  }
  return { rules, errors }
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Whether `text` holds `phrase` as whole words, ignoring case; the phrase's spaces match any run of whitespace. */
function hasWords(text: string, phrase: string): boolean {
  const body = phrase.split(' ').map(escape).join('\\s+')
  return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, 'iu').test(text)
}

/** The first rule for this type (ignoring case, or `*`) whose words, if any, the description holds. */
export function matchRule(rules: readonly Rule[], type: string, description: string): Rule | null {
  const lower = type.toLowerCase()
  for (const rule of rules) {
    if (rule.type !== '*' && rule.type.toLowerCase() !== lower) continue
    if (rule.words.length === 0 || rule.words.some(w => hasWords(description, w))) return rule
  }
  return null
}

/** The rule as /omnis models prints it: `Explore = sonnet`, `* ~ test, tests = sonnet`. */
export function ruleText(rule: Rule): string {
  return rule.words.length === 0 ? `${rule.type} = ${rule.model}` : `${rule.type} ~ ${rule.words.join(', ')} = ${rule.model}`
}

/** The rules as the modelDefaultRules setting holds them. */
export function formatRules(rules: readonly Rule[]): string {
  return rules.map(ruleText).join('; ')
}

/** haiku 1 < sonnet 2 < opus 3 < fable or mythos 4, found anywhere in an alias or id; null for any other family. */
export function modelRank(idOrAlias: string): number | null {
  const m = idOrAlias.toLowerCase()
  if (m.includes('haiku')) return 1
  if (m.includes('sonnet')) return 2
  if (m.includes('opus')) return 3
  if (m.includes('fable') || m.includes('mythos')) return 4
  return null
}
