/**
 * omnis_record: how the recorder mod's events reach the log (a mod can't write files).
 * Internal: the mod's tool.check guard refuses it to the model, but when mods are off it is
 * unguarded, so this checks everything itself (spec section 6). It builds each event's data
 * afresh from known fields, so nothing else the caller sends reaches the log.
 */
import { AGENT_OUTCOMES, LIMITS, NAME, TOOL_KINDS, makeEvent, serialise, type EventData } from '../../core/events.ts'
import { appendEvent } from '../../core/log.ts'
import { RECORDER_TYPES, RECORD_TOOL, SESSION_ID, type RecorderType } from '../../core/recording.ts'
import type { Args, ToolDef } from '../protocol.ts'
import type { ToolContext } from '../tools.ts'
import { InputError, reqEnum, reqString } from '../validate.ts'

/** Control and format characters, line and paragraph separators, and lone surrogates (which no terminal can draw). */
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u
const MAX_COUNT = 1e12
const MAX_USD = 1e9
const MAX_USAGE = 1e9
const AHEAD_MS = 5 * 60_000
const BEHIND_MS = 24 * 3_600_000
const FAILED = 'Could not record the event in .omnis-swarm/ (see the server log).'

const isObj = (x: unknown): x is Args => typeof x === 'object' && x !== null && !Array.isArray(x)

/** Text that may be empty unless `nonEmpty`, at most `max` characters, with no control or formatting characters. */
function text(d: Args, key: string, max: number, nonEmpty = false): string {
  const v = d[key]
  if (typeof v !== 'string' || v.length > max || CONTROL.test(v) || (nonEmpty && v.trim() === '')) {
    throw new InputError(`data.${key} must be ${nonEmpty ? 'non-empty ' : ''}text of at most ${max} characters with no control characters`)
  }
  return v
}

function count(d: Args, key: string, max = MAX_COUNT): number {
  const v = d[key]
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > max) throw new InputError(`${key} must be a whole number from 0 to ${max}`)
  return v
}

function oneOf<T extends string>(d: Args, key: string, values: readonly T[]): T {
  const v = d[key]
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) throw new InputError(`data.${key} must be one of: ${values.join(', ')}`)
  return v as T
}

function agentName(d: Args, key: string): string {
  const v = d[key]
  if (typeof v !== 'string' || !NAME.test(v)) throw new InputError(`${key} must be an agent id (letters, digits, . _ -, at most 64)`)
  return v
}

/** The ts the mod stamped: an ISO-8601 UTC time with milliseconds, exactly as Date.toISOString writes it. */
function isoTime(v: unknown, clock: Date): string {
  if (typeof v !== 'string' || v.length > 32 || Number.isNaN(Date.parse(v)) || new Date(v).toISOString() !== v) {
    throw new InputError('ts must be an ISO-8601 UTC time with milliseconds')
  }
  const off = Date.parse(v) - clock.getTime()
  if (off > AHEAD_MS || off < -BEHIND_MS) throw new InputError('ts is too far from the server clock (at most 5 minutes ahead or 24 hours behind)')
  return v
}

function dataFor(type: RecorderType, d: Args): EventData[RecorderType] {
  switch (type) {
    case 'agent.started':
      return { name: text(d, 'name', 64), role: text(d, 'role', 64), description: text(d, 'description', LIMITS.description), parent: agentName(d, 'parent') }
    case 'agent.finished':
      return { outcome: oneOf(d, 'outcome', AGENT_OUTCOMES), ...(d.reason !== undefined && { reason: text(d, 'reason', LIMITS.reason) }) }
    case 'agent.usage':
      return {
        model: text(d, 'model', 80),
        input: count(d, 'input', MAX_USAGE), output: count(d, 'output', MAX_USAGE), cacheRead: count(d, 'cacheRead', MAX_USAGE),
        cacheWrite5m: count(d, 'cacheWrite5m', MAX_USAGE), cacheWrite1h: count(d, 'cacheWrite1h', MAX_USAGE),
      }
    case 'agent.tool': {
      const isError = d.isError
      if (typeof isError !== 'boolean') throw new InputError('data.isError must be true or false')
      return {
        phase: oneOf(d, 'phase', ['start', 'end'] as const), tool: text(d, 'tool', 80, true),
        kind: oneOf(d, 'kind', TOOL_KINDS), subject: text(d, 'subject', LIMITS.subject), isError,
      }
    }
    case 'message.sent':
      return { to: text(d, 'to', 64, true), summary: text(d, 'summary', LIMITS.summary) }
    case 'session.measure': {
      const usd = d.costUsd
      if (usd !== undefined && (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0 || usd > MAX_USD)) {
        throw new InputError(`data.costUsd must be a number from 0 to ${MAX_USD}`)
      }
      return {
        contextWindow: count(d, 'contextWindow'),
        ...(d.contextTokens !== undefined && { contextTokens: count(d, 'contextTokens') }),
        ...(d.contextPercent !== undefined && { contextPercent: count(d, 'contextPercent', 100) }),
        ...(usd !== undefined && { costUsd: usd }),
      }
    }
  }
}

export function createRecordTools(ctx: ToolContext): ToolDef[] {
  const { root, session } = ctx
  const tool: ToolDef = {
    name: RECORD_TOOL,
    description: 'Internal to the omnis-swarm plugin: the recorder mod appends one observed event to the swarm log. Calls from the model are refused.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', pattern: SESSION_ID.source },
        ts: { type: 'string', maxLength: 32 },
        type: { type: 'string', enum: [...RECORDER_TYPES] },
        agent: { type: 'string', pattern: NAME.source },
        data: { type: 'object' },
        dropped: { type: 'integer', minimum: 0 },
      },
      required: ['sessionId', 'ts', 'type', 'data'],
      additionalProperties: false,
    },
    handler: args => {
      const type = reqEnum(args, 'type', RECORDER_TYPES)
      const sessionId = reqString(args, 'sessionId', 64, SESSION_ID)
      const ts = isoTime(args.ts, (ctx.now ?? (() => new Date()))())
      const agent = args.agent === undefined ? undefined : agentName(args, 'agent')
      if (!isObj(args.data)) throw new InputError('data must be an object')
      const dropped = args.dropped === undefined ? 0 : count(args, 'dropped')
      const data = dataFor(type, args.data)
      if (dropped > 0) Object.assign(data, { dropped })
      const now = new Date(ts)
      // Checked before anything touches the disk, so a refused call writes nothing.
      const probe = makeEvent({ type, swarm: 'probe', src: 'recorder', data, ...(agent !== undefined && { agent }), now })
      try {
        serialise(probe)
      } catch {
        throw new InputError(`the event is over ${LIMITS.line} bytes`)
      }
      session.noteSession(sessionId)
      const swarm = session.swarmOrCreate(now)
      if (!appendEvent(root, { ...probe, swarm })) throw new Error('append failed')
      return { text: 'ok' }
    },
  }
  return [{
    ...tool,
    // Anything but a bad-input error gets a fixed message; the detail (which may hold paths) goes to stderr only.
    handler: args => {
      try {
        return tool.handler(args)
      } catch (err) {
        if (err instanceof InputError) throw err
        process.stderr.write(`omnis: ${RECORD_TOOL} failed: ${err instanceof Error ? err.message : String(err)}\n`)
        throw new Error(FAILED)
      }
    },
  }]
}
