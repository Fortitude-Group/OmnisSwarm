import { putMemory } from '../../../src/mcp/memory-store.ts'

// Waits until a shared start time so that several processes make the first write to a fresh root together.
// Sleeps most of the wait so the spin does not starve other tests of CPU.
const [root = '', prefix = 'p', startAt = '0'] = process.argv.slice(2)
const start = Number(startAt)
const nap = start - Date.now() - 20
if (nap > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, nap)
while (Date.now() < start) {
  // spin for the last few milliseconds
}
try {
  putMemory(root, 's1', `${prefix}/first`, 'v', prefix, new Date(), 30_000)
} catch (err) {
  console.error(String(err))
  process.exit(1)
}
