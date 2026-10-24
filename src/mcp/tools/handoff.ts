/**
 * omnis_handoff (spec section 3.3): writes the handoff notes for a stuck agent's open tasks. Internal: the mod's guard
 * refuses the model's calls. The notes are built from folded state alone (src/core/handoff.ts) and stored in swarm memory
 * under a fixed key shape, handoff/t<digits>. It changes no task: only the lead moves a task to a new assignee.
 */
import { NAME, clip, makeEvent, type HandoffWhy } from '../../core/events.ts'
import { LEAD, type SwarmState } from '../../core/fold.ts'
import { handoffNote } from '../../core/handoff.ts'
import { appendEvent } from '../../core/log.ts'
import { HANDOFF_TOOL } from '../../core/recording.ts'
import { MemoryLimitError, putMemory } from '../memory-store.ts'
import type { ToolDef } from '../protocol.ts'
import { redactSecrets } from '../../core/secrets.ts'
import type { ToolContext } from '../tools.ts'
import { InputError, reqEnum, reqString } from '../validate.ts'

const FAILED = 'Could not update the swarm files in .omnis-swarm/ (see the server log).'
/** The most notes one call writes. */
const MAX_NOTES = 3
/** The writer name stored with a note. */
const WRITER = 'omnis'
/** What the mod may ask for; `lead` comes only from omnis_task_update. */
const MOD_WHY = ['stuck', 'finished'] as const

/** The memory key of a task's handoff note. Task ids are t<digits>, so the key is always a valid, safe one. */
export const noteKey = (taskId: string): string => `handoff/${taskId}`

/** t2 before t10: by the number in the id. */
const byNumber = (a: string, b: string): number => Number(a.slice(1)) - Number(b.slice(1))

/**
 * Builds the note for `agentId`'s work on `taskId` from `state`, stores it, and logs memory.put and task.handoff.
 * 'full' when the memory store has no room (nothing is written then); 'none' when there is nothing to write.
 */
export function saveNote(
  ctx: ToolContext, swarm: string, state: SwarmState, taskId: string, agentId: string, why: HandoffWhy, now: Date,
): 'saved' | 'full' | 'none' {
  const note = handoffNote(state, taskId, agentId)
  if (note === '') return 'none'
  const key = noteKey(taskId)
  try {
    putMemory(ctx.root, swarm, key, note, WRITER, now)
  } catch (err) {
    if (err instanceof MemoryLimitError) return 'full'
    throw err
  }
  const write = (event: Parameters<typeof appendEvent>[1]): void => {
    if (!appendEvent(ctx.root, event)) throw new Error('Could not write to the swarm log in .omnis-swarm/')
  }
  const bytes = new TextEncoder().encode(note).length
  write(makeEvent({ type: 'memory.put', swarm, src: 'mcp', data: { key, bytes, preview: clip(redactSecrets(note), 80) }, now }))
  write(makeEvent({ type: 'task.handoff', swarm, src: 'mcp', data: { task: taskId, agent: agentId, why }, now }))
  return 'saved'
}

/** The id of the agent named `assignee` when it has made at least one tool call, else null: only such an agent has work to hand on. */
export function workedAgent(state: SwarmState, assignee: string | null): string | null {
  if (assignee === null || !Object.hasOwn(state.byName, assignee)) return null
  const id = state.byName[assignee]!
  const agent = Object.hasOwn(state.agents, id) ? state.agents[id] : undefined
  return agent !== undefined && Object.values(agent.tools).some(n => n > 0) ? id : null
}

/** The line omnis_task_update adds to its reply for handoff: true, or '' when no note was tried. */
export function handoffReply(saved: 'saved' | 'full' | 'none' | null, taskId: string): string {
  if (saved === 'saved') return `\nHandoff note saved as ${noteKey(taskId)}.`
  return saved === 'full' ? '\nMemory is full, so no handoff note was saved.' : ''
}

export function createHandoffTools(ctx: ToolContext): ToolDef[] {
  const { session } = ctx
  const clock = ctx.now ?? (() => new Date())

  const tool: ToolDef = {
    name: HANDOFF_TOOL,
    description: "Internal to the OmnisSwarm stuck guard: writes handoff notes for a stuck subagent's open tasks. When the OmnisSwarm mod is loaded it refuses calls from the model.",
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', pattern: NAME.source, description: 'The subagent id.' },
        why: { type: 'string', enum: [...MOD_WHY] },
      },
      required: ['agent', 'why'],
      additionalProperties: false,
    },
    handler: args => {
      const agent = reqString(args, 'agent', 64, NAME)
      const why = reqEnum(args, 'why', MOD_WHY)
      try {
        // Read-only on the session: never adopts a swarm. The recorder has told the server the session id by the time the mod asks.
        const swarm = agent === LEAD ? null : session.mySwarm(false)
        if (swarm === null) return { text: JSON.stringify({ notes: [] }) }
        const state = session.state(swarm).state
        const found = Object.hasOwn(state.agents, agent) ? state.agents[agent] : undefined
        if (found === undefined || found.name === '') return { text: JSON.stringify({ notes: [] }) }
        const open = Object.values(state.tasks)
          .filter(t => t.assignee === found.name && (t.state === 'active' || t.state === 'pending'))
          .map(t => t.id)
        const ids = [...open.filter(id => state.tasks[id]!.state === 'active').sort(byNumber), ...open.filter(id => state.tasks[id]!.state === 'pending').sort(byNumber)].slice(0, MAX_NOTES)
        const notes: string[] = []
        const now = clock()
        for (const id of ids) {
          const saved = saveNote(ctx, swarm, state, id, agent, why, now)
          if (saved === 'full') break
          if (saved === 'saved') notes.push(noteKey(id))
        }
        return { text: JSON.stringify({ notes }) }
      } catch (err) {
        if (err instanceof InputError) throw err
        // The detail may hold paths, so it goes to stderr only.
        process.stderr.write(`omnis: ${HANDOFF_TOOL} failed: ${err instanceof Error ? err.message : String(err)}\n`)
        throw new Error(FAILED)
      }
    },
  }
  return [tool]
}
