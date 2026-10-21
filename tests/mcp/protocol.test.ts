import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { handleMessage, runStdio, type ToolDef } from '../../src/mcp/protocol.ts'

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
