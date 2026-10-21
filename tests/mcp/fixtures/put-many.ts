import { putMemory } from '../../../src/mcp/memory-store.ts'

// A generous lock wait: under load the other process may hold the lock for a while, and this test is about losing nothing.
const LOCK_WAIT_MS = 30_000
const [root = '', prefix = 'p'] = process.argv.slice(2)
try {
  for (let i = 0; i < 100; i++) putMemory(root, 's1', `${prefix}/${i}`, `v${i}`, prefix, new Date(), LOCK_WAIT_MS)
} catch (err) {
  console.error(String(err))
  process.exit(1)
}
