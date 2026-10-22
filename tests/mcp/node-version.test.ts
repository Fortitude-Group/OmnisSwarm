import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { nodeVersionProblem } from '../../src/mcp/node-version.mjs'

const START = fileURLToPath(new URL('../../src/mcp/start.mjs', import.meta.url))

test('Nodes that strip types by default pass: 22.18+, 23.6+, 24+', () => {
  for (const v of ['24.0.0', 'v24.1.0', '25.3.1', '22.18.0', '22.20.1', '23.6.0', 'v23.11.1']) assert.equal(nodeVersionProblem(v), null, v)
})

test('older Node gets one clear line naming what it needs and what it found', () => {
  assert.equal(nodeVersionProblem('22.17.9'), 'omnis-swarm needs Node 22.18 or newer (24 recommended); found v22.17.9')
  assert.equal(nodeVersionProblem('v23.5.0'), 'omnis-swarm needs Node 22.18 or newer (24 recommended); found v23.5.0')
  assert.equal(nodeVersionProblem('v20.11.0'), 'omnis-swarm needs Node 22.18 or newer (24 recommended); found v20.11.0')
  assert.match(nodeVersionProblem('garbage') ?? '', /needs Node 22\.18/)
})

test('start.mjs is plain JavaScript that any Node can parse, and loads the server only by dynamic import', () => {
  const source = readFileSync(START, 'utf8')
  assert.doesNotMatch(source, /^\s*import\s[^(]*['"]\.\/server\.ts['"]/m, 'a static import of server.ts would fail before the check runs')
  assert.match(source, /await import\('\.\/server\.ts'\)/)
  const check = spawnSync(process.execPath, ['--check', START], { encoding: 'utf8' })
  assert.equal(check.status, 0, check.stderr)
})
