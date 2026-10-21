/** The omnis_* MCP tools. Each validates its input, appends events and reads folded state. */
import { TASK_STATES, TOPOLOGIES, clip, isSafeKey, makeEvent, type SwarmEvent } from '../core/events.ts'
import { appendEvent, clearCurrent, readCurrent, writeCurrent } from '../core/log.ts'
import { loadState } from '../core/snapshot.ts'
import { agentStats, fileClashes, swarmTotals } from '../core/stats.ts'
import { announceSwarm, publishCurrent, uniqueSwarmId } from '../core/swarm.ts'
import { MEMORY_KEY, type SwarmState } from '../core/fold.ts'
import { MAX_VALUE_BYTES, MemoryLimitError, putMemory, readMemory } from './memory-store.ts'
import type { ToolDef } from './protocol.ts'
import { InputError, optString, optStringList, optText, reqEnum, reqString, reqText } from './validate.ts'

export type ToolContext = { root: string; now?: () => Date }

const NAME = /^[A-Za-z0-9._-]{1,64}$/
const TASK_ID = /^t[0-9]{1,6}$/

const usd = (x: number | null): string => (x === null ? '–' : `≈$${x.toFixed(x < 1 ? 3 : 2)}`)
const int = (n: number): string => Math.round(n).toLocaleString('en-GB')
const stamp = (d: Date): string => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)

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

/** Token-shaped runs are blanked before a value preview reaches the log. */
const SECRETISH = /(ghp_|gho_|github_pat_|sk-|sk_live_|xox[bap]-|AKIA)[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_.-]+|[A-Za-z0-9+/=_-]{32,}/g
const preview = (value: string): string => clip(value.replace(SECRETISH, '[redacted]'), 80)

export const MAX_TASKS = 500
const FAILED = 'Could not update the swarm files in .omnis-swarm/ (see the server log).'

export function createTools(ctx: ToolContext): ToolDef[] {
  const root = ctx.root
  const clock = ctx.now ?? (() => new Date())
  /** The swarm this server started or adopted. Other sessions in the same project may share `current`. */
  let mine: string | null = null
  /** True only when this server started `mine`. An adopted swarm belongs to another session and is never ended or renamed here. */
  let owned = false

  const emit = (event: SwarmEvent): void => {
    if (!appendEvent(root, event)) throw new Error('Could not write to the swarm log in .omnis-swarm/')
  }
  const hasEnded = (id: string): boolean => loadState(root, id).state.swarm.endedAt !== null
  /** My live swarm, adopting `current` while I have none. */
  const mySwarm = (adopt = true): string | null => {
    if (mine !== null && hasEnded(mine)) {
      mine = null
      owned = false
    }
    if (mine === null && adopt) {
      const c = readCurrent(root)
      if (c !== null && !hasEnded(c)) {
        mine = c
        owned = false
      }
    }
    return mine
  }
  const swarmOrCreate = (now: Date): string => {
    const id = mySwarm()
    if (id !== null) return id
    const idHint = `session-${stamp(now)}`
    const current = readCurrent(root)
    const claimed = uniqueSwarmId(root, idHint)
    announceSwarm(root, claimed, { src: 'mcp', now })
    if (current !== null && hasEnded(current)) {
      // current names an ended swarm: replace it, as an explicit init would
      writeCurrent(root, claimed)
      mine = claimed
    } else {
      // Another session may publish first; then we adopt its swarm and don't own it.
      mine = publishCurrent(root, claimed)
    }
    owned = mine === claimed
    return mine
  }
  const runningSwarm = (): string => {
    const id = mySwarm()
    if (id === null) throw new InputError('No swarm is running. Call omnis_swarm_init first.')
    return id
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
        },
        required: ['name', 'topology'],
        additionalProperties: false,
      },
      handler: args => {
        const name = reqText(args, 'name', 64)
        const topology = reqEnum(args, 'topology', TOPOLOGIES)
        const goal = optText(args, 'goal', 200)
        const now = clock()
        const data = { name, topology, ...(goal !== undefined && { goal }), implicit: false }
        const existing = mySwarm(false) // init never takes over a swarm it didn't start
        let replaced: string | null = null
        if (existing !== null && owned) {
          const { state } = loadState(root, existing)
          if (state.swarm.implicit) {
            emit(makeEvent({ type: 'swarm.started', swarm: existing, src: 'mcp', data, now }))
            return { text: `Swarm "${name}" (${topology}) now names the running session swarm ${existing}.` }
          }
          replaced = existing
        }
        const id = uniqueSwarmId(root, name)
        if (replaced !== null) emit(makeEvent({ type: 'swarm.ended', swarm: replaced, src: 'mcp', data: { outcome: 'replaced' }, now }))
        writeCurrent(root, id)
        mine = id
        owned = true
        emit(makeEvent({ type: 'swarm.started', swarm: id, src: 'mcp', data, now }))
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
        const id = runningSwarm()
        const outcome = optText(args, 'outcome', 200)
        if (!owned) {
          mine = null
          return { text: `Swarm ${id} belongs to another session and is still running; this session has let go of it.` }
        }
        emit(makeEvent({ type: 'swarm.ended', swarm: id, src: 'mcp', data: outcome === undefined ? {} : { outcome }, now: clock() }))
        if (readCurrent(root) === id) clearCurrent(root)
        mine = null
        owned = false
        return { text: `Swarm ${id} ended.` }
      },
    },
    {
      name: 'omnis_swarm_status',
      description: 'Summarise the running swarm: agents with status, tokens and approximate cost, task counts and memory keys.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: () => {
        const id = mySwarm()
        if (id === null) return { text: 'No swarm is running.' }
        return { text: statusText(loadState(root, id).state, clock().getTime()) }
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
        const swarm = swarmOrCreate(now)
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
        const entry = readMemory(root, runningSwarm())[key]
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
        const all = readMemory(root, runningSwarm())
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
        },
        required: ['title'],
        additionalProperties: false,
      },
      handler: args => {
        const title = reqText(args, 'title', 120)
        const assignee = optString(args, 'assignee', 64, NAME)
        const dependsOn = optStringList(args, 'dependsOn', 20, 8, TASK_ID)
        const now = clock()
        const swarm = swarmOrCreate(now)
        const { state } = loadState(root, swarm)
        if (Object.keys(state.tasks).length >= MAX_TASKS) throw new InputError(`This swarm already has ${MAX_TASKS} tasks.`)
        const deps = dependsOn === undefined ? undefined : [...new Set(dependsOn)]
        for (const d of deps ?? []) if (!Object.hasOwn(state.tasks, d)) throw new InputError(`dependsOn: no task ${clip(d, 80)} in swarm ${swarm}.`)
        let n = Object.keys(state.tasks).length + 1
        while (Object.hasOwn(state.tasks, `t${n}`)) n++
        const id = `t${n}`
        emit(makeEvent({
          type: 'task.created', swarm, src: 'mcp', now,
          data: { id, title, ...(assignee !== undefined && { assignee }), ...(deps !== undefined && { dependsOn: deps }) },
        }))
        return { text: `Created task ${id}.` }
      },
    },
    {
      name: 'omnis_task_update',
      description: 'Change a task\'s state (pending, active, done, failed), assignee or note.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', pattern: TASK_ID.source },
          state: { type: 'string', enum: [...TASK_STATES] },
          assignee: { type: 'string', pattern: NAME.source },
          note: { type: 'string', maxLength: 200 },
        },
        required: ['id', 'state'],
        additionalProperties: false,
      },
      handler: args => {
        const id = reqString(args, 'id', 8, TASK_ID)
        const taskState = reqEnum(args, 'state', TASK_STATES)
        const assignee = optString(args, 'assignee', 64, NAME)
        const note = optText(args, 'note', 200)
        const swarm = runningSwarm()
        if (!Object.hasOwn(loadState(root, swarm).state.tasks, id)) throw new InputError(`No task ${clip(id, 80)} in swarm ${swarm}.`)
        emit(makeEvent({
          type: 'task.updated', swarm, src: 'mcp', now: clock(),
          data: { id, state: taskState, ...(assignee !== undefined && { assignee }), ...(note !== undefined && { note }) },
        }))
        return { text: `Task ${id} is now ${taskState}.` }
      },
    },
  ]

  // Anything but a bad-input error gets a fixed message; the detail (which may hold paths) goes to stderr only.
  return tools.map(tool => ({
    ...tool,
    handler: args => {
      try {
        return tool.handler(args)
      } catch (err) {
        if (err instanceof InputError || err instanceof MemoryLimitError) throw err
        process.stderr.write(`omnis: ${tool.name} failed: ${err instanceof Error ? err.message : String(err)}\n`)
        throw new Error(FAILED)
      }
    },
  }))
}
