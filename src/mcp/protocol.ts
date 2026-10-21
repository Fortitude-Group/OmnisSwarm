/**
 * The small part of MCP that a tools-only server needs: newline-delimited JSON-RPC 2.0 on stdio,
 * with initialize, ping, tools/list and tools/call. Hand-rolled so the plugin has no npm dependencies.
 * Only replies go to stdout. Anything else would corrupt the stream.
 */
import type { Readable, Writable } from 'node:stream'

export const DEFAULT_PROTOCOL = '2025-06-18'
export const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
export const MAX_LINE_BYTES = 1_048_576

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

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const MAX_ARG_DEPTH = 32

/** Copies parsed JSON with null prototypes and without prototype-pollution keys; anything past MAX_ARG_DEPTH becomes null. */
function cleanValue(value: unknown, depth: number): unknown {
  if (Array.isArray(value)) return depth >= MAX_ARG_DEPTH ? null : value.map(v => cleanValue(v, depth + 1))
  if (isObj(value)) {
    if (depth >= MAX_ARG_DEPTH) return null
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of Object.keys(value)) {
      if (!FORBIDDEN_KEYS.has(key)) out[key] = cleanValue(value[key], depth + 1)
    }
    return out
  }
  return value
}

export function handleMessage(msg: unknown, tools: readonly ToolDef[], info: ServerInfo): RpcReply | null {
  if (!isObj(msg)) return rpcError(null, -32600, 'Invalid Request')
  const hasId = typeof msg.id === 'string' || typeof msg.id === 'number'
  const id: Id = hasId ? (msg.id as string | number) : null
  if (typeof msg.method !== 'string') return hasId ? rpcError(id, -32600, 'Invalid Request') : null
  if (msg.jsonrpc !== '2.0') return hasId ? rpcError(id, -32600, 'Invalid Request') : null
  if (!hasId) return null // notifications need no reply
  const params = isObj(msg.params) ? msg.params : {}

  switch (msg.method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion:
          typeof params.protocolVersion === 'string' && SUPPORTED_PROTOCOLS.includes(params.protocolVersion)
            ? params.protocolVersion
            : DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: info,
      })
    case 'ping':
      return rpcResult(id, {})
    case 'tools/list':
      return rpcResult(id, { tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) })
    case 'tools/call': {
      const tool = typeof params.name === 'string' ? tools.find(t => t.name === params.name) : undefined
      if (tool === undefined) {
        return rpcError(id, -32602, typeof params.name === 'string' ? `Unknown tool: ${params.name.slice(0, 100)}` : 'Unknown tool')
      }
      const args = (isObj(params.arguments) ? cleanValue(params.arguments, 0) : Object.create(null)) as Args
      const fail = (text: string) => rpcResult(id, { content: [{ type: 'text', text }], isError: true })
      try {
        const result: unknown = tool.handler(args)
        if (isObj(result) && typeof result.then === 'function') {
          ;(result.then as (a: undefined, b: () => void) => unknown).call(result, undefined, () => {}) // swallow a later rejection
          return fail('Tool handlers must be synchronous')
        }
        if (!isObj(result) || typeof result.text !== 'string') return fail('Tool returned no text')
        return rpcResult(id, { content: [{ type: 'text', text: result.text }], isError: result.isError === true })
      } catch (err) {
        return fail(err instanceof Error ? err.message : typeof err === 'string' ? err : 'Tool failed')
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${msg.method.slice(0, 100)}`)
  }
}

const idOf = (msg: unknown): Id => (isObj(msg) && (typeof msg.id === 'string' || typeof msg.id === 'number') ? msg.id : null)

/** Serves until `input` ends (or `output` fails). Lines over MAX_LINE_BYTES are discarded without buffering. */
export function runStdio(
  tools: readonly ToolDef[],
  info: ServerInfo,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<void> {
  return new Promise(resolve => {
    let finished = false
    let parts: Buffer[] = []
    let len = 0
    let skipping = false

    const send = (reply: RpcReply) => {
      if (!finished) output.write(`${JSON.stringify(reply)}\n`)
    }
    const finish = () => {
      if (finished) return
      finished = true
      input.removeListener('data', onData)
      resolve()
    }
    const processLine = (raw: string) => {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
      if (line.trim() === '') return
      let msg: unknown
      try {
        msg = JSON.parse(line)
      } catch {
        send(rpcError(null, -32700, 'Parse error'))
        return
      }
      try {
        const reply = handleMessage(msg, tools, info)
        if (reply !== null) send(reply)
      } catch {
        send(rpcError(idOf(msg), -32603, 'Internal error'))
      }
    }
    function onData(chunk: Buffer | string) {
      let buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      while (buf.length > 0 && !finished) {
        const nl = buf.indexOf(10)
        const end = nl === -1 ? buf.length : nl
        if (!skipping) {
          len += end
          if (len > MAX_LINE_BYTES) {
            skipping = true
            parts = []
            len = 0
            send(rpcError(null, -32600, 'Request too large'))
          } else {
            parts.push(buf.subarray(0, end))
          }
        }
        if (nl === -1) break
        if (!skipping) processLine(Buffer.concat(parts).toString('utf8'))
        parts = []
        len = 0
        skipping = false
        buf = buf.subarray(nl + 1)
      }
    }

    input.on('data', onData)
    input.once('end', () => {
      if (!skipping && len > 0) processLine(Buffer.concat(parts).toString('utf8'))
      finish()
    })
    input.on('error', finish)
    output.on('error', finish)
  })
}
