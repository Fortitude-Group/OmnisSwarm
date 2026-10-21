import { putMemory } from '../../../src/mcp/memory-store.ts'

const [root = '', prefix = 'p'] = process.argv.slice(2)
try {
  for (let i = 0; i < 100; i++) putMemory(root, 's1', `${prefix}/${i}`, `v${i}`, prefix)
} catch (err) {
  console.error(String(err))
  process.exit(1)
}
