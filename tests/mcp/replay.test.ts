import { mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendEvent } from '../../src/core/log.ts'
import { makeEvent } from '../../src/core/events.ts'
import { parseReplayReply } from '../../src/core/replay-reply.ts'
import { createReplayTools } from '../../src/mcp/tools/replay.ts'
import { Session } from '../../src/mcp/session.ts'
import { tmpRoot } from '../helpers.ts'

const tool = (root: string) => createReplayTools({ root, session: new Session(root) })[0]!
const seed = (root: string, swarm: string, n: number) => {
  for (let i = 0; i < n; i++) {
    appendEvent(root, makeEvent({ type: 'message.sent', swarm, src: 'recorder', data: { to: 'main', summary: 'x'.repeat(150) }, now: new Date(Date.UTC(2026, 9, 22, 10, 0, i)) }))
  }
}

test('omnis_replay pages a swarm from offset 0 to done', () => {
  const root = tmpRoot()
  seed(root, 'alpha', 400)
  let since = 0
  let total = 0
  for (let page = 0; page < 20; page++) {
    const reply = parseReplayReply(tool(root).handler({ swarm: 'alpha', since }).text)
    assert.ok(reply !== null && reply.kind === 'replay')
    total += reply.events.length
    since = reply.offset
    if (reply.done) break
  }
  assert.equal(total, 400)
})

test('with no swarm named it replays the most recent log', () => {
  const root = tmpRoot()
  seed(root, 'older', 1)
  seed(root, 'newer', 1)
  const reply = parseReplayReply(tool(root).handler({ since: 0 }).text)
  assert.equal(reply?.kind === 'replay' && reply.swarm, 'newer')
})

test('an unknown swarm answers none with the recent ids', () => {
  const root = tmpRoot()
  seed(root, 'alpha', 1)
  assert.deepEqual(parseReplayReply(tool(root).handler({ swarm: 'nope', since: 0 }).text), { v: 1, kind: 'none', recent: ['alpha'] })
})

test('a bad swarm id or offset is refused', () => {
  const root = tmpRoot()
  assert.throws(() => tool(root).handler({ swarm: '../x', since: 0 }), { name: 'InputError' })
  assert.throws(() => tool(root).handler({ swarm: 'con', since: 0 }), { name: 'InputError' })
  assert.throws(() => tool(root).handler({ since: -1 }), { name: 'InputError' })
})

test('parseReplayReply refuses events from another swarm and non-replies', () => {
  assert.equal(parseReplayReply('nope'), null)
  assert.equal(parseReplayReply(JSON.stringify({ v: 1, kind: 'replay', swarm: 'a', offset: 1, done: true, events: [{ v: 1, ts: '2026-10-22T10:00:00.000Z', swarm: 'b', src: 'mcp', type: 'swarm.ended', data: {} }], bad: 0 })), null)
})

const logFile = (root: string, swarm: string) => join(root, '.omnis-swarm', 'swarms', `${swarm}.jsonl`)

test('a since inside a line, or past the end of the file, restarts at 0', () => {
  const root = tmpRoot()
  seed(root, 'alpha', 3)
  for (const since of [5, statSync(logFile(root, 'alpha')).size + 100]) {
    const reply = parseReplayReply(tool(root).handler({ swarm: 'alpha', since }).text)
    assert.deepEqual(reply, { v: 1, kind: 'replay', swarm: 'alpha', offset: 0, done: false, events: [], bad: 0 })
  }
})

test('a log of only bad lines finishes with no events', () => {
  const root = tmpRoot()
  seed(root, 'alpha', 1)
  writeFileSync(logFile(root, 'junk'), 'not json\nalso not\n')
  const reply = parseReplayReply(tool(root).handler({ swarm: 'junk', since: 0 }).text)
  assert.ok(reply !== null && reply.kind === 'replay')
  assert.equal(reply.events.length, 0)
  assert.equal(reply.done, true)
  assert.equal(reply.bad, 2)
})

test('a directory named like a log answers none', () => {
  const root = tmpRoot()
  seed(root, 'alpha', 1)
  mkdirSync(logFile(root, 'dir'))
  const reply = parseReplayReply(tool(root).handler({ swarm: 'dir', since: 0 }).text)
  assert.equal(reply?.kind, 'none')
})

test('a symlinked log answers none', t => {
  const root = tmpRoot()
  seed(root, 'alpha', 1)
  try {
    symlinkSync(logFile(root, 'alpha'), logFile(root, 'link'))
  } catch {
    t.skip('this machine cannot create symlinks')
    return
  }
  assert.equal(parseReplayReply(tool(root).handler({ swarm: 'link', since: 0 }).text)?.kind, 'none')
})

test('a replay payload never carries an agent.tool error', () => {
  const root = tmpRoot()
  const now = new Date(Date.UTC(2026, 9, 22, 10, 0, 0))
  const tool_ = { phase: 'end' as const, tool: 'Bash', kind: 'bash' as const, subject: 'npm test', isError: true }
  appendEvent(root, makeEvent({ type: 'agent.tool', swarm: 'alpha', src: 'recorder', agent: 'a1', data: { ...tool_, error: 'secret reason text' }, now }))
  appendEvent(root, makeEvent({ type: 'agent.tool', swarm: 'alpha', src: 'recorder', agent: 'a1', data: { ...tool_, phase: 'start', isError: false }, now: new Date(now.getTime() + 1000) }))
  const text = tool(root).handler({ swarm: 'alpha', since: 0 }).text as string
  assert.doesNotMatch(text, /secret reason text|"error"/)
  const reply = parseReplayReply(text)
  assert.ok(reply !== null && reply.kind === 'replay')
  assert.equal(reply.events.length, 2)
  assert.equal((reply.events[0]!.data as { isError: boolean }).isError, true)
})
