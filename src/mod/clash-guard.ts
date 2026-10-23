/**
 * The clash guard (spec section 2): a subagent that edits a file holds it until it finishes or goes idle, and another
 * agent's edit of a held file is refused (block), let through with a word to the lead (warn), or not checked (off).
 * tool.check runs after every tool.call hook, so the recorder has already recorded the refused call's start; the
 * clash.blocked event marks it. A failure in here fails open.
 */
import type { EngineInterface, On, PluginOptions } from 'claude-code'
import { LEAD } from '../core/fold.ts'
import { agentLabel } from './agent-name.ts'
import { Holds, clashSettingFrom, normalisePath, type ClashSetting } from './holds.ts'
import { toolSubject, type Fields } from './record-events.ts'
import { record } from './recorder.ts'

const CLASH_TOOLS = ['Edit', 'Write', 'NotebookEdit']
/** Every turn end. A matcher is needed because the recorder already holds the one unmatched turn.complete hook. */
const FINISHED = ['answer', 'aborted', 'refusal', 'error'] as const

export const refusalText = (holder: string, path: string): string => `${holder} is editing ${path}. Message them, or wait until they finish.`
export const warnText = (agent: string, path: string, holder: string): string =>
  `[OmnisSwarm clash guard] ${agent} edited ${path} while ${holder} holds it.`

/** Module state; a hot reload drops every hold, which is safe: the next edit takes a fresh one. */
let holds = new Holds()
let setting: ClashSetting = 'block'

type Look = { key: string; shown: string; subject: string; agent: string | null; holder: string | null; now: number; undo: () => void }

/**
 * What a real file-tool call is about, or null when it isn't the guard's business. The clash check and the hold's
 * reservation happen with no await between them, so two agents racing for a fresh file can't both pass.
 */
async function look($: EngineInterface, e: { tool: string; input: unknown; tool_use_id?: string; agentId?: string }): Promise<Look | null> {
  if (e.tool_use_id === undefined) return null
  const input = (typeof e.input === 'object' && e.input !== null ? e.input : {}) as Fields
  const path = normalisePath(input.file_path ?? input.notebook_path, await $.session.cwd())
  if (path === null) return null
  const now = await $.clock.now()
  const agent = e.agentId ?? null
  const holder = holds.clashWith(path.key, agent, now)
  const undo = holder === null ? holds.reserve(path.key, agent, now) : () => undefined
  return { ...path, subject: toolSubject(e.tool, input), agent, holder, now, undo }
}

/** Records the clash, at most once a minute per agent and path; true when this one was recorded. */
function noted($: EngineInterface, l: Look, holder: string): boolean {
  const who = l.agent ?? LEAD
  if (!holds.shouldRecord(who, l.key, l.now)) return false
  void record($, { type: 'clash.blocked', agent: who, data: { path: l.subject || l.shown, holder, mode: setting === 'warn' ? 'warn' : 'block' } })
  return true
}

async function warnLead($: EngineInterface, l: Look, holder: string): Promise<void> {
  const [holderName, agentName] = await Promise.all([agentLabel($, holder), agentLabel($, l.agent)])
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: warnText(agentName, l.shown, holderName) }] } }).catch(() => undefined)
}

export function registerClashGuard(on: On, options: PluginOptions): void {
  holds = new Holds()
  setting = clashSettingFrom((options as Readonly<Record<string, unknown>>).clashGuard)
  if (setting === 'off') return

  on('tool.check', { tool: CLASH_TOOLS }, async ($, e, next) => {
    const l = await look($, e)
    if (l === null) return next(e)
    if (l.holder !== null && setting === 'block') {
      noted($, l, l.holder)
      return { decision: 'deny', reason: refusalText(await agentLabel($, l.holder), l.shown) }
    }
    let result
    try {
      result = await next(e)
    } catch (err) {
      l.undo()
      throw err
    }
    if (result.decision === 'deny') l.undo()
    else if (l.holder !== null && noted($, l, l.holder)) void warnLead($, l, l.holder)
    return result
  }).catch((_$, e, next) => next(e))

  on('turn.complete', { reason: FINISHED }, async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) holds.releaseAll(e.agentId)
    return result
  })
}
