import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// The pane runs inside Claude Code's mod sandbox: web APIs only. This walks every render and pane file and
// everything they import, and fails on anything that sandbox does not have.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BANNED: Array<[string, RegExp]> = [
  ["from 'node:", /from\s+['"]node:/],
  ['require(', /\brequire\s*\(/],
  ['Buffer', /\bBuffer\b/],
  ['process.', /\bprocess\./],
  ['__dirname', /__dirname/],
  ['fetch', /\bfetch\b/],
  ['queueMicrotask', /\bqueueMicrotask\b/],
  ['setImmediate', /\bsetImmediate\b/],
  ['import(', /\bimport\s*\(/],
  ['setTimeout', /\bsetTimeout\b/],
  ['setInterval', /\bsetInterval\b/],
  ['console.', /\bconsole\./],
]

function entries(): string[] {
  const out: string[] = []
  const add = (dir: string, keep: (name: string) => boolean) => {
    const full = join(ROOT, dir)
    if (!existsSync(full)) return
    for (const name of readdirSync(full)) if (name.endsWith('.ts') && !name.endsWith('.test.ts') && keep(name)) out.push(join(full, name))
  }
  add('src/render', () => true)
  add('src/mod', name => name.startsWith('pane'))
  return out
}

test('render and pane files, and everything they import, are mod-safe', () => {
  const queue = entries()
  assert.ok(queue.length > 0, 'found the render files')
  const seen = new Set<string>()
  while (queue.length > 0) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    const name = relative(ROOT, file)
    const text = readFileSync(file, 'utf8')
    for (const [label, re] of BANNED) assert.equal(re.test(text), false, `${name} contains ${label}`)
    for (const m of text.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)) {
      const spec = m[1]!
      if (spec === 'claude-code') {
        assert.ok(name.startsWith(`src${sep}mod${sep}`), `${name} imports claude-code, which only mod files may`)
        continue
      }
      assert.ok(spec.startsWith('./') || spec.startsWith('../'), `${name} imports '${spec}'; only relative imports are allowed`)
      const target = resolve(dirname(file), spec)
      assert.ok(existsSync(target), `${name} imports '${spec}', which does not exist`)
      assert.ok(!relative(ROOT, target).startsWith('..'), `${name} imports '${spec}' from outside the plugin`)
      queue.push(target)
    }
  }
})
