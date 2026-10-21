import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nodeVersionProblem } from '../../src/mcp/node-version.ts'

test('Node 24 and newer pass, and so does 22.18 or later', () => {
  for (const v of ['24.0.0', 'v24.1.0', '25.3.1', '22.18.0', '22.20.1']) assert.equal(nodeVersionProblem(v), null, v)
})

test('older Node gets one clear line', () => {
  assert.equal(nodeVersionProblem('22.17.9'), 'omnis-swarm needs Node 24 or newer; found v22.17.9')
  assert.equal(nodeVersionProblem('v20.11.0'), 'omnis-swarm needs Node 24 or newer; found v20.11.0')
  assert.match(nodeVersionProblem('garbage') ?? '', /needs Node 24/)
})
