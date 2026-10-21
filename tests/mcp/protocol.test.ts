import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { handleMessage, runStdio, MAX_LINE_BYTES, SUPPORTED_PROTOCOLS, DEFAULT_PROTOCOL, type ToolDef } from '../../src/mcp/protocol.ts'

const info = { name: 'omnis-swarm', version: '0.1.0' }
const echo: ToolDef = {
  name: 'omnis_echo',
  description: 'echo',
  inputSchema: { type: 'object', properties: { say: { type: 'string' } } },
  handler: args => ({ text: String(args.say) }),
}
const boom: ToolDef = { name: 'omnis_boom', description: 'fails', inputSchema: { type: 'object' }, handler: () => { throw new Error('nope') } }
const tools = [echo, boom]
const req = (id: number, method: string, params?: unknown) => ({ jsonrpc: '2.0', id, method, ...(params !== undefined && { params }) })

test('initialize echoes the protocol version and declares tools', () => {
  assert.deepEqual(handleMessage(req(1, 'initialize', { protocolVersion: '2025-03-26' }), tools, info), {
    jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: info },
  })
})

test('notifications get no reply', () => {
  assert.equal(handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, tools, info), null)
})

test('tools/list describes every tool', () => {
  const reply = handleMessage(req(2, 'tools/list'), tools, info)
  assert.deepEqual(reply?.result, { tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) })
})

test('tools/call runs the handler', () => {
  const reply = handleMessage(req(3, 'tools/call', { name: 'omnis_echo', arguments: { say: 'hi' } }), tools, info)
  assert.deepEqual(reply?.result, { content: [{ type: 'text', text: 'hi' }], isError: false })
})

test('a throwing handler becomes an error result, not a protocol error', () => {
  const reply = handleMessage(req(4, 'tools/call', { name: 'omnis_boom', arguments: {} }), tools, info)
  assert.deepEqual(reply?.result, { content: [{ type: 'text', text: 'nope' }], isError: true })
})

test('unknown tools, unknown methods and junk get JSON-RPC errors', () => {
  assert.equal(handleMessage(req(5, 'tools/call', { name: 'nope' }), tools, info)?.error?.code, -32602)
  assert.equal(handleMessage(req(6, 'resources/list'), tools, info)?.error?.code, -32601)
  assert.equal(handleMessage([1, 2], tools, info)?.error?.code, -32600)
  assert.equal(handleMessage({ jsonrpc: '1.0', id: 7, method: 'ping' }, tools, info)?.error?.code, -32600)
  assert.deepEqual(handleMessage(req(8, 'ping'), tools, info), { jsonrpc: '2.0', id: 8, result: {} })
})

test('runStdio answers each line and reports parse errors', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  const lines: string[] = []
  output.on('data', chunk => lines.push(...String(chunk).split('\n').filter(Boolean)))
  const done = runStdio(tools, info, input, output)
  input.write(`${JSON.stringify(req(1, 'ping'))}\n`)
  input.write('{not json\n')
  input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  input.end()
  await done
  assert.deepEqual(lines.map(l => JSON.parse(l)), [
    { jsonrpc: '2.0', id: 1, result: {} },
    { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
  ])
})

type Out = { id: number | null; result?: unknown; error?: { code: number; message?: string } }
async function serve(chunks: (string | Buffer)[], toolList: readonly ToolDef[] = tools): Promise<Out[]> {
  const input = new PassThrough()
  const output = new PassThrough()
  const lines: string[] = []
  output.on('data', chunk => lines.push(...String(chunk).split('\n').filter(Boolean)))
  const done = runStdio(toolList, info, input, output)
  for (const c of chunks) input.write(c)
  input.end()
  await done
  return lines.map(l => JSON.parse(l) as Out)
}

test('fix 1: a hostile tool name does not crash the server', async () => {
  const bad = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":{"toString":1}}}\n'
  const out = await serve([bad, `${JSON.stringify(req(2, 'ping'))}\n`])
  assert.equal(out.length, 2)
  assert.equal(out[0]?.error?.code, -32602)
  assert.deepEqual(out[1], { jsonrpc: '2.0', id: 2, result: {} })
})

test('fix 1: an unexpected throw becomes an internal error carrying the id', async () => {
  const broken = Object.assign([] as ToolDef[], { find: () => { throw new Error('boom') } })
  const out = await serve([`${JSON.stringify(req(9, 'tools/call', { name: 'x' }))}\n`, `${JSON.stringify(req(10, 'ping'))}\n`], broken)
  assert.deepEqual(out, [
    { jsonrpc: '2.0', id: 9, error: { code: -32603, message: 'Internal error' } },
    { jsonrpc: '2.0', id: 10, result: {} },
  ])
})

test('fix 2: an oversized line is dropped with one error, and the next line still works', async () => {
  const big = Buffer.alloc(MAX_LINE_BYTES + 10, 97)
  const out = await serve([big.subarray(0, 5000), big.subarray(5000), '\n', `${JSON.stringify(req(1, 'ping'))}\n`])
  assert.deepEqual(out, [
    { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request too large' } },
    { jsonrpc: '2.0', id: 1, result: {} },
  ])
})

test('fix 2: CRLF endings and a final line without a newline are handled', async () => {
  const out = await serve([`${JSON.stringify(req(1, 'ping'))}\r\n`, JSON.stringify(req(2, 'ping'))])
  assert.deepEqual(out, [{ jsonrpc: '2.0', id: 1, result: {} }, { jsonrpc: '2.0', id: 2, result: {} }])
})

test('fix 3: handlers get a null-prototype args object without dangerous keys', () => {
  let seen: Record<string, unknown> | undefined
  const spy: ToolDef = { name: 'spy', description: 'd', inputSchema: {}, handler: a => { seen = a; return { text: 'ok' } } }
  const params: unknown = JSON.parse('{"name":"spy","arguments":{"__proto__":{"x":1},"constructor":1,"prototype":2,"keep":3}}')
  handleMessage(req(1, 'tools/call', params), [spy], info)
  assert.equal(Object.getPrototypeOf(seen), null)
  assert.deepEqual(Object.keys(seen ?? {}), ['keep'])
})

test('fix 4: async handlers, missing text and odd throws are tool errors', () => {
  const call = (h: () => unknown) =>
    handleMessage(req(1, 'tools/call', { name: 't' }), [{ name: 't', description: 'd', inputSchema: {}, handler: h as ToolDef['handler'] }], info)?.result
  const err = (text: string) => ({ content: [{ type: 'text', text }], isError: true })
  assert.deepEqual(call(() => Promise.resolve({ text: 'x' })), err('Tool handlers must be synchronous'))
  assert.deepEqual(call(() => ({})), err('Tool returned no text'))
  assert.deepEqual(call(() => { throw { toString() { throw new Error('x') } } }), err('Tool failed'))
  assert.deepEqual(call(() => { throw 'plain' }), err('plain'))
})

test('fix 5: echoed input is truncated and unsupported protocol versions fall back', () => {
  assert.equal(handleMessage(req(1, 'm'.repeat(500)), tools, info)?.error?.message, `Method not found: ${'m'.repeat(100)}`)
  assert.equal(handleMessage(req(2, 'tools/call', { name: 'n'.repeat(500) }), tools, info)?.error?.message, `Unknown tool: ${'n'.repeat(100)}`)
  const r = handleMessage(req(3, 'initialize', { protocolVersion: 'evil' }), tools, info)?.result as { protocolVersion: string }
  assert.equal(r.protocolVersion, DEFAULT_PROTOCOL)
  assert.ok(SUPPORTED_PROTOCOLS.includes('2024-11-05'))
})

test('fix 6: an id with a non-string method is an invalid request; without an id there is no reply', () => {
  assert.equal(handleMessage({ jsonrpc: '2.0', id: 1, method: 5 }, tools, info)?.error?.code, -32600)
  assert.equal(handleMessage({ jsonrpc: '2.0', method: 5 }, tools, info), null)
})

test('fix 7: an output error ends the loop cleanly', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  const done = runStdio(tools, info, input, output)
  output.emit('error', new Error('EPIPE'))
  await done
  input.write(`${JSON.stringify(req(1, 'ping'))}\n`)
})

test('round 2 A: a rejecting async handler does not crash; the next request is answered', async () => {
  const rejecting: ToolDef = { name: 'rej', description: 'd', inputSchema: {}, handler: (() => Promise.reject(new Error('late'))) as unknown as ToolDef['handler'] }
  const out = await serve([`${JSON.stringify(req(1, 'tools/call', { name: 'rej' }))}\n`, `${JSON.stringify(req(2, 'ping'))}\n`], [rejecting])
  await new Promise(r => setTimeout(r, 20))
  assert.equal(out.length, 2)
  assert.deepEqual(out[1], { jsonrpc: '2.0', id: 2, result: {} })
})

test('round 2 B: nested arguments are cleaned and depth is capped', () => {
  let seen: Record<string, unknown> = {}
  const spy: ToolDef = { name: 'spy', description: 'd', inputSchema: {}, handler: a => { seen = a; return { text: 'ok' } } }
  const params: unknown = JSON.parse('{"name":"spy","arguments":{"opts":{"__proto__":{"polluted":1},"k":[{"constructor":1,"v":2}]}}}')
  handleMessage(req(1, 'tools/call', params), [spy], info)
  const opts = seen.opts as Record<string, unknown>
  assert.equal(Object.getPrototypeOf(opts), null)
  assert.equal(Object.hasOwn(opts, '__proto__'), false)
  const inner = (opts.k as Record<string, unknown>[])[0] as Record<string, unknown>
  assert.deepEqual(Object.keys(inner), ['v'])
  let deep: unknown = 1
  for (let i = 0; i < 40; i++) deep = { d: deep }
  handleMessage(req(2, 'tools/call', { name: 'spy', arguments: deep }), [spy], info)
  let node: unknown = seen
  let levels = 0
  while (node !== null && typeof node === 'object') { node = (node as Record<string, unknown>).d; levels++ }
  assert.ok(levels <= 33)
  assert.equal(node, null)
})
