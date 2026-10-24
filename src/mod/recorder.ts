/**
 * The recorder (spec section 6): observe-only hooks that turn Claude Code events into log events
 * and send each, fire and forget, to the server's internal omnis_record tool. Every hook calls
 * next once and returns its result unchanged; its own work is wrapped so a failure only loses an event.
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import { isValidSwarmId } from '../core/events.ts'
import { INTERNAL_TOOL, RECORD_TOOL, type RecordBody } from '../core/recording.ts'
// An import cycle (budget-guard imports record): neither file uses the other's exports at load, only in hooks.
import { guardStarted } from './budget-guard.ts'
import { Outbox } from './outbox.ts'
import { connectServer } from './server.ts'
import {
  agentFinished, agentStarted, agentUsage, failureText, messageSent, protocolMessage, sessionMeasure, toolEvent, whoOf, type Fields,
} from './record-events.ts'

/**
 * Told about each event the server accepted. The budget guard is the only observer; it binds its host through
 * guardStarted, called directly, because the validator lets $ reach only functions declared or imported here.
 */
export type RecordObserver = {
  /** omnis_record accepted `body` (stamped `ts`) into `swarm`. */
  recorded: (body: RecordBody, ts: string, swarm: string) => void
  /** Each session.measure's rate-limit windows, as the engine reported them (untrusted shape). */
  measured?: (rateLimits: unknown) => void
}

const MAX_SEEN = 1000
const seenAtom = atom({ plugin: 'omnis-swarm', key: 'seen' } as const, [] as string[])
const droppedAtom = atom({ plugin: 'omnis-swarm', key: 'dropped' } as const, 0)

/** Module state. A hot reload starts it over; session.start restores the seen agents and the drop count from $.state. */
const rec = {
  sessionId: null as string | null,
  server: null as string | null,
  seen: new Set<string>(),
  outbox: new Outbox(),
  /** The one read-back of the seen set and drop count from $.state, set before its first await so a second session.start shares it. */
  restoring: null as Promise<void> | null,
  /** One drop-count save in flight at a time; drops that land meanwhile cost one more save, not one each. */
  saving: false,
  dirty: false,
}
/** Told about each event the server accepted; set by registerRecorder. */
let observer: RecordObserver | null = null

function saveDropped($: EngineInterface): void {
  if (rec.saving) {
    rec.dirty = true
    return
  }
  rec.saving = true
  update($, droppedAtom, () => rec.outbox.dropped)
    .catch(() => {})
    .then(() => {
      rec.saving = false
      if (!rec.dirty) return
      rec.dirty = false
      saveDropped($)
    })
}

function remember($: EngineInterface, id: string): void {
  rec.seen.add(id)
  for (const old of rec.seen) {
    if (rec.seen.size <= MAX_SEEN) break
    rec.seen.delete(old)
  }
  update($, seenAtom, () => [...rec.seen]).catch(() => {})
}

/**
 * Fire and forget: never throws, and the hooks never await it. Arguments are plain data and the time is the hook's own.
 * The promise settles once the call has (or at once when nothing was sent), so a later event can be chained behind it.
 */
export function record($: EngineInterface, body: RecordBody | null, ts = new Date(Date.now()).toISOString()): Promise<void> {
  if (body === null) return Promise.resolve()
  const { sessionId, server } = rec
  if (sessionId === null || server === null) return Promise.resolve()
  const carried = rec.outbox.take()
  if (carried === null) {
    saveDropped($)
    return Promise.resolve()
  }
  const args = { sessionId, ts, ...body, ...(carried > 0 && { dropped: carried }) }
  if (carried > 0) saveDropped($)
  const failed = (): void => {
    rec.outbox.settle(false, carried)
    saveDropped($)
  }
  try {
    return $.mcp.call(server, RECORD_TOOL, args).then(result => {
      if (result.isError) return failed()
      rec.outbox.settle(true, carried)
      const block = result.content[0]
      const swarm = block !== undefined && block.type === 'text' && typeof block.text === 'string' && block.text.startsWith('ok ') ? block.text.slice(3) : ''
      // A throw in the observer must not count as a failed call.
      if (observer !== null && isValidSwarmId(swarm)) {
        try {
          observer.recorded(body, ts, swarm)
        } catch {
          // The guard keeps its last state.
        }
      }
    }, failed)
  } catch {
    failed()
    return Promise.resolve()
  }
}

/** Runs recorder work that must never reach the session: a throw only costs the event. */
function safely($: EngineInterface, work: () => void): void {
  try {
    work()
  } catch {
    rec.outbox.lose()
    saveDropped($)
  }
}

/**
 * The end event of a tool call, and for a protocol SendMessage its message event. Module level on purpose: a closure
 * made in the hook would share its scope with the hook's other closures and keep the tool's input and result alive.
 */
function endBodies(
  $: EngineInterface, tool: string, args: Fields, result: { isError?: boolean; deny?: unknown; result?: unknown; text?: unknown }, who: string,
): { end: RecordBody | null; message: RecordBody | null } {
  try {
    const failed = result.isError === true || result.deny !== undefined
    // Plain-text SendMessage is recorded from session.send; protocol payloads raise none, so they come from here.
    const message = tool === 'SendMessage' && !failed ? protocolMessage(args, who) : null
    return { end: toolEvent('end', tool, args, who, failed, failed ? failureText(result) : ''), message }
  } catch {
    rec.outbox.lose()
    saveDropped($)
    return { end: null, message: null }
  }
}

/** Sends the end once the start's call has settled, so it can't overtake it. Holds only the small bodies and the time. */
function chainEnd($: EngineInterface, started: Promise<void>, end: RecordBody | null, message: RecordBody | null, ts: string): void {
  void started.then(() =>
    safely($, () => {
      void record($, end, ts)
      void record($, message, ts)
    }),
  )
}

async function restore($: EngineInterface): Promise<void> {
  // $.state may hold anything (a corrupt or older file): keep only what has the right shape.
  const stored: unknown = await read($, droppedAtom)
  const seen: unknown = await read($, seenAtom)
  if (Array.isArray(seen)) for (const id of seen) if (typeof id === 'string') rec.seen.add(id)
  rec.outbox.dropped += typeof stored === 'number' && Number.isSafeInteger(stored) && stored >= 0 ? stored : 0
}

async function start($: EngineInterface): Promise<void> {
  // Restored before the session id and server are set, so no send can run (and fail) ahead of the stored count.
  rec.restoring ??= restore($)
  try {
    await rec.restoring
  } catch (error) {
    rec.restoring = null
    throw error
  }
  rec.sessionId = await $.session.id()
  rec.server = await connectServer($)
  // Agents started before a reload (or before the plugin loaded) still get their agent.started, once.
  for (const agent of await $.agent.list()) {
    if (rec.seen.has(agent.id)) continue
    const body = agentStarted({ name: agent.name, subagentType: agent.type, description: agent.description, parentAgentId: agent.parentId }, agent.id)
    if (body === null) continue
    remember($, agent.id)
    void record($, body)
  }
}

export function registerRecorder(on: On, given?: RecordObserver): void {
  observer = given ?? null
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    // Not awaited: connecting spawns the server, and a slow one must not hold up the session. Events before it
    // finishes find no session or server and are skipped. A failure leaves recording off; the session is untouched.
    void start($).catch(() => {})
    if (observer !== null) {
      // The guard is the only observer (see RecordObserver), so an observer means the guard binds here.
      safely($, () => guardStarted($))
    }
    return result
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    safely($, () => {
      const id = result.deny === undefined ? result.agentId : undefined
      if (typeof id !== 'string' || rec.seen.has(id)) return
      const body = agentStarted(e, id)
      if (body === null) return
      remember($, id)
      void record($, body)
    })
    return result
  }).catch((_$, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const args = e as unknown as Fields
    let agent: string | null = null
    let started: Promise<void> = Promise.resolve()
    safely($, () => {
      agent = INTERNAL_TOOL.test(tool) ? null : whoOf(args.agentId, rec.seen)
      if (agent !== null) started = record($, toolEvent('start', tool, args, agent))
    })
    const result = await next(e)
    const who: string | null = agent
    if (who !== null) {
      // Built now, so the wait holds only these small bodies and the time the tool finished, not its input or result.
      const ts = new Date(Date.now()).toISOString()
      const { end, message } = endBodies($, tool, args, result, who)
      // Not awaited: the result returns now.
      chainEnd($, started, end, message, ts)
    }
    return result
  }).catch((_$, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    safely($, () => {
      const agent = whoOf(e.agentId, rec.seen)
      if (agent !== null && result.usage !== null) void record($, agentUsage(result.usage, agent, e.model))
    })
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    safely($, () => {
      if (e.agentId === undefined) return
      const agent = whoOf(e.agentId, rec.seen)
      if (agent !== null) void record($, agentFinished(e.reason, agent))
    })
    return result
  })

  on('session.send', async ($, e, next) => {
    const result = await next(e)
    safely($, () => {
      if (e.origin.kind !== 'model' || result.isDelivered !== true) return
      const agent = whoOf(e.agentId, rec.seen)
      if (agent !== null) void record($, messageSent(e.to, e.text, agent))
    })
    return result
  }).catch((_$, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    safely($, () => observer?.measured?.((e as { rateLimits?: unknown }).rateLimits))
    safely($, () => void record($, sessionMeasure(e)))
    return result
  })
}
