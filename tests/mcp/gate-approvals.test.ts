import { test } from 'node:test'
import assert from 'node:assert/strict'
import { APPROVAL_MS, approveGate, takeApproval } from '../../src/mcp/gate/approvals.ts'

const A = { dir: '/p', command: 'npm test', digest: 'a'.repeat(64) }

test('an approval is taken once', () => {
  approveGate('/r1', 's', 't1', A, 1000)
  assert.deepEqual(takeApproval('/r1', 's', 't1', 1000), A)
  assert.equal(takeApproval('/r1', 's', 't1', 1000), null)
})

test('an approval lasts 120 s', () => {
  assert.equal(APPROVAL_MS, 120_000)
  approveGate('/r2', 's', 't1', A, 0)
  assert.deepEqual(takeApproval('/r2', 's', 't1', 120_000), A)
  approveGate('/r2', 's', 't1', A, 0)
  assert.equal(takeApproval('/r2', 's', 't1', 120_001), null)
})

test('approvals are per project, swarm and task; a newer one replaces an older', () => {
  approveGate('/r3', 's', 't1', A, 0)
  assert.equal(takeApproval('/r3', 's', 't2', 0), null)
  assert.equal(takeApproval('/r3', 'other', 't1', 0), null)
  assert.equal(takeApproval('/r4', 's', 't1', 0), null)
  approveGate('/r3', 's', 't1', { ...A, command: 'npm run check' }, 1)
  assert.equal(takeApproval('/r3', 's', 't1', 1)?.command, 'npm run check')
})

test('the store stays bounded', () => {
  for (let i = 0; i < 5000; i++) approveGate('/r5', 's', `t${i}`, A, 0)
  assert.notEqual(takeApproval('/r5', 's', 't4999', 0), null)
  assert.equal(takeApproval('/r5', 's', 't0', 0), null, 'the oldest went first')
})
