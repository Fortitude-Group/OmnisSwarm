/** Connects this plugin's own MCP server and answers the name $.mcp.call takes, or null when it can't connect. */
import type { EngineInterface } from 'claude-code'
import { SERVER_KEY } from '../core/recording.ts'

export async function connectServer($: EngineInterface): Promise<string | null> {
  const connected = await $.mcp.connect(SERVER_KEY)
  return connected.isConnected ? connected.server : null
}
