/**
 * omnis_gate_plan: what omnis_task_update(done) would run for a task, and where, so the mod can ask the user's Bash
 * permission rules about that command before the call runs. Internal (the mod's guard refuses the model). Uses the
 * gate's own settings and resolution (gateTarget), never a second copy of them.
 */
import { GATE_PLAN_TOOL } from '../../core/recording.ts'
import { settingsFor } from '../gate/detect.ts'
import { gateTarget } from '../gate/gate.ts'
import type { ToolDef } from '../protocol.ts'
import { TASK_ID, type ToolContext } from '../tools.ts'
import { InputError, optString, reqString } from '../validate.ts'
import { resolveWorktree } from '../worktrees.ts'

export type GatePlan = { run: false } | { run: true; command: string; dir: string }

export function createGatePlanTools(ctx: ToolContext): ToolDef[] {
  const { root, session } = ctx
  const tool: ToolDef = {
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
      const answer = (plan: GatePlan) => ({ text: JSON.stringify(plan) })
      if (settings.mode === 'off' || args.skipGate === true) return answer({ run: false })
      // A task not (yet) on the board is answered as if it had no stored worktree, never as nothing to run.
      const swarm = session.mySwarm()
      const tasks = swarm === null ? {} : session.state(swarm).state.tasks
      const stored = Object.hasOwn(tasks, id) ? tasks[id]!.worktree : null
      const { dir, command } = gateTarget(root, stored, worktree, settings.command)
      return answer(command === null ? { run: false } : { run: true, command, dir })
    },
  }
  return [tool]
}
