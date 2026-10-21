import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { appendEvent, swarmLogPath, writeCurrent } from '../../src/core/log.ts'
import { FEED_REPLY_MAX, parseFeedReply, type FeedReply } from '../../src/core/feed-reply.ts'
import { loadState } from '../../src/core/snapshot.ts'
import { Session } from '../../src/mcp/session.ts'
import { createFeedTools } from '../../src/mcp/tools/feed.ts'
import { createTools } from '../../src/mcp/tools.ts'
import { InputError } from '../../src/mcp/validate.ts'
import { ev, tmpRoot } from '../helpers.ts'

const NOW = new Date('2026-10-21T10:00:00.000Z')

function setup(makeSession?: (root: string) => Session) {
  const root = tmpRoot()
  const session = makeSession === undefined ? new Session(root) : makeSession(root)
  const feed = createFeedTools({ root, session, now: () => NOW })[0]!
  const tools = createTools({ root, session, now: () => NOW })
  const call = (name: string, args: Record<string, unknown> = {}) => tools.find(t => t.name === name)!.handler(args)
  const pull = (args: Record<string, unknown> = {}): FeedReply => {
    const reply = parseFeedReply(feed.handler(args).text)
    assert.ok(reply !== null, 'the reply parses')
    return reply
  }
  const started = (sec: number, agent: string) =>
    ev('agent.started', { name: agent, role: 'coder', description: '', parent: 'lead' }, { swarm: 'feed', agent, atSec: sec })
  return { root, feed, call, pull, started }
}

test('one omnis_feed tool, marked internal, with an object schema', () => {
  const { feed } = setup()
  assert.equal(feed.name, 'omnis_feed')
  assert.equal(feed.inputSchema.type, 'object')
  assert.match(feed.description, /Internal/)
})

test('with no swarm the feed answers none', () => {
  const { pull } = setup()
  assert.deepEqual(pull(), { v: 1, kind: 'none' })
})

test('since 0 answers the folded state and the offset it reflects', () => {
  const { root, call, pull } = setup()
  call('omnis_swarm_init', { name: 'Feed', topology: 'mesh' })
  const r = pull()
  assert.ok(r.kind === 'state')
  assert.equal(r.swarm, 'feed')
  assert.equal(r.state.swarm.topology, 'mesh')
  assert.equal(r.offset, statSync(swarmLogPath(root, 'feed')).size)
})

test('the offset it gave answers no events', () => {
  const { call, pull } = setup()
  call('omnis_swarm_init', { name: 'Feed', topology: 'mesh' })
  const first = pull()
  assert.ok(first.kind === 'state')
  assert.deepEqual(pull({ since: first.offset, swarm: 'feed' }), { v: 1, kind: 'events', swarm: 'feed', offset: first.offset, events: [], bad: 0 })
})

test('events appended after the offset come back sorted, with the new offset', () => {
  const { root, call, pull, started } = setup()
  call('omnis_swarm_init', { name: 'Feed', topology: 'mesh' })
  const first = pull()
  assert.ok(first.kind === 'state')
  appendEvent(root, started(5, 'late'))
  appendEvent(root, started(3, 'early'))
  const r = pull({ since: first.offset, swarm: 'feed' })
  assert.ok(r.kind === 'events')
  assert.deepEqual(r.events.map(e => e.agent), ['early', 'late'])
  assert.equal(r.offset, statSync(swarmLogPath(root, 'feed')).size)
})

test('a missing or different swarm hint answers a fresh state', () => {
  const { call, pull } = setup()
  call('omnis_swarm_init', { name: 'Feed', topology: 'mesh' })
  const first = pull()
  assert.ok(first.kind === 'state')
  assert.equal(pull({ since: first.offset }).kind, 'state')
  assert.equal(pull({ since: first.offset, swarm: 'other' }).kind, 'state')
})

test('an offset past the end answers a fresh state', () => {
  const { call, pull } = setup()
  call('omnis_swarm_init', { name: 'Feed', topology: 'mesh' })
  assert.equal(pull({ since: 1_000_000, swarm: 'feed' }).kind, 'state')
})

test('more than 500 waiting events answers a fresh state', () => {
  const { root, call, pull, started } = setup()
  call('omnis_swarm_init', { name: 'Feed', topology: 'mesh' })
  const first = pull()
  assert.ok(first.kind === 'state')
  for (let i = 0; i < 501; i++) appendEvent(root, started(1 + i / 1000, `a${i}`))
  const r = pull({ since: first.offset, swarm: 'feed' })
  // 501 agents cannot fit in one reply even trimmed, so the fresh answer is the too-large notice.
  assert.ok(r.kind === 'too-large')
  assert.ok(r.agents >= 501)
})

test('a replaced, shorter log answers a fresh state', () => {
  const { root, call, pull, started } = setup()
  call('omnis_swarm_init', { name: 'Feed', topology: 'mesh' })
  for (let i = 0; i < 5; i++) appendEvent(root, started(1 + i, `a${i}`))
  const first = pull()
  assert.ok(first.kind === 'state')
  const file = swarmLogPath(root, 'feed')
  writeFileSync(file, `${readFileSync(file, 'utf8').split('\n')[0]}\n`)
  assert.equal(pull({ since: first.offset, swarm: 'feed' }).kind, 'state')
})

test('an ended swarm stays readable by its hint', () => {
  const { call, pull } = setup()
  call('omnis_swarm_init', { name: 'Feed', topology: 'mesh' })
  call('omnis_swarm_end', { outcome: 'done' })
  assert.deepEqual(pull(), { v: 1, kind: 'none' })
  const r = pull({ swarm: 'feed' })
  assert.ok(r.kind === 'state')
  assert.notEqual(r.state.swarm.endedAt, null)
})

test('bad input is refused with an InputError', () => {
  const { feed } = setup()
  for (const args of [{ since: -1 }, { since: 1.5 }, { since: '3' }, { swarm: 'Bad!' }, { swarm: 'nul' }, { swarm: 'x'.repeat(65) }]) {
    assert.throws(() => feed.handler(args), InputError, JSON.stringify(args))
  }
})

test('a failure inside answers a fixed message that names no path', () => {
  const { root, feed } = setup(r => new Session(r, () => { throw new Error('C:\\secret\\path') }))
  writeCurrent(root, 'x')
  assert.throws(() => feed.handler({}), (err: unknown) =>
    err instanceof Error && !(err instanceof InputError) && /Could not read the swarm files/.test(err.message) && !/secret/.test(err.message))
})

test('an offset in the middle of a line answers a fresh state', () => {
  const { root, call, pull, started } = setup()
  call('omnis_swarm_init', { name: 'Feed', topology: 'mesh' })
  for (let i = 0; i < 3; i++) appendEvent(root, started(1 + i, `a${i}`))
  assert.equal(pull({ since: 1, swarm: 'feed' }).kind, 'state')
})

test('hinting at several old swarms keeps at most one of them held', () => {
  const loads: string[] = []
  const { root, pull } = setup(r => new Session(r, (rt, id) => { loads.push(id); return loadState(rt, id) }))
  for (const id of ['old1', 'old2', 'old3']) appendEvent(root, ev('agent.started', { name: 'a', role: 'r', description: '', parent: 'lead' }, { swarm: id, agent: 'a' }))
  for (const id of ['old1', 'old2', 'old3', 'old3']) assert.equal(pull({ swarm: id }).kind, 'state')
  assert.deepEqual(loads, ['old1', 'old2', 'old3'])
  pull({ swarm: 'old1' })
  assert.deepEqual(loads, ['old1', 'old2', 'old3', 'old1'])
})

test('a backlog too big for one reply is paged: every event once, in order, until the end', () => {
  const { root, feed, call, pull } = setup()
  call('omnis_swarm_init', { name: 'Feed', topology: 'mesh' })
  const first = pull()
  assert.ok(first.kind === 'state')
  // About 400 characters an event, 300 events: far past FEED_REPLY_MAX in one reply.
  for (let i = 0; i < 300; i++) {
    appendEvent(root, ev('agent.started', { name: `n${i}`, role: 'coder', description: 'd'.repeat(110), parent: 'lead' }, { swarm: 'feed', agent: `a${i}`, atSec: 1 + i / 100 }))
  }
  const seen: string[] = []
  let offset = first.offset
  let pages = 0
  const end = statSync(swarmLogPath(root, 'feed')).size
  while (offset < end) {
    const text = feed.handler({ since: offset, swarm: 'feed' }).text
    assert.ok(text.length <= FEED_REPLY_MAX, `${text.length}`)
    const r = parseFeedReply(text)
    assert.ok(r !== null && r.kind === 'events')
    assert.ok(r.events.length > 0 && r.offset > offset)
    seen.push(...r.events.map(e => e.agent ?? ''))
    offset = r.offset
    pages++
  }
  assert.ok(pages > 1)
  assert.equal(offset, end)
  assert.deepEqual(seen, Array.from({ length: 300 }, (_, i) => `a${i}`))
})

test('a fresh state too big for one reply is trimmed under the cap', () => {
  const { root, call, feed } = setup()
  call('omnis_swarm_init', { name: 'Feed', topology: 'mesh' })
  for (let i = 0; i < 30; i++) {
    appendEvent(root, ev('agent.started', { name: `n${i}`, role: 'coder', description: 'd', parent: 'lead' }, { swarm: 'feed', agent: `a${i}`, atSec: 1 + i }))
    for (let f = 0; f < 120; f++) {
      appendEvent(root, ev('agent.tool', { phase: 'start', tool: 'Read', kind: 'read', subject: `src/area${i}/module-number-${f}.ts`, isError: false }, { swarm: 'feed', agent: `a${i}`, atSec: 1 + i + f / 1000 }))
    }
  }
  const text = feed.handler({}).text
  assert.ok(text.length <= FEED_REPLY_MAX, `${text.length}`)
  const r = parseFeedReply(text)
  assert.ok(r !== null && r.kind === 'state' && r.trimmed === true)
})
