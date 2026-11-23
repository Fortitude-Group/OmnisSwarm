/**
 * /omnis models (model defaults design, "/omnis models"): shows the model default rules, turns them on or off, adds,
 * removes or resets them. A change applies at once and is saved to the plugin's settings with $.config.set.
 */
import type { EngineInterface } from 'claude-code'
import { DEFAULT_RULES, MAX_RULES, formatRules, parseRules, ruleText } from '../core/model-rules.ts'
import type { Sub } from './commands.ts'
import { modelDefaultsView, setModelDefaults } from './model-default.ts'

const USAGE = 'Usage: /omnis models shows the model default rules; /omnis models on|off; /omnis models add <rule> puts a rule first; /omnis models remove <n>; /omnis models reset.'

export const modelsSub: Sub = {
  name: 'models',
  describe: '/omnis models shows or changes the model default rules',
  hint: 'models [on|off | add <rule> | remove <n> | reset]',
  usage: USAGE,
}

const UNSAVED = " It applies for this session but couldn't be saved to your settings; set it in /config."
const LATER = ' Model defaults were off when the session started, so this takes effect from the next session.'

/** Saves one setting; false when a hook or the engine refused it, or it threw. */
async function save($: EngineInterface, field: 'modelDefaults' | 'modelDefaultRules', value: string): Promise<boolean> {
  try {
    const result = await $.config.set({ key: `${$.plugin.name}.${field}`, value })
    return result.deny === undefined
  } catch {
    return false
  }
}

function viewText(): string {
  const v = modelDefaultsView()
  const state = v.on ? 'on' : 'off'
  const lines = [`Model defaults: ${state}${v.on && !v.registered ? ' from the next session' : ''}. Agents defaulted this session: ${v.defaulted}.`]
  if (v.rules.length === 0) lines.push('No rules: no agent is given a model.')
  else {
    lines.push('Rules, the first that matches wins:')
    v.rules.forEach((r, i) => lines.push(`${i + 1}. ${ruleText(r)}`))
  }
  if (v.errors.length > 0) lines.push("Rules that didn't parse:", ...v.errors.map(e => `- ${e}`))
  return lines.join('\n')
}

/** Applies new rules at once, then saves them. */
async function saveRules($: EngineInterface, text: string, reply: string): Promise<string> {
  const before = modelDefaultsView()
  const dropped = before.errors.length > 0 ? " The rules that didn't parse were dropped." : ''
  setModelDefaults({ rules: text })
  const saved = await save($, 'modelDefaultRules', text)
  return `${reply}${dropped}${saved ? '' : UNSAVED}${before.registered ? '' : LATER}`
}

/** `words` are the lower-cased words after /omnis, "models" first. */
export async function modelsCommand($: EngineInterface, words: readonly string[]): Promise<string | null> {
  const sub = words[1]
  if (sub === undefined) return viewText()
  if ((sub === 'on' || sub === 'off') && words.length === 2) {
    const registered = modelDefaultsView().registered
    setModelDefaults({ on: sub === 'on' })
    const saved = await save($, 'modelDefaults', sub)
    return `Model defaults ${sub}.${saved ? '' : UNSAVED}${sub === 'on' && !registered ? LATER : ''}`
  }
  if (sub === 'reset' && words.length === 2) return saveRules($, DEFAULT_RULES, 'Model default rules are back to the defaults.')
  if (sub === 'remove' && words.length === 3) {
    const rules = modelDefaultsView().rules
    const n = /^\d+$/.test(words[2]!) ? Number(words[2]) : 0
    if (n < 1 || n > rules.length) return rules.length === 0 ? 'There are no rules to remove.' : `Give a rule number from 1 to ${rules.length}.`
    const gone = rules[n - 1]!
    return saveRules($, formatRules(rules.filter((_, i) => i !== n - 1)), `Removed rule ${n}: ${ruleText(gone)}.`)
  }
  if (sub === 'add' && words.length > 2) {
    const { rules: added, errors } = parseRules(words.slice(2).join(' '))
    if (errors.length > 0) return `${errors[0]} ${USAGE}`
    if (added.length !== 1) return `Add one rule at a time. ${USAGE}`
    const rules = modelDefaultsView().rules
    if (rules.length >= MAX_RULES) return `There are already ${MAX_RULES} rules; remove one first.`
    return saveRules($, formatRules([added[0]!, ...rules]), `Added as rule 1: ${ruleText(added[0]!)}.`)
  }
  return USAGE
}
