import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Files a Claude Code mod may import. A mod has web APIs only: no Buffer, process or require.
// Add a file name here to put it under the same rules.
const MOD_SAFE = ['events.ts', 'fold.ts', 'prices.ts', 'stats.ts']

const coreDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'core')
const source = (name: string) => readFileSync(join(coreDir, name), 'utf8')

const BANNED: Array<[string, RegExp]> = [
  ["from 'node:", /from\s+['"]node:/],
  ['require(', /\brequire\s*\(/],
  ['Buffer', /\bBuffer\b/],
  ['process.', /\bprocess\./],
  ['__dirname', /__dirname/],
  ['fetch', /\bfetch\b/],
  ['queueMicrotask', /\bqueueMicrotask\b/],
  ['setImmediate', /\bsetImmediate\b/],
  ['globalThis.process', /globalThis\.process\b/],
]

for (const name of MOD_SAFE) {
  test(`${name} uses no Node-only APIs`, () => {
    const text = source(name)
    for (const [label, re] of BANNED) assert.equal(re.test(text), false, `${name} contains ${label}`)
  })

  test(`${name} only imports other mod-safe files`, () => {
    const specifiers = [...source(name).matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!)
    for (const spec of specifiers) {
      assert.ok(spec.startsWith('./'), `${name} imports '${spec}', only relative imports of mod-safe files are allowed`)
      assert.ok(MOD_SAFE.includes(basename(spec)), `${name} imports '${spec}', which is not in MOD_SAFE`)
    }
  })
}
