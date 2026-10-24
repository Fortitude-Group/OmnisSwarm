/** Every tool group the server exposes. Later phases add a file and one line here, not a change to server.ts. */
import type { AnyToolDef } from './protocol.ts'
import { createTools, type ToolContext } from './tools.ts'
import { createExportTools } from './tools/export.ts'
import { createFeedTools } from './tools/feed.ts'
import { createFenceTools } from './tools/fence.ts'
import { createGatePlanTools } from './tools/gate-plan.ts'
import { createRecordTools } from './tools/record.ts'
import { createReportTools } from './tools/report.ts'
import { createReplayTools } from './tools/replay.ts'

/**
 * omnis_record is always offered. The server has no reliable signal for whether the recorder mod is
 * installed, so when mods are off this internal tool is unguarded. Accepted: the log is a display
 * record, and the same user could edit .omnis-swarm directly.
 */
export const toolFactories: ReadonlyArray<(ctx: ToolContext) => AnyToolDef[]> = [createTools, createRecordTools, createFeedTools, createReplayTools, createExportTools, createReportTools, createFenceTools, createGatePlanTools]
