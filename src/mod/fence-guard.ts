/**
 * The scope fence (spec section 3): a subagent whose task owns paths may edit only those. Its edits elsewhere are refused
 * (block), let through with a word to the lead (warn), or not checked (off). The lead is never fenced. Registered before
 * the clash guard, so a fenced-out edit is refused before it can take a hold. Also refuses a subagent's skipGate (spec
 * 2.6). Any failure here, or a server slower than 2 s, fails open.
 */
import type { EngineInterface, On, PluginOptions } from 'claude-code'
import { FENCE_TOOL } from '../core/recording.ts'
import { agentLabel } from './agent-name.ts'
import {
  FENCE_ASK_MS, FenceCache, FenceTold, SKIP_GATE_REFUSAL, fenceAllows, fenceRefusal, fenceSettingFrom, fenceWarn, parseFence,
  type Fence, type FenceSetting,
} from './fence.ts'
import { normalisePath } from './holds.ts'
import { toolSubject, type Fields } from './record-events.ts'
import { record } from './recorder.ts'
import { connectServer } from './server.ts'

const FENCE_TOOLS = ['Edit', 'Write', 'NotebookEdit']
const TASK_TOOLS = /^mcp__.+__omnis_task_(create|update)$/
const TASK_UPDATE = /^mcp__.+__omnis_task_update$/
const MAX_TASKS = 20

/** Module state; a hot reload starts over, which only costs one more question to the server. */
let cache = new FenceCache()
let told = new FenceTold()
let setting: FenceSetting = 'block'

/** omnis_fence's answer for subagent `agent`, or null when the server fails, answers badly or takes over FENCE_ASK_MS. */
async function ask($: EngineInterface, agent: string): Promise<Fence | null> {
  const server = await connectServer($)
  if (server === null) return null
  const text = await new Promise<string | null>(resolve => {
    const timer = $.clock.after(FENCE_ASK_MS, () => resolve(null))
    $.mcp.call(server, FENCE_TOOL, { agent }).then(
      result => {
        timer.cancel()
        const block = result.content[0]
        resolve(result.isError !== true && block !== undefined && block.type === 'text' && typeof block.text === 'string' ? block.text : null)
      },
      () => {
        timer.cancel()
        resolve(null)
      },
    )
  })
  return text === null ? null : parseFence(text)
}

/** The agent's fence, from the cache or the server; null fails open. */
async function fenceOf($: EngineInterface, agent: string, now: number): Promise<Fence | null> {
  const held = cache.get(agent, now)
  if (held !== undefined) return held
  const asked = cache.generation
  const fence = await ask($, agent)
  if (fence !== null) cache.set(agent, fence, now, asked)
  return fence
}

async function warnLead($: EngineInterface, agent: string, path: string, tasks: readonly string[]): Promise<void> {
  const name = await agentLabel($, agent)
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: fenceWarn(name, path, tasks) }] } }).catch(() => undefined)
}

export function registerFenceGuard(on: On, options: PluginOptions): void {
  cache = new FenceCache()
  told = new FenceTold()
  setting = fenceSettingFrom((options as Readonly<Record<string, unknown>>).scopeFence)

  // Spec 2.6: only the lead may close a task without its gate. Not part of the fence, so it holds with the fence off.
  on('tool.check', { tool: TASK_UPDATE }, ($, e, next) => {
    const input = (typeof e.input === 'object' && e.input !== null ? e.input : {}) as Fields
    return e.agentId !== undefined && input.skipGate === true ? { decision: 'deny' as const, reason: SKIP_GATE_REFUSAL } : next(e)
  }).catch((_$, e, next) => next(e))

  if (setting === 'off') return

  on('tool.check', { tool: FENCE_TOOLS }, async ($, e, next) => {
    const agent = e.agentId
    // The lead is never fenced; a query with no call id is not an edit.
    if (agent === undefined || e.tool_use_id === undefined) return next(e)
    const input = (typeof e.input === 'object' && e.input !== null ? e.input : {}) as Fields
    const path = normalisePath(input.file_path ?? input.notebook_path, await $.session.cwd())
    if (path === null) return next(e)
    const now = await $.clock.now()
    const fence = await fenceOf($, agent, now)
    if (fence === null || !fence.fenced || fenceAllows(fence, path.key)) return next(e)
    const recorded = { type: 'fence.blocked' as const, agent, data: { path: toolSubject(e.tool, input) || path.shown, tasks: fence.tasks.slice(0, MAX_TASKS), mode: setting === 'warn' ? 'warn' as const : 'block' as const } }
    if (setting === 'block') {
      if (told.should(agent, path.key, now)) void record($, recorded)
      return { decision: 'deny', reason: fenceRefusal(path.shown, fence.tasks, fence.owns) }
    }
    const result = await next(e)
    if (result.decision !== 'deny' && told.should(agent, path.key, now)) {
      void record($, recorded)
      void warnLead($, agent, path.shown, fence.tasks)
    }
    return result
  }).catch((_$, e, next) => next(e))

  // Observe-only: any task create or update may change who owns what, so every cached answer goes.
  on('tool.call', { tool: TASK_TOOLS }, async ($, e, next) => {
    try {
      return await next(e)
    } finally {
      cache.clear()
    }
  }).catch((_$, e, next) => next(e))
}
