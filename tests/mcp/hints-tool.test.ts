import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendEvent } from '../../src/core/log.ts'
import { sessionKey } from '../../src/core/swarm.ts'
import { projectKey } from '../../src/mcp/history-store.ts'
import { Session } from '../../src/mcp/session.ts'
import { createRecordTools } from '../../src/mcp/tools/record.ts'
import { createHintsTools } from '../../src/mcp/tools/hints.ts'
import { createReportTools } from '../../src/mcp/tools/report.ts'
import { createTools } from '../../src/mcp/tools.ts'
import { ev, tmpRoot } from '../helpers.ts'
import { syncResult } from './sync.ts'

const NOW = new Date('2026-10-25T10:05:00.000Z')
const ON = { mode: 'on' as const, machineDir: null }
function setup(hints?: typeof ON | { mode: 'off'; machineDir: null }) {
  const root = tmpRoot()
  const session = new Session(root)
  const ctx = { root, session, now: () => NOW, ...(hints !== undefined && { hints }) }
  const tools = [...createTools(ctx), ...createReportTools(ctx), ...createHintsTools(ctx)]
  const tool = (name: string, args: Record<string, unknown> = {}) => syncResult(tools.find(t => t.name === name)!.handler(args))
  return { root, tool }
}
const stored = (root: string, id: string) => createHash('sha256').update(`${projectKey(root)}\u0000${id}`).digest('hex').slice(0, 16)
const finishedWriter = (swarm: string) => [
  ev('agent.started', { name: 'w', role: 'omnis-writer', description: '', parent: 'lead' }, { swarm, agent: 'w', atSec: 1 }),
  ev('agent.usage', { model: 'claude-haiku-5-5', input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, { swarm, agent: 'w', atSec: 2 }),
  ev('agent.finished', { outcome: 'answer' }, { swarm, agent: 'w', atSec: 3 }),
]
function pastRuns(root: string) {
  for (let i = 0; i < 10; i++) {
    const id = `old${i}`, agent = `a${i}`, model = i < 5 ? 'claude-sonnet-5-5' : 'claude-opus-5-5'
    appendEvent(root, ev('swarm.started', { name: id, topology: 'hierarchical', implicit: false }, { swarm: id, src: 'mcp' }))
    appendEvent(root, ev('agent.started', { name: agent, role: 'omnis-developer', description: '', parent: 'lead' }, { swarm: id, agent, atSec: 1 }))
    appendEvent(root, ev('agent.usage', { model, input: 10, output: 10, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, { swarm: id, agent, atSec: 2 }))
    appendEvent(root, ev('agent.finished', { outcome: 'answer' }, { swarm: id, agent, atSec: 60 }))
  }
}

test('omnis_swarm_init carries the hint block when hints are on and there is evidence', () => {
  const { root, tool } = setup(ON)
  pastRuns(root)
  const text = tool('omnis_swarm_init', { name: 'next', topology: 'hierarchical' }).text
  assert.match(text, /^Swarm "next" started as next \(hierarchical\)\.\n\nModel hints from past runs:\n- omnis-developer: Sonnet/)
})

test('omnis_swarm_init is unchanged without evidence, with hints off, or with no hints option', () => {
  for (const hints of [ON, { mode: 'off' as const, machineDir: null }, undefined]) {
    const { root, tool } = setup(hints)
    if (hints !== ON) pastRuns(root)
    assert.equal(tool('omnis_swarm_init', { name: 'next', topology: 'hierarchical' }).text, 'Swarm "next" started as next (hierarchical).')
  }
})

test('a written report records the run and carries a Hints section', () => {
  const { root, tool } = setup(ON)
  pastRuns(root)
  tool('omnis_swarm_init', { name: 'cur', topology: 'hierarchical' })
  appendEvent(root, ev('agent.started', { name: 'w', role: 'omnis-writer', description: '', parent: 'lead' }, { swarm: 'cur', agent: 'w', atSec: 1 }))
  appendEvent(root, ev('agent.usage', { model: 'claude-haiku-5-5', input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, { swarm: 'cur', agent: 'w', atSec: 2 }))
  appendEvent(root, ev('agent.finished', { outcome: 'answer' }, { swarm: 'cur', agent: 'w', atSec: 3 }))
  const pointer = tool('omnis_swarm_end', {}).text
  const path = pointer.match(/(\.omnis-swarm\/reports\/[^ ]+\.md)/)![1]!
  assert.match(readFileSync(join(root, path), 'utf8'), /\n## Hints\n\n- omnis-developer: Sonnet/)
  assert.ok(readFileSync(join(root, '.omnis-swarm', 'history.jsonl'), 'utf8').includes(`"id":"${stored(root, 'cur/w')}"`))
})

test('omnis_hints answers the table, or says hints are off', () => {
  const on = setup(ON)
  pastRuns(on.root)
  assert.match(on.tool('omnis_hints').text, /^Model history \(/)
  assert.equal(setup({ mode: 'off', machineDir: null }).tool('omnis_hints').text, 'Model hints are off (the modelHints setting).')
})

test('omnis_swarm_init replacing a running swarm records that swarm\'s rows', () => {
  const { root, tool } = setup(ON)
  tool('omnis_swarm_init', { name: 'first', topology: 'hierarchical' })
  for (const e of finishedWriter('first')) appendEvent(root, e)
  tool('omnis_swarm_init', { name: 'second', topology: 'hierarchical' })
  assert.ok(readFileSync(join(root, '.omnis-swarm', 'history.jsonl'), 'utf8').includes(stored(root, 'first/w')))
})

test('omnis_swarm_init naming the session swarm leaves it out of the backfill, so its rows reach the machine store too', () => {
  const root = tmpRoot()
  const machine = tmpRoot()
  const session = new Session(root)
  const clock = () => new Date('2026-10-21T10:00:05.000Z')
  const [record] = createRecordTools({ root, session, now: clock })
  const tools = createTools({ root, session, now: clock, hints: { mode: 'on' as const, machineDir: machine } })
  const tool = (name: string, args: Record<string, unknown> = {}) => syncResult(tools.find(t => t.name === name)!.handler(args))
  const sessionId = 'abcdef12-3456-7890-abcd-ef1234567890'
  const swarm = `session-${sessionKey(sessionId).slice(0, 8)}`
  for (const e of finishedWriter(swarm)) record!.handler({ sessionId, ts: '2026-10-21T10:00:01.234Z', type: e.type, agent: e.agent, data: e.data })
  assert.match(tool('omnis_swarm_init', { name: 'named', topology: 'hierarchical' }).text, /now names the running session swarm/)
  tool('omnis_swarm_end', {})
  assert.ok(readFileSync(join(machine, 'history.jsonl'), 'utf8').includes(stored(root, `${swarm}/w`)))
})
