import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { runStdio, type AsyncToolDef, type ToolDef } from '../../src/mcp/protocol.ts'

test('a promise handler is answered, and a quick call made meanwhile is answered first', async () => {
  let release: () => void = () => {}
  const slow: AsyncToolDef = { name: 'slow', description: '', inputSchema: { type: 'object' }, handler: () => new Promise(r => { release = () => r({ text: 'slow done' }) }) }
  const quick: ToolDef = { name: 'quick', description: '', inputSchema: { type: 'object' }, handler: () => ({ text: 'quick done' }) }
  const input = new PassThrough()
  const output = new PassThrough()
  const lines: string[] = []
  output.on('data', d => lines.push(...String(d).split('\n').filter(Boolean)))
  const done = runStdio([slow, quick], { name: 't', version: '0' }, input, output)
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'slow', arguments: {} } })}\n`)
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'quick', arguments: {} } })}\n`)
  await new Promise(r => setImmediate(r))
  release()
  await new Promise(r => setImmediate(r))
  input.end()
  await done
  assert.deepEqual(lines.map(l => JSON.parse(l).id), [2, 1])
  assert.equal(JSON.parse(lines[1]!).result.content[0].text, 'slow done')
})

test('a promise handler that rejects is an error result', async () => {
  const bad: AsyncToolDef = { name: 'bad', description: '', inputSchema: { type: 'object' }, handler: () => Promise.reject(new Error('nope')) }
  const input = new PassThrough()
  const output = new PassThrough()
  const lines: string[] = []
  output.on('data', d => lines.push(...String(d).split('\n').filter(Boolean)))
  const done = runStdio([bad], { name: 't', version: '0' }, input, output)
  input.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bad', arguments: {} } })}\n`)
  await new Promise(r => setImmediate(r))
  await done
  assert.equal(JSON.parse(lines[0]!).result.isError, true)
})
