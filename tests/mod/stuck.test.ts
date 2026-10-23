import { test } from 'node:test'
import assert from 'node:assert/strict'
import { REPEAT_NUDGE_AFTER, STUCK_NUDGE_AFTER, StuckWatch, nudgeFor, stuckMainText } from '../../src/mod/stuck.ts'

test('five failed calls in a row is one failing hit; a success re-arms it', () => {
  const w = new StuckWatch()
  for (let i = 1; i < STUCK_NUDGE_AFTER; i++) assert.equal(w.end('a1', 'Bash', 'bash', 'npm test', true), null)
  assert.deepEqual(w.end('a1', 'Bash', 'bash', 'npm test', true), { pattern: 'failing', count: 5, tool: 'Bash', subject: 'npm test' })
  assert.equal(w.end('a1', 'Bash', 'bash', 'npm test', true), null)
  w.end('a1', 'Bash', 'bash', 'npm test', false)
  for (let i = 1; i < STUCK_NUDGE_AFTER; i++) w.end('a1', 'Bash', 'bash', 'x', true)
  assert.equal(w.end('a1', 'Bash', 'bash', 'x', true)?.pattern, 'failing')
})

test('an edit start alone re-arms nothing: refused edits count as failures in the run', () => {
  const w = new StuckWatch()
  for (let i = 1; i < STUCK_NUDGE_AFTER; i++) {
    assert.equal(w.start('a1', 'Edit', 'edit', 'src/a.ts'), null)
    assert.equal(w.end('a1', 'Edit', 'edit', 'src/a.ts', true), null)
  }
  w.start('a1', 'Edit', 'edit', 'src/a.ts')
  assert.deepEqual(w.end('a1', 'Edit', 'edit', 'src/a.ts', true), { pattern: 'failing', count: 5, tool: 'Edit', subject: 'src/a.ts' })
})

test('an edit that goes ahead re-arms failing and starts the count again', () => {
  const w = new StuckWatch()
  for (let i = 0; i < STUCK_NUDGE_AFTER; i++) w.end('a1', 'Bash', 'bash', 'x', true)
  w.start('a1', 'Edit', 'edit', 'src/a.ts')
  w.end('a1', 'Edit', 'edit', 'src/a.ts', false)
  for (let i = 1; i < STUCK_NUDGE_AFTER; i++) assert.equal(w.end('a1', 'Bash', 'bash', 'x', true), null)
  assert.equal(w.end('a1', 'Bash', 'bash', 'x', true)?.count, 5)
})

test('four starts of the same tool on the same subject is one repeating hit', () => {
  const w = new StuckWatch()
  for (let i = 1; i < REPEAT_NUDGE_AFTER; i++) assert.equal(w.start('a1', 'Bash', 'bash', 'npm test'), null)
  assert.deepEqual(w.start('a1', 'Bash', 'bash', 'npm test'), { pattern: 'repeating', count: 4, tool: 'Bash', subject: 'npm test' })
  assert.equal(w.start('a1', 'Bash', 'bash', 'npm test'), null)
})

test('another subject or tool, or an edit that goes ahead, breaks the run and re-arms it', () => {
  const w = new StuckWatch()
  for (let i = 0; i < 3; i++) w.start('a1', 'Read', 'read', 'a.ts')
  w.start('a1', 'Grep', 'search', 'a.ts')
  for (let i = 0; i < 3; i++) assert.equal(w.start('a1', 'Read', 'read', 'a.ts'), null)
  w.start('a1', 'Edit', 'edit', 'a.ts')
  w.end('a1', 'Edit', 'edit', 'a.ts', false)
  for (let i = 0; i < 3; i++) assert.equal(w.start('a1', 'Read', 'read', 'a.ts'), null)
  assert.equal(w.start('a1', 'Read', 'read', 'a.ts')?.pattern, 'repeating')
})

test('a refused edit does not break a repeat run', () => {
  const w = new StuckWatch()
  for (let i = 0; i < 3; i++) w.start('a1', 'Read', 'read', 'a.ts')
  w.start('a1', 'Edit', 'edit', 'a.ts')
  w.end('a1', 'Edit', 'edit', 'a.ts', true)
  assert.equal(w.start('a1', 'Read', 'read', 'a.ts')?.pattern, 'repeating')
})

test('agent and other kinds, and empty subjects, never repeat', () => {
  const w = new StuckWatch()
  for (let i = 0; i < 6; i++) {
    assert.equal(w.start('a1', 'SendMessage', 'agent', 'main'), null)
    assert.equal(w.start('a2', 'TodoWrite', 'other', ''), null)
    assert.equal(w.start('a3', 'Bash', 'bash', ''), null)
  }
})

test('agents are tracked apart, and forget drops one', () => {
  const w = new StuckWatch()
  for (let i = 0; i < 4; i++) w.end('a1', 'Bash', 'bash', 'x', true)
  assert.equal(w.end('a2', 'Bash', 'bash', 'x', true), null)
  w.forget('a1')
  assert.equal(w.end('a1', 'Bash', 'bash', 'x', true), null)
})

test('the words', () => {
  assert.equal(nudgeFor({ pattern: 'failing', count: 5, tool: 'Bash', subject: 'npm test' }),
    "Your last 5 tool calls failed. Step back and try another approach, or report to main what's blocking you.")
  assert.equal(nudgeFor({ pattern: 'repeating', count: 4, tool: 'Bash', subject: 'npm test' }),
    "You've run Bash on npm test 4 times with no change in between. Step back and try another approach, or report to main.")
  assert.equal(stuckMainText('coder-1', 'failing', true), '[OmnisSwarm] coder-1 looks stuck (failing) and was asked to step back.')
  assert.equal(stuckMainText('coder-1', 'repeating', false, 'gone'), '[OmnisSwarm] coder-1 looks stuck (repeating) and was asked to step back. The message was not delivered: gone.')
  assert.equal(stuckMainText('coder-1', 'repeating', false), '[OmnisSwarm] coder-1 looks stuck (repeating) and was asked to step back. The message was not delivered.')
})
