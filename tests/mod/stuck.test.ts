import { test } from 'node:test'
import assert from 'node:assert/strict'
import { REPEAT_NUDGE_AFTER, STUCK_NUDGE_AFTER, STOP_TEXT, StuckWatch, handoffMainText, noOpenTaskText, nudgeFor, parseNotes, stuckMainText } from '../../src/mod/stuck.ts'

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

const fail = (w: StuckWatch, agent = 'a1') => {
  let hit = null
  for (let i = 0; i < STUCK_NUDGE_AFTER; i++) hit = w.end(agent, 'Bash', 'bash', 'npm test', true) ?? hit
  return hit
}
const reArm = (w: StuckWatch, agent = 'a1') => void w.end(agent, 'Bash', 'bash', 'ok', false)

test('the first hit in a run has no again flag; the second has, and carries the one handoff', () => {
  const w = new StuckWatch()
  const first = fail(w)
  assert.deepEqual(first, { pattern: 'failing', count: 5, tool: 'Bash', subject: 'npm test' })
  assert.equal(Object.hasOwn(first!, 'again'), false)
  reArm(w)
  assert.deepEqual(fail(w), { pattern: 'failing', count: 5, tool: 'Bash', subject: 'npm test', again: true, handoff: true })
  reArm(w)
  assert.deepEqual(fail(w), { pattern: 'failing', count: 5, tool: 'Bash', subject: 'npm test', again: true })
})

test('either pattern counts toward the second hit', () => {
  const w = new StuckWatch()
  fail(w)
  for (let i = 1; i < REPEAT_NUDGE_AFTER; i++) w.start('a1', 'Read', 'read', 'a.ts')
  const second = w.start('a1', 'Read', 'read', 'a.ts')
  assert.equal(second?.pattern, 'repeating')
  assert.equal(second?.again, true)
  assert.equal(second?.handoff, true)
})

test('forget starts the run over, and agents are counted apart', () => {
  const w = new StuckWatch()
  fail(w)
  fail(w, 'a2')
  w.forget('a1')
  reArm(w, 'a2')
  assert.equal(Object.hasOwn(fail(w)!, 'again'), false)
  assert.equal(fail(w, 'a2')?.again, true)
})

test('stillStuck names the pattern that has fired and has not re-armed', () => {
  const w = new StuckWatch()
  assert.equal(w.stillStuck('a1'), null)
  fail(w)
  assert.equal(w.stillStuck('a1'), 'failing')
  reArm(w)
  assert.equal(w.stillStuck('a1'), null)
  w.forget('a1')
  for (let i = 0; i < REPEAT_NUDGE_AFTER; i++) w.start('a1', 'Read', 'read', 'a.ts')
  assert.equal(w.stillStuck('a1'), 'repeating')
  w.start('a1', 'Edit', 'edit', 'a.ts')
  w.end('a1', 'Edit', 'edit', 'a.ts', false)
  assert.equal(w.stillStuck('a1'), null)
})

test('stillStuck is null once the stuck-again handoff was taken, and for an unknown or forgotten agent', () => {
  const w = new StuckWatch()
  fail(w)
  reArm(w)
  fail(w)
  assert.equal(w.stillStuck('a1'), null)
  w.forget('a1')
  assert.equal(w.stillStuck('a1'), null)
  assert.equal(w.stillStuck('nobody'), null)
})

test('the stop text replaces the nudge on an again hit', () => {
  assert.equal(STOP_TEXT, "You're still stuck. Stop here, and report to main what you tried and what's blocking you.")
  assert.equal(nudgeFor({ pattern: 'failing', count: 5, tool: 'Bash', subject: 'x', again: true }), STOP_TEXT)
  assert.equal(nudgeFor({ pattern: 'repeating', count: 4, tool: 'Bash', subject: 'x', again: true, handoff: true }), STOP_TEXT)
})

test('the handoff words to main', () => {
  assert.equal(handoffMainText('dev-2', ['t3'], 'failing', 'stuck'),
    '[OmnisSwarm] dev-2 is stuck on t3 (failing). Its handoff note is in memory: handoff/t3. To hand it on, stop dev-2, then give t3 a new assignee and tell it to read handoff/t3 first.')
  assert.equal(handoffMainText('dev-2', ['t3'], 'repeating', 'finished'),
    '[OmnisSwarm] dev-2 finished while stuck on t3 (repeating). Its handoff note is in memory: handoff/t3. To hand it on, stop dev-2, then give t3 a new assignee and tell it to read handoff/t3 first.')
  assert.equal(handoffMainText('dev-2', ['t3', 't5'], 'failing', 'stuck'),
    '[OmnisSwarm] dev-2 is stuck on t3, t5 (failing). Its handoff notes are in memory: handoff/t3, handoff/t5. To hand them on, stop dev-2, then give each a new assignee and tell it to read its note first.')
  assert.equal(noOpenTaskText('dev-2', 'failing'), '[OmnisSwarm] dev-2 is stuck (failing) and has no open task to hand on.')
})

test('parseNotes reads the server reply and trusts nothing else', () => {
  assert.deepEqual(parseNotes('{"notes":["handoff/t3","handoff/t12"]}'), ['t3', 't12'])
  assert.deepEqual(parseNotes('{"notes":[]}'), [])
  for (const bad of ['', 'nope', '[]', '{}', '{"notes":"handoff/t3"}', '{"notes":["x"]}', '{"notes":["handoff/t3/../x"]}', '{"notes":["handoff/t3 and more"]}', '{"notes":[3]}', '{"notes":["handoff/t3","handoff/t3","handoff/t3","handoff/t4"]}']) {
    assert.equal(parseNotes(bad), null, bad)
  }
})
