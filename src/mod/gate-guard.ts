/**
 * The gate's permission check. omnis_task_update(done) runs the project's gate command in the server, outside the
 * engine's Bash permissions, and an agent could have edited the script that command runs. So before the call runs,
 * this asks the server what the gate would run (omnis_gate_plan) and gives the call exactly the verdict a Bash call
 * running that command would get from the user's rules: allow passes, deny refuses, ask asks about this call.
 * Unlike the other guards it fails closed: if the plan can't be had, the call is refused.
 */
import type { EngineInterface, On, ToolCheckResult } from 'claude-code'
import { GATE_PLAN_TOOL } from '../core/recording.ts'
import { connectServer } from './server.ts'

/** omnis_task_update under any server alias. */
const TASK_UPDATE = /^mcp__.+__omnis_task_update$/
export const PLAN_TIMEOUT_MS = 2000
export const GATE_DESCRIPTION = 'OmnisSwarm verification gate'

export const deniedText = (command: string): string => `The gate command is not allowed by your permission rules: ${command}. Allow it, or set the gateCommand setting.`
export const askText = (command: string, dir: string): string => `OmnisSwarm will run the verification gate: ${command} in ${dir}`
export const FAILED_TEXT = 'Could not check permission for the gate. Try again, or mark it done with skipGate and a note.'

type Plan = { run: false } | { run: true; command: string; dir: string }
type Fields = Record<string, unknown>

const refuse = (reason: string): ToolCheckResult => ({ decision: 'deny', reason })

/** The server's answer, or null when it isn't one. */
function parsePlan(text: string): Plan | null {
  let x: unknown
  try {
    x = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof x !== 'object' || x === null) return null
  const p = x as Fields
  if (p.run === false) return { run: false }
  if (p.run === true && typeof p.command === 'string' && p.command !== '' && typeof p.dir === 'string' && p.dir !== '') {
    return { run: true, command: p.command, dir: p.dir }
  }
  return null
}

/** Asks the server for the plan; null when it can't be had within PLAN_TIMEOUT_MS (the connect counts). */
async function askPlan($: EngineInterface, args: Fields): Promise<Plan | null> {
  const stop = new AbortController()
  const slow = $.clock.sleep(PLAN_TIMEOUT_MS, { signal: stop.signal }).then(() => null, () => null)
  const ask = (async (): Promise<Plan | null> => {
    const server = await connectServer($)
    if (server === null) return null
    const result = await $.mcp.call(server, GATE_PLAN_TOOL, args)
    const block = result.content[0]
    if (result.isError === true || block === undefined || block.type !== 'text' || typeof block.text !== 'string') return null
    return parsePlan(block.text)
  })().catch(() => null)
  try {
    return await Promise.race([ask, slow])
  } finally {
    stop.abort()
  }
}

export function registerGateGuard(on: On): void {
  on('tool.check', { tool: TASK_UPDATE }, async ($, e, next) => {
    const input = (typeof e.input === 'object' && e.input !== null ? e.input : {}) as Fields
    if (input.state !== 'done' || input.skipGate === true) return next(e)
    const plan = await askPlan($, { id: input.id, ...(input.worktree !== undefined && { worktree: input.worktree }) })
    if (plan === null) return refuse(FAILED_TEXT)
    if (!plan.run) return next(e)
    const verdict = await $.tool.check({ tool: 'Bash', input: { command: plan.command, description: GATE_DESCRIPTION } })
    if (verdict.decision === 'deny') return refuse(deniedText(plan.command))
    if (verdict.decision === 'ask') return { decision: 'ask', reason: askText(plan.command, plan.dir) }
    return next(e)
  }).catch(() => refuse(FAILED_TEXT))
}
