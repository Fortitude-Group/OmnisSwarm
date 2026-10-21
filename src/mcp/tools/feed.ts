/**
 * omnis_feed: how the pane reads the swarm. Internal: the mod refuses the model's calls at tool.check and defers the
 * tool. It only reads and never adopts a swarm, so pulling it cannot change which swarm this session owns.
 */
import { existsSync } from 'node:fs'
import { isValidSwarmId } from '../../core/events.ts'
import { FEED_MAX_EVENTS, type FeedReply } from '../../core/feed-reply.ts'
import { readCurrent, readEvents, sortEvents, swarmLogPath } from '../../core/log.ts'
import type { Loaded } from '../../core/snapshot.ts'
import type { Args, ToolDef } from '../protocol.ts'
import type { ToolContext } from '../tools.ts'
import { InputError, optString } from '../validate.ts'

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
  const fresh = (id: string, held: Loaded) => answer({ v: 1, kind: 'state', swarm: id, offset: held.offset, state: held.state })

  const tool: ToolDef = {
    name: 'omnis_feed',
    description: 'Internal to the OmnisSwarm pane, which reads swarm state with it. Not for the model: calls from the model are refused.',
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
        const read = readEvents(swarmLogPath(root, id), since)
        if (read.reset || read.events.length > FEED_MAX_EVENTS || read.offset < held.offset) return fresh(id, session.state(id))
        return answer({ v: 1, kind: 'events', swarm: id, offset: read.offset, events: sortEvents(read.events), bad: read.bad })
      } catch (err) {
        // The detail may hold paths, so it goes to stderr only.
        process.stderr.write(`omnis: omnis_feed failed: ${err instanceof Error ? err.message : String(err)}\n`)
        throw new Error(FAILED)
      }
    },
  }
  return [tool]
}
