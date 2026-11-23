/**
 * Model defaults (docs/superpowers/specs/2026-11-23-model-defaults-design.md): a subagent the lead names no model for
 * gets the model of the first matching rule, when nothing else has chosen one and it is cheaper than the lead's own.
 * Registered before the spawn hold, so the hold groups on the model that will answer. Every failure leaves the call
 * as it was.
 */
import type { EngineInterface, On, PluginOptions } from 'claude-code'
import type { ModelAlias } from '../core/events.ts'
import { DEFAULT_RULES, matchRule, modelRank, parseRules, ruleText, type Rule } from '../core/model-rules.ts'
import { clearAgentDefs, ownModelOf } from './agent-defs.ts'
import { record } from './recorder.ts'

const ROLE_MAX = 64
const RULE_MAX = 200
const RESOLVED_MAX = 64

export type ModelDefaultsView = {
  /** Whether the hook fills models in now. */
  on: boolean
  /** Whether the hook was registered at load (modelDefaults was not off then). */
  registered: boolean
  rules: readonly Rule[]
  errors: readonly string[]
  /** The rules as the setting holds them. */
  text: string
  /** Agents defaulted since the plugin loaded. */
  defaulted: number
}

/** Module state, so /omnis models applies at once. A hot reload reads the settings again. */
let state: ModelDefaultsView = { on: false, registered: false, rules: [], errors: [], text: DEFAULT_RULES, defaulted: 0 }

const cut = (s: string, max: number): string => Array.from(s).slice(0, max).join('')
/** The rule as the event carries it (at most RULE_MAX): a long one loses the end of its words, never its model. */
function ruleField(rule: Rule): string {
  const text = ruleText(rule)
  if (Array.from(text).length <= RULE_MAX) return text
  const tail = `… = ${rule.model}`
  return `${cut(text, RULE_MAX - tail.length).trimEnd()}${tail}`
}
const roleOf =(type: string): string => cut(type.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim(), ROLE_MAX) || 'unknown'

function rulesFrom(text: string): Pick<ModelDefaultsView, 'rules' | 'errors' | 'text'> {
  const { rules, errors } = parseRules(text)
  return { rules, errors, text }
}

export function modelDefaultsView(): ModelDefaultsView {
  return state
}

/** Changes the switch or the rules for this session at once (the command saves them to settings itself). */
export function setModelDefaults(change: { on?: boolean; rules?: string }): ModelDefaultsView {
  state = { ...state, ...(change.on !== undefined && { on: change.on }), ...(change.rules !== undefined && rulesFrom(change.rules)) }
  return state
}

type Spawn = { subagentType: string; description: string; parentModel: string; cwd?: string }

/** The rule whose model this spawn gets, or null to leave it alone (design "What it does", steps 1 to 4). */
async function chosen($: EngineInterface, e: Spawn): Promise<(Rule & { model: ModelAlias }) | null> {
  // 1. The person chose with the environment.
  const model = await $.env.get('CLAUDE_CODE_SUBAGENT_MODEL')
  const force = await $.env.get('CLAUDE_CODE_SUBAGENT_MODEL_FORCE')
  if ((model !== undefined && model !== '') || (force !== undefined && force !== '')) return null
  // 2. The first rule that matches; none, or `none`, leaves it.
  const rule = matchRule(state.rules, e.subagentType, typeof e.description === 'string' ? e.description : '')
  if (rule === null || rule.model === 'none') return null
  // 3. The type's own definition sets a model, or the type can't be found.
  const own = await ownModelOf($, e.subagentType, e.cwd)
  if (!own.known || own.model !== undefined) return null
  // 4. Only ever cheaper than the lead's; an unknown family is not cheaper.
  const mine = modelRank(rule.model)
  const parent = typeof e.parentModel === 'string' ? modelRank(e.parentModel) : null
  if (mine === null || parent === null || mine >= parent) return null
  return rule as Rule & { model: ModelAlias }
}

export function registerModelDefault(on: On, options: PluginOptions): void {
  const opts = options as Readonly<Record<string, unknown>>
  clearAgentDefs()
  const enabled = opts.modelDefaults !== 'off'
  const text = typeof opts.modelDefaultRules === 'string' ? opts.modelDefaultRules : DEFAULT_RULES
  state = { on: enabled, registered: enabled, defaulted: 0, ...rulesFrom(text) }
  if (!enabled) return

  // Forks always inherit; resumed, teammate and workflow agents keep what they were given.
  on('agent.spawn', { fork: false }, async ($, e, next) => {
    if (!state.on || e.resume !== undefined || e.isTeammate === true || e.workflow !== undefined || e.model !== undefined) return next(e)
    let rule: (Rule & { model: ModelAlias }) | null = null
    try {
      rule = await chosen($, e)
    } catch {
      rule = null
    }
    if (rule === null) return next(e)
    // 5. Spawn on the rule's model, and say so once it started.
    const result = await next({ ...e, model: rule.model })
    if (result.deny === undefined && typeof result.agentId === 'string') {
      state = { ...state, defaulted: state.defaulted + 1 }
      void record($, {
        type: 'model.defaulted',
        agent: result.agentId,
        data: {
          role: roleOf(e.subagentType),
          model: rule.model,
          rule: ruleField(rule),
          ...(typeof result.model === 'string' && result.model !== '' && { resolved: cut(result.model, RESOLVED_MAX) }),
        },
      })
    }
    return result
  }).catch((_$, e, next) => next(e))
}
