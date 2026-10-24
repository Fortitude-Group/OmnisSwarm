/**
 * omnis_fence (spec section 3.5): tells the mod's scope fence which files a subagent may edit. Internal: the mod's guard
 * refuses the model's calls. It only reads the running swarm's folded state and the repo's registered worktrees.
 */
import { NAME } from '../../core/events.ts'
import { LEAD } from '../../core/fold.ts'
import { FENCE_TOOL } from '../../core/recording.ts'
import type { ToolDef } from '../protocol.ts'
import type { ToolContext } from '../tools.ts'
import { InputError, reqString } from '../validate.ts'
import { projectRoots } from '../worktrees.ts'

const FAILED = 'Could not read the swarm files in .omnis-swarm/ (see the server log).'
const FENCING = new Set(['pending', 'active'])

export type FenceAnswer = { fenced: false } | { fenced: true; tasks: string[]; owns: string[]; roots: string[] }

export function createFenceTools(ctx: ToolContext): ToolDef[] {
  const { root, session } = ctx

  /** The fence of agent id `agent` in this session's live swarm (spec 3.2). The lead and unknown agents are never fenced. */
  const fenceOf = (agent: string): FenceAnswer => {
    if (agent === LEAD) return { fenced: false }
    // Read-only: never adopts a swarm. The recorder has told the server the session id by the time the mod asks.
    const swarm = session.mySwarm(false)
    if (swarm === null) return { fenced: false }
    const state = session.state(swarm).state
    const found = Object.hasOwn(state.agents, agent) ? state.agents[agent] : undefined
    if (found === undefined || found.name === '') return { fenced: false }
    const tasks = Object.values(state.tasks).filter(t => t.assignee === found.name && FENCING.has(t.state) && t.owns.length > 0)
    if (tasks.length === 0) return { fenced: false }
    return { fenced: true, tasks: tasks.map(t => t.id), owns: [...new Set(tasks.flatMap(t => t.owns))], roots: projectRoots(root) }
  }

  const tool: ToolDef = {
    name: FENCE_TOOL,
    description: 'Internal to the OmnisSwarm scope fence: which files a subagent may edit. When the OmnisSwarm mod is loaded it refuses calls from the model.',
    inputSchema: {
      type: 'object',
      properties: { agent: { type: 'string', pattern: NAME.source, description: 'The subagent id.' } },
      required: ['agent'],
      additionalProperties: false,
    },
    handler: args => {
      const agent = reqString(args, 'agent', 64, NAME)
      try {
        return { text: JSON.stringify(fenceOf(agent)) }
      } catch (err) {
        if (err instanceof InputError) throw err
        // The detail may hold paths, so it goes to stderr only.
        process.stderr.write(`omnis: ${FENCE_TOOL} failed: ${err instanceof Error ? err.message : String(err)}\n`)
        throw new Error(FAILED)
      }
    },
  }
  return [tool]
}
