/**
 * omnis_replay: hands the pane a recorded swarm's events, page by page, for /omnis replay. Internal: the mod's guard
 * refuses the model (INTERNAL_TOOL). Read-only: it never appends events or changes which swarm the session owns.
 */
import { lstatSync } from 'node:fs'
import { isValidSwarmId } from '../../core/events.ts'
import { fitEvents } from '../../core/feed-reply.ts'
import { readEvents, sortEvents, swarmLogPath } from '../../core/log.ts'
import { REPLAY_TOOL } from '../../core/recording.ts'
import type { ReplayReply } from '../../core/replay-reply.ts'
import { recentSwarmIds } from '../../core/swarm.ts'
import { atLineStart, offsetAfter } from '../log-cursor.ts'
import type { Args, ToolDef } from '../protocol.ts'
import type { ToolContext } from '../tools.ts'
import { InputError, optString } from '../validate.ts'

const SWARM_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const FAILED = 'Could not read the swarm files in .omnis-swarm/ (see the server log).'

function since(args: Args): number {
  const v = args.since
  if (v === undefined || v === null) return 0
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new InputError('since must be a whole number of at least 0')
  return v
}

export function createReplayTools(ctx: ToolContext): ToolDef[] {
  const { root } = ctx
  const answer = (reply: ReplayReply) => ({ text: JSON.stringify(reply) })
  const tool: ToolDef = {
    name: REPLAY_TOOL,
    description: 'Internal to the OmnisSwarm pane: reads a recorded swarm for /omnis replay. When the OmnisSwarm mod is loaded it refuses calls from the model.',
    inputSchema: {
      type: 'object',
      properties: {
        swarm: { type: 'string', pattern: SWARM_ID.source, description: 'The swarm to replay; the most recent when left out.' },
        since: { type: 'integer', minimum: 0, description: 'The offset from the last reply; 0 to start.' },
      },
      additionalProperties: false,
    },
    handler: args => {
      const from = since(args)
      const named = optString(args, 'swarm', 64)
      if (named !== undefined && !isValidSwarmId(named)) throw new InputError('swarm is not a valid swarm id')
      try {
        const recent = recentSwarmIds(root, 5)
        const id = named ?? recent[0]
        if (id === undefined) return answer({ v: 1, kind: 'none', recent })
        const file = swarmLogPath(root, id)
        const stat = lstatSync(file, { throwIfNoEntry: false })
        // A symlink or directory is not a log: answering for it could loop the pane on empty pages.
        if (stat === undefined || !stat.isFile()) return answer({ v: 1, kind: 'none', recent })
        const restart = answer({ v: 1, kind: 'replay', swarm: id, offset: 0, done: false, events: [], bad: 0 })
        if (from > 0 && !atLineStart(file, from)) return restart
        const read = readEvents(file, from)
        if (read.reset) return restart
        const fit = Math.min(fitEvents(read.events, id), 500)
        const cut = fit === read.events.length ? { offset: read.offset, bad: read.bad } : offsetAfter(file, from, fit)
        const done = cut.offset >= lstatSync(file).size
        return answer({ v: 1, kind: 'replay', swarm: id, offset: cut.offset, done, events: sortEvents(read.events.slice(0, fit)), bad: cut.bad })
      } catch (err) {
        process.stderr.write(`omnis: omnis_replay failed: ${err instanceof Error ? err.message : String(err)}\n`)
        throw new Error(FAILED)
      }
    },
  }
  return [tool]
}
