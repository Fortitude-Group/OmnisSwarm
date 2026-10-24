/** The omnis_* MCP tools. Each validates its input, appends events and reads folded state. */
import { BUDGET_MAX, NAME, TASK_STATES, TOPOLOGIES, clip, isSafeKey, makeEvent, type SwarmEvent } from '../core/events.ts'
import { parseBudget, type BudgetPatch } from '../core/budget.ts'
import { appendEvent, clearCurrent, readCurrent, writeCurrent } from '../core/log.ts'
import { agentStats, fileClashes, swarmTotals } from '../core/stats.ts'
import { uniqueSwarmId } from '../core/swarm.ts'
import { LEAD, MEMORY_KEY, type SwarmState } from '../core/fold.ts'
import { validPattern } from '../core/glob.ts'
import { hasNewWork } from '../core/report.ts'
import { cyclePath } from '../core/ready.ts'
import { MAX_VALUE_BYTES, MemoryLimitError, putMemory, readMemory } from './memory-store.ts'
import { settingsFor } from './gate/detect.ts'
import { PROGRESS_MS, gateForDone } from './gate/gate.ts'
import { pinGate, pinnedGate } from './gate/pins.ts'
import { gateTarget } from './gate/target.ts'
import type { AnyToolDef, Args, AsyncToolDef, CallContext, ToolDef, ToolResult } from './protocol.ts'
import { SECRETISH } from './redact.ts'
import { redactSecrets } from '../core/secrets.ts'
import type { Session } from './session.ts'
import { handoffReply, saveNote, workedAgent } from './tools/handoff.ts'
import { writeReport } from './tools/report.ts'
import { resolveWorktree } from './worktrees.ts'
import { InputError, optString, optStringList, optText, reqEnum, reqString, reqText } from './validate.ts'

/**
 * Where the gate's settings come from, and shorter limits for tests. Only server.ts passes the real environment;
 * without `env` the gate is off, so a test (or a gate run of this repo's own tests) never picks the settings up.
 */
export type GateOptions = { env?: Record<string, string | undefined>; limitMs?: number; progressMs?: number }
export type ToolContext = { root: string; now?: () => Date; session: Session; gate?: GateOptions }

export const TASK_ID = /^t[0-9]{1,6}$/

const usd = (x: number | null): string => (x === null ? '–' : `≈$${x.toFixed(x < 1 ? 3 : 2)}`)
const int = (n: number): string => Math.round(n).toLocaleString('en-GB')

function statusText(state: SwarmState, nowMs: number): string {
  const clashes = fileClashes(state, nowMs)
  const t = swarmTotals(state, nowMs, clashes)
  const s = state.swarm
  const lines = [
    `Swarm ${s.name} [${s.id}] (${s.topology})${s.endedAt !== null ? ' · ended' : ''} · ${t.agents} agents · ` +
      `${t.running} running · ${int(t.tokens)} tokens · ${usd(t.costUsd)}${t.costPartial ? ' (some models unpriced)' : ''}`,
  ]
  for (const id of Object.keys(state.agents)) {
    const a = agentStats(state, id, nowMs, clashes)
    if (a === null || a.placeholder) continue
    lines.push(`- ${a.name} [${a.role}] ${a.status} · ${int(a.tokens.total)} tokens · ${usd(a.costUsd)}${a.stuck ? ' · stuck' : ''}`)
  }
  lines.push(`Tasks: ${TASK_STATES.map(k => `${t.tasks[k]} ${k}`).join(', ')}`)
  lines.push(`Memory: ${Object.keys(state.memory).length} keys`)
  if (t.clashes > 0) lines.push(`File clashes: ${t.clashes}`)
  return lines.join('\n')
}

/** Token-shaped runs are blanked before a value preview reaches the log (the pattern lives in redact.ts, shared with the gate). */
export { SECRETISH }
/** Only the start can show (80 characters), so only the start is redacted: a huge value costs no more than 1 KB. */
const preview = (value: string): string => clip(redactSecrets(value.slice(0, 1024)), 80)

export const MAX_TASKS = 500
const MAX_OWNS = 20
const OWNS_PROP = {
  type: 'array', items: { type: 'string', minLength: 1, maxLength: 200 }, maxItems: MAX_OWNS,
  description: 'Paths the assigned agent may edit, relative to the repo root: src/**, docs/, tests/*.test.ts. * is inside one folder, ** crosses folders, a trailing / means the folder and everything under it. Other edits by that agent are refused.',
} as const
const WORKTREE_PROP = {
  type: 'string', maxLength: 400,
  description: "A registered git worktree of this repo (or the repo itself) where this task's work is done and checked.",
} as const
const FAILED = 'Could not update the swarm files in .omnis-swarm/ (see the server log).'

/** `owns` as given: at most 20 patterns, each valid, duplicates dropped. Undefined when absent. */
function ownsArg(args: Args): string[] | undefined {
  const owns = optStringList(args, 'owns', MAX_OWNS, 200)
  if (owns === undefined) return undefined
  owns.forEach((p, i) => {
    const why = validPattern(p)
    if (why !== null) throw new InputError(`owns item ${i + 1} ${why}`)
  })
  return [...new Set(owns)]
}

/** The loop a dependsOn change would close, as the refusal shows it: at most 8 ids, then an ellipsis. */
const loopText = (path: string[]): string => `${path.slice(0, 8).join(' → ')}${path.length > 8 ? ' → …' : ''}`

const NO_CALL: CallContext = { signal: new AbortController().signal, progress: () => {} }

export function createTools(ctx: ToolContext): AnyToolDef[] {
  const root = ctx.root
  const clock = ctx.now ?? (() => new Date())
  const session = ctx.session
  const gateOptions = ctx.gate ?? {}

  const emit = (event: SwarmEvent): void => {
    if (!appendEvent(root, event)) throw new Error('Could not write to the swarm log in .omnis-swarm/')
  }
  const memoryKey = (args: Record<string, unknown>): string => {
    const key = reqString(args, 'key', 128, MEMORY_KEY)
    if (!isSafeKey(key)) throw new InputError('key is reserved')
    return key
  }

  const tools: ToolDef[] = [
    {
      name: 'omnis_swarm_init',
      description: 'Start a named swarm with a topology, so the OmnisSwarm pane groups and lays out the agents you spawn. If agents are already running in an unnamed session swarm, this names that swarm instead of starting another.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 64, description: 'Human name, e.g. "auth refactor".' },
          topology: { type: 'string', enum: [...TOPOLOGIES], description: 'hierarchical: a lead with workers. mesh: peers talk to each other. star: everything goes through one hub.' },
          goal: { type: 'string', maxLength: 200, description: 'One line on what the swarm is for.' },
          budget: {
            type: 'object',
            description: 'Optional limits for this swarm. Warnings come at 2/3 of the minutes, 3/5 of the agent dollars and 1/2 of the swarm dollars.',
            properties: {
              agentMinutes: { type: 'number', exclusiveMinimum: 0, maximum: BUDGET_MAX.agentMinutes, description: 'Minutes an agent may run before it is asked to wrap up.' },
              agentUsd: { type: 'number', exclusiveMinimum: 0, maximum: BUDGET_MAX.agentUsd, description: 'Approximate dollars an agent may spend before it is asked to wrap up.' },
              swarmUsd: { type: 'number', exclusiveMinimum: 0, maximum: BUDGET_MAX.swarmUsd, description: 'Dollars the swarm may spend before new agents are blocked.' },
            },
            additionalProperties: false,
          },
        },
        required: ['name', 'topology'],
        additionalProperties: false,
      },
      handler: args => {
        let budget: BudgetPatch | null = null
        if (args.budget !== undefined && args.budget !== null) {
          const parsed = parseBudget(args.budget)
          if (!parsed.ok) throw new InputError(parsed.error)
          budget = parsed.patch
        }
        const name = reqText(args, 'name', 64)
        const topology = reqEnum(args, 'topology', TOPOLOGIES)
        const goal = optText(args, 'goal', 200)
        const now = clock()
        const noteBudget = (swarm: string): void => {
          if (budget !== null) emit(makeEvent({ type: 'budget.set', swarm, src: 'mcp', data: budget, now }))
        }
        const data = { name, topology, ...(goal !== undefined && { goal }), implicit: false, ...(session.sessionKey !== null && { session: session.sessionKey }) }
        const existing = session.mySwarm(false) // init never takes over a swarm it didn't start
        let replaced: string | null = null
        if (existing !== null && session.owned) {
          const { state } = session.state(existing)
          if (state.swarm.implicit) {
            emit(makeEvent({ type: 'swarm.started', swarm: existing, src: 'mcp', data, now }))
            noteBudget(existing)
            return { text: `Swarm "${name}" (${topology}) now names the running session swarm ${existing}.` }
          }
          replaced = existing
        }
        const id = uniqueSwarmId(root, name)
        if (replaced !== null) emit(makeEvent({ type: 'swarm.ended', swarm: replaced, src: 'mcp', data: { outcome: 'replaced' }, now }))
        writeCurrent(root, id)
        session.begin(id)
        emit(makeEvent({ type: 'swarm.started', swarm: id, src: 'mcp', data, now }))
        noteBudget(id)
        return { text: `Swarm "${name}" started as ${id} (${topology}).` }
      },
    },
    {
      name: 'omnis_swarm_end',
      description: 'End the running swarm. Its log stays on disk; the next agent or omnis_swarm_init starts a new one.',
      inputSchema: {
        type: 'object',
        properties: { outcome: { type: 'string', maxLength: 200, description: 'How it went, in a few words.' } },
        additionalProperties: false,
      },
      handler: args => {
        const id = session.runningSwarm()
        const outcome = optText(args, 'outcome', 200)
        if (!session.owned) {
          session.letGo()
          return { text: `Swarm ${id} belongs to another session and is still running; this session has let go of it.` }
        }
        emit(makeEvent({ type: 'swarm.ended', swarm: id, src: 'mcp', data: outcome === undefined ? {} : { outcome }, now: clock() }))
        if (readCurrent(root) === id) clearCurrent(root)
        session.letGo()
        try {
          const s = session.state(id).state
          if (s.lastReport !== undefined && !hasNewWork(s)) return { text: `Swarm ${id} ended.` }
          return { text: `Swarm ${id} ended. ${writeReport(root, session, id, clock())}` }
        } catch (err) {
          process.stderr.write(`omnis: report on omnis_swarm_end failed: ${err instanceof Error ? err.message : String(err)}\n`)
          return { text: `Swarm ${id} ended. The report could not be written (see the server log).` }
        }
      },
    },
    {
      name: 'omnis_swarm_status',
      description: 'Summarise the running swarm: agents with status, tokens and approximate cost, task counts and memory keys.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: () => {
        const id = session.mySwarm()
        if (id === null) return { text: 'No swarm is running.' }
        return { text: statusText(session.state(id).state, clock().getTime()) }
      },
    },
    {
      name: 'omnis_memory_put',
      description: `Store a value (up to ${MAX_VALUE_BYTES} bytes) under a key in the swarm's shared memory, so other agents can read it with omnis_memory_get.`,
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', pattern: MEMORY_KEY.source, description: 'e.g. "design/auth".' },
          value: { type: 'string', maxLength: MAX_VALUE_BYTES, description: `At most ${MAX_VALUE_BYTES} bytes.` },
          agent: { type: 'string', pattern: NAME.source, description: 'Your agent name, so the pane shows who wrote it.' },
        },
        required: ['key', 'value'],
        additionalProperties: false,
      },
      handler: args => {
        const key = memoryKey(args)
        const value = reqString(args, 'value', MAX_VALUE_BYTES)
        const bytes = Buffer.byteLength(value)
        if (bytes > MAX_VALUE_BYTES) throw new InputError(`value is ${bytes} bytes; the limit is ${MAX_VALUE_BYTES}`)
        const writer = optString(args, 'agent', 64, NAME) ?? 'lead'
        const now = clock()
        const swarm = session.swarmOrCreate(now)
        putMemory(root, swarm, key, value, writer, now)
        emit(makeEvent({ type: 'memory.put', swarm, src: 'mcp', agent: writer, data: { key, bytes, preview: preview(value) }, now }))
        return { text: `Stored ${key} (${bytes} bytes).` }
      },
    },
    {
      name: 'omnis_memory_get',
      description: "Read a value from the swarm's shared memory.",
      inputSchema: {
        type: 'object',
        properties: { key: { type: 'string', pattern: MEMORY_KEY.source } },
        required: ['key'],
        additionalProperties: false,
      },
      handler: args => {
        const key = memoryKey(args)
        const entry = readMemory(root, session.runningSwarm())[key]
        return { text: entry === undefined ? `No value for ${key}.` : entry.value }
      },
    },
    {
      name: 'omnis_memory_list',
      description: "List keys in the swarm's shared memory with who wrote them and when.",
      inputSchema: {
        type: 'object',
        properties: { prefix: { type: 'string', maxLength: 128, description: 'Only keys starting with this.' } },
        additionalProperties: false,
      },
      handler: args => {
        const prefix = optString(args, 'prefix', 128) ?? ''
        const all = readMemory(root, session.runningSwarm())
        const keys = Object.keys(all).filter(k => k.startsWith(prefix)).sort()
        if (keys.length === 0) return { text: 'No keys stored.' }
        return { text: keys.map(k => `${k} · ${all[k]!.writer} · ${all[k]!.at.slice(11, 19)}`).join('\n') }
      },
    },
    {
      name: 'omnis_task_create',
      description: 'Add a task to the swarm task board, optionally assigned to an agent. Returns its id (t1, t2, ...).',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 120 },
          assignee: { type: 'string', pattern: NAME.source, description: 'Agent name.' },
          dependsOn: { type: 'array', items: { type: 'string', pattern: TASK_ID.source }, maxItems: 20 },
          owns: OWNS_PROP,
          worktree: WORKTREE_PROP,
        },
        required: ['title'],
        additionalProperties: false,
      },
      handler: args => {
        const title = reqText(args, 'title', 120)
        const assignee = optString(args, 'assignee', 64, NAME)
        const dependsOn = optStringList(args, 'dependsOn', 20, 8, TASK_ID)
        const owns = ownsArg(args)
        const worktreeArg = optString(args, 'worktree', 400)
        const worktree = worktreeArg === undefined ? undefined : resolveWorktree(root, worktreeArg)
        const now = clock()
        const swarm = session.swarmOrCreate(now)
        const { state } = session.state(swarm)
        if (Object.keys(state.tasks).length >= MAX_TASKS) throw new InputError(`This swarm already has ${MAX_TASKS} tasks.`)
        const deps = dependsOn === undefined ? undefined : [...new Set(dependsOn)]
        for (const d of deps ?? []) if (!Object.hasOwn(state.tasks, d)) throw new InputError(`dependsOn: no task ${clip(d, 80)} in swarm ${swarm}.`)
        let n = Object.keys(state.tasks).length + 1
        while (Object.hasOwn(state.tasks, `t${n}`)) n++
        const id = `t${n}`
        emit(makeEvent({
          type: 'task.created', swarm, src: 'mcp', now,
          data: { id, title, ...(assignee !== undefined && { assignee }), ...(deps !== undefined && { dependsOn: deps }), ...(owns !== undefined && { owns }), ...(worktree !== undefined && { worktree }) },
        }))
        // Pin the gate the task starts with, where it would run now, so done can tell if it was edited since.
        const settings = settingsFor(gateOptions.env)
        if (settings.mode !== 'off') {
          try {
            const { digest } = gateTarget(root, null, worktree, settings.command)
            if (digest !== null) pinGate(root, swarm, id, digest)
          } catch {
            // The task exists by now; one whose gate can't be read is left unpinned, as a task with no gate is.
          }
        }
        return { text: `Created task ${id}.` }
      },
    },
  ]

  const taskUpdate: AsyncToolDef = {
    name: 'omnis_task_update',
    description: 'Change a task\'s state (pending, active, done, failed), assignee or note. Marking it done first runs the project\'s verification gate (its build and tests) unless that is turned off; a failing gate keeps the task open.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', pattern: TASK_ID.source },
        state: { type: 'string', enum: [...TASK_STATES] },
        assignee: { type: 'string', pattern: NAME.source },
        note: { type: 'string', maxLength: 200 },
        owns: { ...OWNS_PROP, description: `${OWNS_PROP.description} Replaces the task's list; an empty list clears it.` },
        worktree: WORKTREE_PROP,
        dependsOn: { type: 'array', items: { type: 'string', pattern: TASK_ID.source }, maxItems: 20, description: "The tasks that must be done before this one can start. Replaces the task's list; an empty list clears it. Only the lead may change it." },
        handoff: { type: 'boolean', description: "Save a note for whoever takes this task from its current assignee: what that agent did, what failed, which files it touched. Only the lead may use it. Not with state done." },
        skipGate: { type: 'boolean', description: 'Close the task without running its verification gate. Needs a note saying why. Only the lead may use it.' },
      },
      required: ['id', 'state'],
      additionalProperties: false,
    },
    handler: async (args, call = NO_CALL) => {
      const id = reqString(args, 'id', 8, TASK_ID)
      const taskState = reqEnum(args, 'state', TASK_STATES)
      const assignee = optString(args, 'assignee', 64, NAME)
      const note = optText(args, 'note', 200)
      const owns = ownsArg(args)
      const worktreeArg = optString(args, 'worktree', 400)
      const worktree = worktreeArg === undefined ? undefined : resolveWorktree(root, worktreeArg)
      const dependsArg = optStringList(args, 'dependsOn', 20, 8, TASK_ID)
      const dependsOn = dependsArg === undefined ? undefined : [...new Set(dependsArg)]
      if (args.handoff !== undefined && args.handoff !== null && typeof args.handoff !== 'boolean') throw new InputError('handoff must be true or false')
      if (args.handoff === true && taskState === 'done') throw new InputError('A done task has nothing to hand on.')
      if (args.skipGate !== undefined && args.skipGate !== null && typeof args.skipGate !== 'boolean') throw new InputError('skipGate must be true or false')
      if (args.skipGate === true && note === undefined) throw new InputError('skipGate needs a note saying why.')
      const swarm = session.runningSwarm()
      const tasks = session.state(swarm).state.tasks
      if (!Object.hasOwn(tasks, id)) throw new InputError(`No task ${clip(id, 80)} in swarm ${swarm}.`)
      for (const d of dependsOn ?? []) if (!Object.hasOwn(tasks, d)) throw new InputError(`dependsOn: no task ${clip(d, 80)} in swarm ${swarm}.`)
      const loop = dependsOn === undefined ? null : cyclePath(tasks, id, dependsOn)
      if (loop !== null) throw new InputError(`dependsOn would make a loop: ${loopText(loop)}.`)
      // The agent whose work is handed on is the assignee before this call.
      const handFrom = args.handoff === true ? workedAgent(session.state(swarm).state, tasks[id]!.assignee) : null
      if (args.handoff === true && handFrom === null) throw new InputError(`${id} has no agent's work to hand on.`)
      let reply: ToolResult = { text: `Task ${id} is now ${taskState}.` }
      const settings = settingsFor(gateOptions.env)
      if (taskState === 'done' && settings.mode !== 'off') {
        const task = tasks[id]!
        const out = await gateForDone({
          root, swarm, task, ...(worktree !== undefined && { worktree }), assignee: assignee ?? task.assignee,
          skip: args.skipGate === true, mode: settings.mode, command: settings.command, minutes: settings.minutes,
          pinned: pinnedGate(root, swarm, id),
          limitMs: gateOptions.limitMs ?? settings.minutes * 60_000, progressMs: gateOptions.progressMs ?? PROGRESS_MS,
          emit, now: clock, state: () => session.state(swarm).state, ctx: call,
        })
        // A gate that blocks leaves the task as it was: nothing from this call is written.
        if (!out.closes) return { text: out.text, isError: true }
        reply = { text: out.text }
      }
      const handed = handFrom === null ? null : saveNote(ctx, swarm, session.state(swarm).state, id, handFrom, 'lead', clock())
      emit(makeEvent({
        type: 'task.updated', swarm, src: 'mcp', now: clock(),
        data: { id, state: taskState, ...(assignee !== undefined && { assignee }), ...(note !== undefined && { note }), ...(owns !== undefined && { owns }), ...(worktree !== undefined && { worktree }), ...(dependsOn !== undefined && { dependsOn }) },
      }))
      return handed === null ? reply : { ...reply, text: `${reply.text}${handoffReply(handed, id)}` }
    },
  }

  // Anything but a bad-input error gets a fixed message; the detail (which may hold paths) goes to stderr only.
  const fixed = (name: string) => (err: unknown): never => {
    if (err instanceof InputError || err instanceof MemoryLimitError) throw err
    process.stderr.write(`omnis: ${name} failed: ${err instanceof Error ? err.message : String(err)}\n`)
    throw new Error(FAILED)
  }
  const guarded: AnyToolDef[] = tools.map((tool): ToolDef => ({
    ...tool,
    handler: (args, call) => {
      try {
        return tool.handler(args, call)
      } catch (err) {
        return fixed(tool.name)(err)
      }
    },
  }))
  guarded.push({ ...taskUpdate, handler: (args, call) => Promise.resolve().then(() => taskUpdate.handler(args, call)).catch(fixed(taskUpdate.name)) })
  return guarded
}
