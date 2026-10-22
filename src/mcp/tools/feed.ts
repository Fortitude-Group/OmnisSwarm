/**
 * omnis_feed: how the pane reads the swarm. Internal: the mod refuses the model's calls at tool.check and defers the
 * tool. It never appends events or changes which swarm the session owns (it can write a snapshot cache).
 */
import { existsSync } from 'node:fs'
import { isValidSwarmId } from '../../core/events.ts'
import { FEED_MAX_EVENTS, fitEvents, freshReply, type FeedReply } from '../../core/feed-reply.ts'
import { readCurrent, readEvents, sortEvents, swarmLogPath } from '../../core/log.ts'
import { FEED_TOOL } from '../../core/recording.ts'
import { swarmOwner } from '../../core/swarm.ts'
import type { Loaded } from '../../core/snapshot.ts'
import { atLineStart, offsetAfter } from '../log-cursor.ts'
import type { Args, ToolDef } from '../protocol.ts'
import type { ToolContext } from '../tools.ts'
import { InputError, optString } from '../validate.ts'

/** For the input schema only; the handler checks with isValidSwarmId, which also refuses reserved names. */
const SWARM_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const FAILED = 'Could not read the swarm files in .omnis-swarm/ (see the server log).'

function optOffset(args: Args, key: string): number | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new InputError(`${key} must be a whole number of at least 0`)
  return value
}

export function createFeedTools(ctx: ToolContext): ToolDef[] {
  const { root, session } = ctx

  /**
   * True when the pane may follow swarm `id` by its hint. A session that never learned an id has no owner to check, so
   * any hint goes, as before. A session with an id follows only a swarm its log says it started; after a second,
   * conflicting id there is no key to match, so only the live swarm mySwarm returns is shown.
   */
  const followable = (id: string): boolean => {
    if (!existsSync(swarmLogPath(root, id))) return false
    if (session.sessionId === null) return true
    const key = session.sessionKey
    return key !== null && swarmOwner(root, id) === key
  }

  /**
   * This server's live swarm; else the hinted one if it is this session's; else, only for a session that never learned
   * an id, `current`. A session with an id is never shown another session's swarm. A session with no id prefers a live
   * `current` over its hint, so a pane left on an ended swarm moves on when a new one starts.
   */
  const pick = (hint: string | undefined): string | null => {
    const live = session.mySwarm(false)
    if (live !== null) return live
    const anonymous = session.sessionId === null
    const current = anonymous ? readCurrent(root) : null
    if (current !== null && !session.hasEnded(current)) return current
    if (hint !== undefined && followable(hint)) return hint
    return current
  }
  const answer = (reply: FeedReply) => ({ text: JSON.stringify(reply) })
  // The last too-large answer, so an unchanged swarm is not trimmed again on every poll.
  let tooLarge: { key: string; text: string } | null = null
  const fresh = (id: string, held: Loaded) => {
    const key = `${id}@${held.offset}`
    if (tooLarge !== null && tooLarge.key === key) return { text: tooLarge.text }
    const reply = freshReply(id, held.offset, held.state)
    const out = answer(reply)
    tooLarge = reply.kind === 'too-large' ? { key, text: out.text } : null
    return out
  }

  const tool: ToolDef = {
    name: FEED_TOOL,
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
      const hint = optString(args, 'swarm', 64)
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
