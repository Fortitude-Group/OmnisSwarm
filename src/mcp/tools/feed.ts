/**
 * omnis_feed: how the pane reads the swarm. Internal: the mod refuses the model's calls at tool.check and defers the
 * tool. It never appends events or changes which swarm the session owns (it can write a snapshot cache).
 */
import { closeSync, existsSync, openSync, readSync } from 'node:fs'
import { LIMITS, isValidSwarmId, parseLine } from '../../core/events.ts'
import { FEED_MAX_EVENTS, fitEvents, freshReply, type FeedReply } from '../../core/feed-reply.ts'
import { MAX_READ_BYTES, readCurrent, readEvents, sortEvents, swarmLogPath } from '../../core/log.ts'
import type { Loaded } from '../../core/snapshot.ts'
import type { Args, ToolDef } from '../protocol.ts'
import type { ToolContext } from '../tools.ts'
import { InputError, optString } from '../validate.ts'

const SWARM_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
/** True when the byte before `offset` is a newline, so `offset` starts a line. */
function atLineStart(file: string, offset: number): boolean {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(1)
    return readSync(fd, buf, 0, 1, offset - 1) === 1 && buf[0] === 0x0a
  } finally {
    closeSync(fd)
  }
}

/**
 * Where the log stands just after the `count`th event line at or beyond `since`, and how many bad lines came before it.
 * Walks the lines the way readEvents does, so the two agree on what is an event.
 */
function offsetAfter(file: string, since: number, count: number): { offset: number; bad: number } {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(MAX_READ_BYTES)
    const data = buf.subarray(0, readSync(fd, buf, 0, buf.length, since))
    let from = 0
    let seen = 0
    let bad = 0
    for (let nl = data.indexOf(0x0a, from); nl !== -1; nl = data.indexOf(0x0a, from)) {
      const raw = data.subarray(from, nl)
      from = nl + 1
      if (raw.length > LIMITS.line) {
        bad++
        continue
      }
      const line = raw.toString('utf8')
      if (line.trim() === '') continue
      const parsed = parseLine(line)
      if (parsed.ok) {
        if (++seen === count) return { offset: since + from, bad }
      } else if (parsed.reason !== 'version') bad++
    }
    throw new Error('the log changed under the feed')
  } finally {
    closeSync(fd)
  }
}

const FAILED = 'Could not read the swarm files in .omnis-swarm/ (see the server log).'

function optOffset(args: Args, key: string): number | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new InputError(`${key} must be a whole number of at least 0`)
  return value
}

export function createFeedTools(ctx: ToolContext): ToolDef[] {
  const { root, session } = ctx

  /** This server's live swarm, else the live current one, else the hinted one if its log exists, else an ended current. */
  const pick = (hint: string | undefined): string | null => {
    const live = session.mySwarm(false)
    if (live !== null) return live
    const current = readCurrent(root)
    if (current !== null && !session.hasEnded(current)) return current
    if (hint !== undefined && existsSync(swarmLogPath(root, hint))) return hint
    return current
  }
  const answer = (reply: FeedReply) => ({ text: JSON.stringify(reply) })
  const fresh = (id: string, held: Loaded) => answer(freshReply(id, held.offset, held.state))

  const tool: ToolDef = {
    name: 'omnis_feed',
    description: 'Internal to the OmnisSwarm pane. When the OmnisSwarm mod is loaded it refuses calls from the model.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'integer', minimum: 0, description: 'The offset from the last reply; 0 for the whole state.' },
        swarm: { type: 'string', pattern: SWARM_ID.source, description: 'The swarm the last reply was about.' },
      },
      additionalProperties: false,
    },
    handler: args => {
      const since = optOffset(args, 'since') ?? 0
      const hint = optString(args, 'swarm', 64, SWARM_ID)
      if (hint !== undefined && !isValidSwarmId(hint)) throw new InputError('swarm is not a valid swarm id')
      try {
        const id = pick(hint)
        if (id === null) return answer({ v: 1, kind: 'none' })
        const held = session.state(id)
        if (hint !== id || since === 0 || since > held.offset) return fresh(id, held)
        if (since === held.offset) return answer({ v: 1, kind: 'events', swarm: id, offset: since, events: [], bad: 0 })
        if (!atLineStart(swarmLogPath(root, id), since)) return fresh(id, held)
        const read = readEvents(swarmLogPath(root, id), since)
        if (read.reset || read.events.length > FEED_MAX_EVENTS || read.offset < held.offset) return fresh(id, session.state(id))
        const fit = fitEvents(read.events, id)
        if (fit === read.events.length) return answer({ v: 1, kind: 'events', swarm: id, offset: read.offset, events: sortEvents(read.events), bad: read.bad })
        // Too much for one reply: send the first events that fit and let the next pull carry on from after them.
        const cut = offsetAfter(swarmLogPath(root, id), since, fit)
        return answer({ v: 1, kind: 'events', swarm: id, offset: cut.offset, events: sortEvents(read.events.slice(0, fit)), bad: cut.bad })
      } catch (err) {
        // The detail may hold paths, so it goes to stderr only.
        process.stderr.write(`omnis: omnis_feed failed: ${err instanceof Error ? err.message : String(err)}\n`)
        throw new Error(FAILED)
      }
    },
  }
  return [tool]
}
