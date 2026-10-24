/**
 * The two internal tools behind the gate's permission check (the mod's guard refuses both to the model).
 * omnis_gate_plan: what omnis_task_update(done) would run for a task, where, and a digest of what defines it, so the
 * mod can ask the user's Bash rules about that command. omnis_gate_approve: the mod's one-shot approval of exactly that
 * plan, which the gate then needs. Both use the gate's own settings and resolution (gateTarget), not a copy.
 */
import { APPROVE_TOOL, GATE_PLAN_TOOL } from '../../core/recording.ts'
import { clip } from '../../core/events.ts'
import { approveGate } from '../gate/approvals.ts'
import { settingsFor } from '../gate/detect.ts'
import { SHOWN_COMMAND } from '../gate/gate.ts'
import { redact } from '../redact.ts'
import { gateTarget } from '../gate/target.ts'
import type { ToolDef } from '../protocol.ts'
import { TASK_ID, type ToolContext } from '../tools.ts'
import { InputError, optString, reqString } from '../validate.ts'
import { resolveWorktree } from '../worktrees.ts'

/**
 * What the gate would do. `changed: true` means the gate differs from the one the task was created with, so the call is
 * refused (gate.ts says the same): the guard needs no Bash query, and builds the refusal text from `state` (the task's
 * state) and `command` (the command as a reply shows it, clipped and redacted, or "no gate found").
 */
export type GatePlan = { run: false } | { run: false; changed: true; state: string; command: string } | { run: true; id: string; dir: string; command: string; digest: string }

const DIGEST = /^[0-9a-f]{64}$/
export const NO_MOD_TEXT = "The gate needs OmnisSwarm's mod, and it isn't running in this session. Turn mods on, or mark the task done with skipGate and a note."
const MAX_DIR = 1000
const MAX_COMMAND = 4000

export function createGatePlanTools(ctx: ToolContext): ToolDef[] {
  const { root, session } = ctx
  const clock = ctx.now ?? (() => new Date())
  const swarmKey = (): string => session.mySwarm() ?? ''

  const plan: ToolDef = {
    name: GATE_PLAN_TOOL,
    description: 'Internal to the OmnisSwarm plugin: answers what the verification gate would run for a task, for the permission check. When the OmnisSwarm mod is loaded it refuses calls from the model.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', pattern: TASK_ID.source },
        worktree: { type: 'string', maxLength: 400 },
        skipGate: { type: 'boolean' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    handler: args => {
      const id = reqString(args, 'id', 8, TASK_ID)
      const worktreeArg = optString(args, 'worktree', 400)
      const worktree = worktreeArg === undefined ? undefined : resolveWorktree(root, worktreeArg)
      if (args.skipGate !== undefined && args.skipGate !== null && typeof args.skipGate !== 'boolean') throw new InputError('skipGate must be true or false')
      const settings = settingsFor(ctx.gate?.env)
      const answer = (p: GatePlan) => ({ text: JSON.stringify(p) })
      if (settings.mode === 'off' || args.skipGate === true) return answer({ run: false })
      // A task not (yet) on the board is answered as if it had no stored worktree, never as nothing to run.
      const swarm = session.mySwarm()
      const tasks = swarm === null ? {} : session.state(swarm).state.tasks
      const stored = Object.hasOwn(tasks, id) ? tasks[id]!.worktree : null
      const { dir, command, digest } = gateTarget(root, stored, worktree, settings.command)
      const pin = Object.hasOwn(tasks, id) ? tasks[id]!.gatePin : null
      if (pin !== null && digest !== pin) {
        return answer({ run: false, changed: true, state: tasks[id]!.state, command: command === null ? 'no gate found' : clip(redact(command), SHOWN_COMMAND) })
      }
      return answer(command === null || digest === null ? { run: false } : { run: true, id, dir, command, digest })
    },
  }

  const approve: ToolDef = {
    name: APPROVE_TOOL,
    description: "Internal to the OmnisSwarm plugin: records the permission check's approval of a task's gate. When the OmnisSwarm mod is loaded it refuses calls from the model.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', pattern: TASK_ID.source },
        dir: { type: 'string', minLength: 1, maxLength: MAX_DIR },
        command: { type: 'string', minLength: 1, maxLength: MAX_COMMAND },
        digest: { type: 'string', pattern: DIGEST.source },
      },
      required: ['id', 'dir', 'command', 'digest'],
      additionalProperties: false,
    },
    handler: args => {
      const id = reqString(args, 'id', 8, TASK_ID)
      const dir = reqString(args, 'dir', MAX_DIR)
      const command = reqString(args, 'command', MAX_COMMAND)
      const digest = reqString(args, 'digest', 64, DIGEST)
      // A speed bump, not a boundary: approvals come from the mod, and the server only knows the mod is running once
      // the recorder's first valid omnis_record has told it the session id. A model that calls the internal tools on
      // purpose with mods off could make that call too.
      if (session.sessionId === null) throw new InputError(NO_MOD_TEXT)
      approveGate(root, swarmKey(), id, { dir, command, digest }, clock().getTime())
      return { text: 'approved' }
    },
  }
  return [plan, approve]
}
