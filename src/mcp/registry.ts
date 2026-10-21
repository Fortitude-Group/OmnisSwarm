/** Every tool group the server exposes. Later phases add a file and one line here, not a change to server.ts. */
import type { ToolDef } from './protocol.ts'
import { createTools, type ToolContext } from './tools.ts'
import { createFeedTools } from './tools/feed.ts'
import { createRecordTools } from './tools/record.ts'

/**
 * omnis_record is always offered. The server has no reliable signal for whether the recorder mod is
 * installed, so when mods are off this internal tool is unguarded. Accepted: the log is a display
 * record, and the same user could edit .omnis-swarm directly.
 */
export const toolFactories: ReadonlyArray<(ctx: ToolContext) => ToolDef[]> = [createTools, createRecordTools, createFeedTools]
