/**
 * The gate's permission check. omnis_task_update(done) runs the project's gate command in the server, outside the
 * engine's Bash permissions, and an agent could have edited the script that command runs. So before the call runs,
 * this asks the server what the gate would run (omnis_gate_plan) and gives the call exactly the verdict a Bash call
 * running that command would get from the user's rules: an explicit allow rule passes, deny refuses, and anything else
 * asks about this call. Once the rest of the hook chain hasn't refused the call, it records a one-shot approval of that
 * exact plan (omnis_gate_approve); the server runs a gate only with one, and only if what it would run still matches.
 * Unlike the other guards this fails closed.
 */
import type { EngineInterface, On, ToolCheckResult } from 'claude-code'
import { APPROVE_TOOL, GATE_PLAN_TOOL } from '../core/recording.ts'
import { connectServer } from './server.ts'

/** omnis_task_update under any server alias. */
const TASK_UPDATE = /^mcp__.+__omnis_task_update$/
const DIGEST = /^[0-9a-f]{64}$/
export const CALL_TIMEOUT_MS = 2000

export const gateDescription = (dir: string): string => `OmnisSwarm verification gate in ${dir}`
export const deniedText = (command: string): string => `The gate command is not allowed by your permission rules: ${command}. Allow it, or set the gateCommand setting.`
export const askText = (command: string, dir: string): string => `OmnisSwarm will run the verification gate: ${command} in ${dir}`
export const FAILED_TEXT = 'Could not check permission for the gate. Try again, or mark it done with skipGate and a note.'

type Plan = { run: false } | { run: true; id: string; dir: string; command: string; digest: string }
type Fields = Record<string, unknown>

const refuse = (reason: string): ToolCheckResult => ({ decision: 'deny', reason })
const nonEmpty = (x: unknown): x is string => typeof x === 'string' && x !== ''

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
  if (p.run === true && nonEmpty(p.id) && nonEmpty(p.dir) && nonEmpty(p.command) && typeof p.digest === 'string' && DIGEST.test(p.digest)) {
    return { run: true, id: p.id, dir: p.dir, command: p.command, digest: p.digest }
  }
  return null
}

/**
 * One call to this plugin's server: the reply's text, or null when it fails, answers an error or takes longer than
 * CALL_TIMEOUT_MS (the connect counts).
 */
async function callServer($: EngineInterface, tool: string, args: Fields): Promise<string | null> {
  const stop = new AbortController()
  const slow = $.clock.sleep(CALL_TIMEOUT_MS, { signal: stop.signal }).then(() => null, () => null)
  const ask = (async (): Promise<string | null> => {
    const server = await connectServer($)
    if (server === null) return null
    const result = await $.mcp.call(server, tool, args)
    const block = result.content[0]
    if (result.isError === true || block === undefined || block.type !== 'text' || typeof block.text !== 'string') return null
    return block.text
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
    const reply = await callServer($, GATE_PLAN_TOOL, { id: input.id, ...(input.worktree !== undefined && { worktree: input.worktree }) })
    const plan = reply === null ? null : parsePlan(reply)
    if (plan === null) return refuse(FAILED_TEXT)
    if (!plan.run) return next(e)
    const verdict = await $.tool.check({ tool: 'Bash', input: { command: plan.command, description: gateDescription(plan.dir) } })
    if (verdict.decision === 'deny') return refuse(deniedText(plan.command))
    // A query runs no PreToolUse hook and carries no agent, and a sandbox or a mode can allow a Bash call the gate
    // would run unsandboxed. So only an explicit allow rule lets the gate run unasked; any other allow asks a person.
    const asks = verdict.decision === 'ask' || verdict.rule === undefined
    const result = await next(e)
    if (result.decision === 'deny') return result
    // Approved before an ask is answered: a declined ask leaves an approval only this call could have used, and it lapses.
    const approved = await callServer($, APPROVE_TOOL, { id: plan.id, dir: plan.dir, command: plan.command, digest: plan.digest })
    if (approved === null) return refuse(FAILED_TEXT)
    return asks ? { decision: 'ask', reason: askText(plan.command, plan.dir) } : result
  }).catch(() => refuse(FAILED_TEXT))
}
