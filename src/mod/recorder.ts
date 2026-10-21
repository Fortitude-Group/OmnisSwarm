/**
 * The recorder (spec section 6): observe-only hooks that turn Claude Code events into log events
 * and send each, fire and forget, to the server's internal omnis_record tool. Every hook calls
 * next once and returns its result unchanged; its own work is wrapped so a failure only loses an event.
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import { INTERNAL_TOOL, RECORD_TOOL, type RecordBody } from '../core/recording.ts'
import { Outbox } from './outbox.ts'
import { connectServer } from './server.ts'
import {
  agentFinished, agentStarted, agentUsage, messageSent, protocolMessage, sessionMeasure, toolEvent, whoOf, type Fields,
} from './record-events.ts'

const MAX_SEEN = 1000
const seenAtom = atom({ plugin: 'omnis-swarm', key: 'seen' } as const, [] as string[])
const droppedAtom = atom({ plugin: 'omnis-swarm', key: 'dropped' } as const, 0)

/** Module state. A hot reload starts it over; session.start restores the seen agents and the drop count from $.state. */
const rec = {
  sessionId: null as string | null,
  server: null as string | null,
  seen: new Set<string>(),
  outbox: new Outbox(),
}

function saveDropped($: EngineInterface): void {
  update($, droppedAtom, () => rec.outbox.dropped).catch(() => {})
}

function remember($: EngineInterface, id: string): void {
  rec.seen.add(id)
  for (const old of rec.seen) {
    if (rec.seen.size <= MAX_SEEN) break
    rec.seen.delete(old)
  }
  update($, seenAtom, () => [...rec.seen]).catch(() => {})
}

/** Fire and forget: never awaited, never throws. Arguments are plain data and the time is the hook's own. */
function send($: EngineInterface, body: RecordBody | null): void {
  if (body === null) return
  const { sessionId, server } = rec
  if (sessionId === null || server === null) return
  const carried = rec.outbox.take()
  if (carried === null) {
    saveDropped($)
    return
  }
  const args = { sessionId, ts: new Date(Date.now()).toISOString(), ...body, ...(carried > 0 && { dropped: carried }) }
  if (carried > 0) saveDropped($)
  const failed = (): void => {
    rec.outbox.settle(false, carried)
    saveDropped($)
  }
  try {
    $.mcp.call(server, RECORD_TOOL, args).then(result => (result.isError ? failed() : rec.outbox.settle(true, carried)), failed)
  } catch {
    failed()
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

async function start($: EngineInterface): Promise<void> {
  rec.sessionId = await $.session.id()
  rec.server = await connectServer($)
  rec.outbox.dropped = Math.max(rec.outbox.dropped, await read($, droppedAtom))
  for (const id of await read($, seenAtom)) rec.seen.add(id)
  // Agents started before a reload (or before the plugin loaded) still get their agent.started, once.
  for (const agent of await $.agent.list()) {
    if (rec.seen.has(agent.id)) continue
    const body = agentStarted({ name: agent.name, subagentType: agent.type, description: agent.description, parentAgentId: agent.parentId }, agent.id)
    if (body === null) continue
    remember($, agent.id)
    send($, body)
  }
}

export function registerRecorder(on: On): void {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    try {
      await start($)
    } catch {
      // Recording stays off for this session; the session itself is untouched.
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
      send($, body)
    })
    return result
  }).catch((_$, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const args = e as unknown as Fields
    let agent: string | null = null
    safely($, () => {
      agent = INTERNAL_TOOL.test(tool) ? null : whoOf(args.agentId, rec.seen)
      if (agent !== null) send($, toolEvent('start', tool, args, agent))
    })
    const result = await next(e)
    const who: string | null = agent
    if (who !== null) {
      safely($, () => {
        const failed = result.isError === true || result.deny !== undefined
        send($, toolEvent('end', tool, args, who, failed))
        // Plain-text SendMessage is recorded from session.send; protocol payloads raise none, so they come from here.
        if (tool === 'SendMessage' && !failed) send($, protocolMessage(args, who))
      })
    }
    return result
  }).catch((_$, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    safely($, () => {
      const agent = whoOf(e.agentId, rec.seen)
      if (agent !== null && result.usage !== null) send($, agentUsage(result.usage, agent))
    })
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    safely($, () => {
      if (e.agentId === undefined) return
      const agent = whoOf(e.agentId, rec.seen)
      if (agent !== null) send($, agentFinished(e.reason, agent))
    })
    return result
  })

  on('session.send', async ($, e, next) => {
    const result = await next(e)
    safely($, () => {
      if (e.origin.kind !== 'model' || result.isDelivered !== true) return
      const agent = whoOf(e.agentId, rec.seen)
      if (agent !== null) send($, messageSent(e.to, e.text, agent))
    })
    return result
  }).catch((_$, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    safely($, () => send($, sessionMeasure(e)))
    return result
  })
}
