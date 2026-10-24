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
/**
 * What a handler learns about its call. `signal` fires on `notifications/cancelled` for the call or when the input
 * ends. `progress` sends `notifications/progress` when the call carried a `_meta.progressToken`, else does nothing,
 * and does nothing once the reply has gone out. Sync tools may ignore it; tests may leave it out.
 */
export type CallContext = { signal: AbortSignal; progress: (message: string) => void }
export type ToolDef = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  handler: (args: Args, ctx?: CallContext) => ToolResult
}
/** A tool that takes a while (omnis_export): its reply goes out when the promise settles, and other calls are answered meanwhile. */
export type AsyncToolDef = Omit<ToolDef, 'handler'> & { handler: (args: Args, ctx?: CallContext) => Promise<ToolResult> }
export type AnyToolDef = ToolDef | AsyncToolDef
export type ServerInfo = { name: string; version: string }

type Id = string | number | null
export type RpcReply = { jsonrpc: '2.0'; id: Id; result?: unknown; error?: { code: number; message: string } }
export type RpcNotification = { jsonrpc: '2.0'; method: string; params: Record<string, unknown> }
/** runStdio's side of a call: where notifications go, and the calls still running, keyed by callKey(id). */
export type CallHooks = { notify: (msg: RpcNotification) => void; inflight: Map<string, AbortController> }
/** 5 and "5" are different request ids. */
const callKey = (id: string | number): string => `${typeof id}:${id}`

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

/** With only synchronous tools the reply is synchronous; an async tool's call answers with a promise of its reply. */
export function handleMessage(msg: unknown, tools: readonly ToolDef[], info: ServerInfo, hooks?: CallHooks): RpcReply | null
export function handleMessage(msg: unknown, tools: readonly AnyToolDef[], info: ServerInfo, hooks?: CallHooks): RpcReply | null | Promise<RpcReply | null>
export function handleMessage(msg: unknown, tools: readonly AnyToolDef[], info: ServerInfo, hooks?: CallHooks): RpcReply | null | Promise<RpcReply | null> {
  if (!isObj(msg)) return rpcError(null, -32600, 'Invalid Request')
  const hasId = typeof msg.id === 'string' || typeof msg.id === 'number'
  const id: Id = hasId ? (msg.id as string | number) : null
  if (typeof msg.method !== 'string') return hasId ? rpcError(id, -32600, 'Invalid Request') : null
  if (msg.jsonrpc !== '2.0') return hasId ? rpcError(id, -32600, 'Invalid Request') : null
  const params = isObj(msg.params) ? msg.params : {}
  if (!hasId) {
    // Notifications need no reply. A cancel aborts the matching call still running, if any.
    if (msg.method === 'notifications/cancelled' && hooks !== undefined && (typeof params.requestId === 'string' || typeof params.requestId === 'number')) {
      hooks.inflight.get(callKey(params.requestId))?.abort()
    }
    return null
  }

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
      const finish = (result: unknown): RpcReply =>
        !isObj(result) || typeof result.text !== 'string'
          ? fail('Tool returned no text')
          : rpcResult(id, { content: [{ type: 'text', text: result.text }], isError: result.isError === true })
      const failWith = (err: unknown): RpcReply => fail(err instanceof Error ? err.message : typeof err === 'string' ? err : 'Tool failed')
      const call = startCall(id as string | number, params, hooks)
      try {
        const result: unknown = tool.handler(args, call.ctx)
        // A promise is answered when it settles; the reply carries the call's id, so it may overtake others.
        if (isObj(result) && typeof result.then === 'function') {
          call.track()
          return Promise.resolve(result as unknown as PromiseLike<unknown>).then(finish, failWith).finally(call.end)
        }
        call.end()
        return finish(result)
      } catch (err) {
        call.end()
        return failWith(err)
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${msg.method.slice(0, 100)}`)
  }
}

/**
 * The context for one call. Progress is numbered from 1 per call and stops when the call ends. A call is only
 * tracked for cancelling while its promise is pending; a second running call with the same id replaces the first.
 */
function startCall(id: string | number, params: Record<string, unknown>, hooks: CallHooks | undefined): { ctx: CallContext; track: () => void; end: () => void } {
  const controller = new AbortController()
  const meta = isObj(params._meta) ? params._meta : {}
  const token = typeof meta.progressToken === 'string' || typeof meta.progressToken === 'number' ? meta.progressToken : undefined
  let ended = false
  let n = 0
  const progress = (message: string): void => {
    if (ended || token === undefined || hooks === undefined) return
    hooks.notify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: ++n, message: String(message) } })
  }
  const key = callKey(id)
  return {
    ctx: { signal: controller.signal, progress },
    track: () => { hooks?.inflight.set(key, controller) },
    end: () => {
      ended = true
      if (hooks?.inflight.get(key) === controller) hooks.inflight.delete(key)
    },
  }
}

const idOf = (msg: unknown): Id => (isObj(msg) && (typeof msg.id === 'string' || typeof msg.id === 'number') ? msg.id : null)

/** Serves until `input` ends (or `output` fails). Lines over MAX_LINE_BYTES are discarded without buffering. */
export function runStdio(
  tools: readonly AnyToolDef[],
  info: ServerInfo,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<void> {
  return new Promise(resolve => {
    let finished = false
    let parts: Buffer[] = []
    let len = 0
    let skipping = false

    // One writer for replies and notifications alike: each message is a single write of one whole line.
    const send = (reply: RpcReply | RpcNotification) => {
      if (!finished) output.write(`${JSON.stringify(reply)}\n`)
    }
    const hooks: CallHooks = { notify: send, inflight: new Map() }
    const finish = () => {
      if (finished) return
      finished = true
      input.removeListener('data', onData)
      // Nobody is left to answer: calls still running (a gate, say) are told to stop.
      for (const controller of hooks.inflight.values()) controller.abort()
      hooks.inflight.clear()
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
        const reply = handleMessage(msg, tools, info, hooks)
        if (reply instanceof Promise) reply.then(r => { if (r !== null) send(r) }, () => send(rpcError(idOf(msg), -32603, 'Internal error')))
        else if (reply !== null) send(reply)
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
