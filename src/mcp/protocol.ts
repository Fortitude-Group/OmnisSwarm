/**
 * The small part of MCP that a tools-only server needs: newline-delimited JSON-RPC 2.0 on stdio,
 * with initialize, ping, tools/list and tools/call. Hand-rolled so the plugin has no npm dependencies.
 * Only replies go to stdout. Anything else would corrupt the stream.
 */
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'

export const DEFAULT_PROTOCOL = '2025-06-18'

export type Args = Record<string, unknown>
export type ToolResult = { text: string; isError?: boolean }
export type ToolDef = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  handler: (args: Args) => ToolResult
}
export type ServerInfo = { name: string; version: string }

type Id = string | number | null
export type RpcReply = { jsonrpc: '2.0'; id: Id; result?: unknown; error?: { code: number; message: string } }

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)

export const rpcResult = (id: Id, result: unknown): RpcReply => ({ jsonrpc: '2.0', id, result })
export const rpcError = (id: Id, code: number, message: string): RpcReply => ({ jsonrpc: '2.0', id, error: { code, message } })

export function handleMessage(msg: unknown, tools: readonly ToolDef[], info: ServerInfo): RpcReply | null {
  if (!isObj(msg)) return rpcError(null, -32600, 'Invalid Request')
  const hasId = typeof msg.id === 'string' || typeof msg.id === 'number'
  const id: Id = hasId ? (msg.id as string | number) : null
  if (typeof msg.method !== 'string') return null // a response to us, or junk with nothing to answer
  if (msg.jsonrpc !== '2.0') return hasId ? rpcError(id, -32600, 'Invalid Request') : null
  if (!hasId) return null // notifications need no reply
  const params = isObj(msg.params) ? msg.params : {}

  switch (msg.method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: info,
      })
    case 'ping':
      return rpcResult(id, {})
    case 'tools/list':
      return rpcResult(id, { tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) })
    case 'tools/call': {
      const tool = typeof params.name === 'string' ? tools.find(t => t.name === params.name) : undefined
      if (tool === undefined) return rpcError(id, -32602, `Unknown tool: ${String(params.name)}`)
      const args = isObj(params.arguments) ? params.arguments : {}
      try {
        const result = tool.handler(args)
        return rpcResult(id, { content: [{ type: 'text', text: result.text }], isError: result.isError === true })
      } catch (err) {
        return rpcResult(id, { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true })
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${msg.method}`)
  }
}

/** Serves until `input` ends. */
export function runStdio(
  tools: readonly ToolDef[],
  info: ServerInfo,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity })
  lines.on('line', line => {
    if (line.trim() === '') return
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      output.write(`${JSON.stringify(rpcError(null, -32700, 'Parse error'))}\n`)
      return
    }
    const reply = handleMessage(msg, tools, info)
    if (reply !== null) output.write(`${JSON.stringify(reply)}\n`)
  })
  return new Promise(resolve => lines.on('close', () => resolve()))
}
