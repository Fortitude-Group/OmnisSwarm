/** Every tool group the server exposes. Later phases add a file and one line here, not a change to server.ts. */
import type { ToolDef } from './protocol.ts'
import { createTools, type ToolContext } from './tools.ts'

export const toolFactories: ReadonlyArray<(ctx: ToolContext) => ToolDef[]> = [createTools]
