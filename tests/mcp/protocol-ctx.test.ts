import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { handleMessage, runStdio, type AsyncToolDef, type CallContext, type ToolDef } from '../../src/mcp/protocol.ts'

const tick = () => new Promise(r => setImmediate(r))
const call = (id: number | string, name: string, meta?: Record<string, unknown>) =>
  `${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {}, ...(meta !== undefined && { _meta: meta }) } })}\n`
const cancel = (requestId: unknown) => `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId, reason: 'user' } })}\n`

/** A tool that reports progress twice when told to, and answers 'aborted' when its signal fires. */
function harness() {
  let seen: CallContext | null = null
  const slow: AsyncToolDef = {
    name: 'slow', description: '', inputSchema: { type: 'object' },
    handler: (_args, ctx) => new Promise(resolve => {
      seen = ctx!
      ctx!.signal.addEventListener('abort', () => resolve({ text: 'aborted' }))
    }),
  }
  const quick: ToolDef = { name: 'quick', description: '', inputSchema: { type: 'object' }, handler: () => ({ text: 'quick done' }) }
  const input = new PassThrough()
  const output = new PassThrough()
  const raw: string[] = []
  output.on('data', d => raw.push(String(d)))
  const done = runStdio([slow, quick], { name: 't', version: '0' }, input, output)
  const lines = () => raw.join('').split('\n').filter(Boolean).map(l => JSON.parse(l))
  return { input, done, lines, ctx: () => seen as CallContext | null, raw }
}

test('progress goes out as notifications/progress with the call token and a rising number', async () => {
  const h = harness()
  h.input.write(call(1, 'slow', { progressToken: 'tok-1' }))
  await tick()
  h.ctx()!.progress('gate running, 0.5 min')
  h.ctx()!.progress('gate running, 1 min')
  h.input.write(cancel(1))
  await tick()
  await tick()
  h.input.end()
  await h.done
  const [p1, p2, reply] = h.lines()
  assert.deepEqual(p1, { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 'tok-1', progress: 1, message: 'gate running, 0.5 min' } })
  assert.deepEqual(p2.params, { progressToken: 'tok-1', progress: 2, message: 'gate running, 1 min' })
  assert.equal(reply.id, 1)
  assert.equal(reply.result.content[0].text, 'aborted')
})

test('a numeric progress token is kept as a number', async () => {
  const h = harness()
  h.input.write(call(1, 'slow', { progressToken: 42 }))
  await tick()
  h.ctx()!.progress('x')
  h.input.end()
  await h.done
  assert.equal(h.lines()[0].params.progressToken, 42)
})

test('without a progress token, progress sends nothing', async () => {
  const h = harness()
  h.input.write(call(1, 'slow'))
  await tick()
  h.ctx()!.progress('ignored')
  h.input.write(cancel(1))
  await tick()
  await tick()
  h.input.end()
  await h.done
  const lines = h.lines()
  assert.equal(lines.length, 1)
  assert.equal(lines[0].id, 1)
})

test('cancelled aborts only the call whose id matches, by value and type', async () => {
  const h = harness()
  h.input.write(call(5, 'slow'))
  await tick()
  const ctx = h.ctx()!
  h.input.write(cancel('5'))
  h.input.write(cancel(6))
  h.input.write(cancel(null))
  await tick()
  assert.equal(ctx.signal.aborted, false)
  h.input.write(cancel(5))
  await tick()
  assert.equal(ctx.signal.aborted, true)
  h.input.end()
  await h.done
})

test('a string call id is cancelled by the same string', async () => {
  const h = harness()
  h.input.write(call('abc', 'slow'))
  await tick()
  h.input.write(cancel('abc'))
  await tick()
  assert.equal(h.ctx()!.signal.aborted, true)
  h.input.end()
  await h.done
})

test('progress after the reply has gone out is not sent', async () => {
  const h = harness()
  h.input.write(call(1, 'slow', { progressToken: 't' }))
  await tick()
  const ctx = h.ctx()!
  h.input.write(cancel(1))
  await tick()
  await tick()
  ctx.progress('late')
  h.input.end()
  await h.done
  assert.deepEqual(h.lines().map(l => l.method ?? l.id), [1])
})

test('when input ends, calls still running are aborted', async () => {
  const h = harness()
  h.input.write(call(1, 'slow'))
  await tick()
  const ctx = h.ctx()!
  h.input.end()
  await h.done
  assert.equal(ctx.signal.aborted, true)
})

test('every line written is one whole message', async () => {
  const h = harness()
  h.input.write(call(1, 'slow', { progressToken: 't' }))
  await tick()
  for (let i = 0; i < 20; i++) h.ctx()!.progress(`p${i}`)
  h.input.write(call(2, 'quick'))
  await tick()
  h.input.end()
  await h.done
  for (const chunk of h.raw) assert.ok(chunk.endsWith('\n'), 'each write ends a line')
  assert.equal(h.lines().length, 21)
})

test('a sync tool still answers synchronously and gets a context it may ignore', () => {
  let got: CallContext | undefined
  const sync: ToolDef = { name: 'sync', description: '', inputSchema: { type: 'object' }, handler: (_a, ctx) => { got = ctx; return { text: 'ok' } } }
  const reply = handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'sync', arguments: {} } }, [sync], { name: 't', version: '0' })
  assert.ok(reply !== null && !(reply instanceof Promise))
  assert.equal((reply.result as { content: { text: string }[] }).content[0]!.text, 'ok')
  assert.equal(got?.signal.aborted, false)
  got?.progress('no-op without a token')
})
