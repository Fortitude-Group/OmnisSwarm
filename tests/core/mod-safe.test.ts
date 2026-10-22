import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const coreDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'core')
// Every core file is mod-safe except these, which the server alone uses. A new core file is checked without editing this.
const NODE_ONLY = new Set(['log.ts', 'snapshot.ts', 'swarm.ts'])
const MOD_SAFE = readdirSync(coreDir).filter(f => f.endsWith('.ts') && !NODE_ONLY.has(f))
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
