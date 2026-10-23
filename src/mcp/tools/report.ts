/**
 * omnis_report (spec section 4.3): writes the run report of a swarm to .omnis-swarm/reports and answers the pointer
 * line. Internal (the mod's guard refuses the model). omnis_swarm_end calls writeReport directly.
 */
import { isValidSwarmId, makeEvent } from '../../core/events.ts'
import { appendEvent, isLink, swarmLogPath } from '../../core/log.ts'
import { REPORT_TOOL } from '../../core/recording.ts'
import { pointerText, reportMarkdown, reportSummary } from '../../core/report.ts'
import { existsSync } from 'node:fs'
import { stamp, writeUnique } from '../out-file.ts'
import type { Args, ToolDef } from '../protocol.ts'
import type { Session } from '../session.ts'
import type { ToolContext } from '../tools.ts'
import { InputError, optString } from '../validate.ts'

const FAILED = 'Could not write the swarm report (see the server log).'

/** Writes swarm `swarm`'s report and records report.written. Answers the pointer line. */
export function writeReport(root: string, session: Session, swarm: string, now: Date): string {
  const state = session.state(swarm).state
  const md = reportMarkdown(state, now.getTime(), -now.getTimezoneOffset())
  const name = writeUnique(root, 'reports', `${swarm}-${stamp(now)}`, '.md', md)
  const path = `.omnis-swarm/reports/${name}`
  const sum = reportSummary(state, now.getTime())
  if (!appendEvent(root, makeEvent({ type: 'report.written', swarm, src: 'mcp', data: { path, ...sum }, now }))) throw new Error('append failed')
  return pointerText(path, sum)
}

export function createReportTools(ctx: ToolContext): ToolDef[] {
  const { root, session } = ctx
  const clock = ctx.now ?? (() => new Date())
  const tool: ToolDef = {
    name: REPORT_TOOL,
    description: 'Internal to the OmnisSwarm plugin: writes a run report for /omnis report and when a run goes quiet. When the OmnisSwarm mod is loaded it refuses calls from the model.',
    inputSchema: {
      type: 'object',
      properties: { swarm: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,63}$' } },
      additionalProperties: false,
    },
    handler: (args: Args) => {
      const named = optString(args, 'swarm', 64)
      if (named !== undefined && !isValidSwarmId(named)) throw new InputError('swarm is not a valid swarm id')
      const swarm = named ?? session.mySwarm()
      if (swarm === null) throw new InputError('No swarm is running.')
      const file = swarmLogPath(root, swarm)
      if (!existsSync(file) || isLink(file)) throw new InputError(`No swarm ${swarm} here.`)
      try {
        return { text: writeReport(root, session, swarm, clock()) }
      } catch (err) {
        process.stderr.write(`omnis: ${REPORT_TOOL} failed: ${err instanceof Error ? err.message : String(err)}\n`)
        throw new Error(FAILED)
      }
    },
  }
  return [tool]
}
