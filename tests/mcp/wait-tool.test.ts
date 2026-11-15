import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WAIT_MAX_MS, createWaitTools } from '../../src/mcp/tools/wait.ts'
import { InputError } from '../../src/mcp/validate.ts'

const [wait] = createWaitTools()
const ctx = (signal: AbortSignal) => ({ signal, progress: () => undefined })

test('omnis_wait is internal and answers after the time asked', async () => {
  assert.equal(wait!.name, 'omnis_wait')
  assert.match(wait!.description, /Internal/)
  const t0 = Date.now()
  assert.deepEqual(await wait!.handler({ ms: 30 }, ctx(new AbortController().signal)), { text: 'ok' })
  assert.ok(Date.now() - t0 >= 25)
})

test('omnis_wait answers at once when the call is cancelled', async () => {
  const c = new AbortController()
  const t0 = Date.now()
  const reply = wait!.handler({ ms: WAIT_MAX_MS }, ctx(c.signal))
  c.abort()
  assert.deepEqual(await reply, { text: 'ok' })
  assert.ok(Date.now() - t0 < 1000)
  const gone = new AbortController()
  gone.abort()
  assert.deepEqual(await wait!.handler({ ms: WAIT_MAX_MS }, ctx(gone.signal)), { text: 'ok' })
})

test('omnis_wait refuses a time that is not 1 to 5000 ms', async () => {
  for (const ms of [0, -1, 1.5, WAIT_MAX_MS + 1, '100', undefined]) {
    await assert.rejects(wait!.handler({ ms }, ctx(new AbortController().signal)), InputError)
  }
})
