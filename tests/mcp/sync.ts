import type { ToolResult } from '../../src/mcp/protocol.ts'

/** A sync tool's result as it is; an async tool (omnis_task_update) is a test mistake, so this throws for it. */
export function syncResult(r: ToolResult | Promise<ToolResult>): ToolResult {
  if (r instanceof Promise) throw new Error('this tool is async: await its handler instead')
  return r
}
