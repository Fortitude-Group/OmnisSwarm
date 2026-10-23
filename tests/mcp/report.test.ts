import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendEvent, readEvents, swarmLogPath } from '../../src/core/log.ts'
import { Session } from '../../src/mcp/session.ts'
import { createReportTools } from '../../src/mcp/tools/report.ts'
import { createTools } from '../../src/mcp/tools.ts'
import { InputError } from '../../src/mcp/validate.ts'
import { ev, tmpRoot } from '../helpers.ts'

const NOW = new Date('2026-10-23T10:05:00.000Z')
const setup = () => {
  const root = tmpRoot()
  const session = new Session(root)
  const ctx = { root, session, now: () => NOW }
  const [report] = createReportTools(ctx)
  const tools = createTools(ctx)
  const tool = (name: string, args: Record<string, unknown> = {}) => tools.find(t => t.name === name)!.handler(args)
  return { root, session, report: report!, tool }
}
const reports = (root: string) => readdirSync(join(root, '.omnis-swarm', 'reports')).sort()

test('omnis_report writes the running swarm\'s report, records report.written and answers the pointer', () => {
  const { root, report, tool } = setup()
  tool('omnis_swarm_init', { name: 'auth', topology: 'hierarchical' })
  appendEvent(root, ev('agent.started', { name: 'coder-1', role: 'coder', description: '', parent: 'lead' }, { agent: 'a1', swarm: 'auth', atSec: 1 }))
  const reply = report.handler({}).text
  const [name] = reports(root)
  assert.match(name!, /^auth-\d{8}-\d{4}\.md$/)
  assert.equal(reply, `Swarm report: .omnis-swarm/reports/${name} · 1 agent · ${reply.match(/· (\d+) min/)![1]} min · ≈$0.00.`)
  assert.match(readFileSync(join(root, '.omnis-swarm', 'reports', name!), 'utf8'), /^# Swarm report: auth\n/)
  const last = readEvents(swarmLogPath(root, 'auth')).events.at(-1)!
  assert.equal(last.type, 'report.written')
  assert.deepEqual(last.data, { path: `.omnis-swarm/reports/${name}`, agents: 1, minutes: (last.data as { minutes: number }).minutes, costUsd: 0 })
})

test('a second report in the same minute gets -2, and a named swarm can be reported', () => {
  const { root, report, tool } = setup()
  tool('omnis_swarm_init', { name: 'auth', topology: 'mesh' })
  report.handler({})
  report.handler({ swarm: 'auth' })
  assert.deepEqual(reports(root).map(n => n.replace(/\d{8}-\d{4}/, 'STAMP')), ['auth-STAMP-2.md', 'auth-STAMP.md'])
})

test('no swarm, a bad id or an unknown swarm is a plain error', () => {
  const { report } = setup()
  assert.throws(() => report.handler({}), InputError)
  assert.throws(() => report.handler({ swarm: '../x' }), InputError)
  assert.throws(() => report.handler({ swarm: 'nope' }), InputError)
})

test('omnis_swarm_end writes a report and names it, but not twice for an unchanged swarm', () => {
  const { root, report, tool } = setup()
  tool('omnis_swarm_init', { name: 'auth', topology: 'mesh' })
  appendEvent(root, ev('agent.started', { name: 'coder-1', role: 'coder', description: '', parent: 'lead' }, { agent: 'a1', swarm: 'auth', atSec: 1 }))
  report.handler({})
  const reply = tool('omnis_swarm_end', { outcome: 'done' }).text
  assert.equal(reply, 'Swarm auth ended.')
  assert.equal(reports(root).length, 1)
})

test('omnis_swarm_end with new work since the last report writes one and puts the pointer in its reply', () => {
  const { root, tool } = setup()
  tool('omnis_swarm_init', { name: 'auth', topology: 'mesh' })
  appendEvent(root, ev('agent.started', { name: 'coder-1', role: 'coder', description: '', parent: 'lead' }, { agent: 'a1', swarm: 'auth', atSec: 1 }))
  const reply = tool('omnis_swarm_end', {}).text
  assert.match(reply, /^Swarm auth ended\. Swarm report: \.omnis-swarm\/reports\/auth-\d{8}-\d{4}\.md · 1 agent · \d+ min · ≈\$0\.00\.$/)
  assert.ok(existsSync(join(root, '.omnis-swarm', 'reports')))
})
