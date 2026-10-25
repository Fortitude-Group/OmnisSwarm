import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldAll, LEAD } from '../../src/core/fold.ts'
import { pointerText, reportMarkdown, reportSummary } from '../../src/core/report.ts'
import type { SwarmEvent, ToolKind } from '../../src/core/events.ts'
import { at, ev } from '../helpers.ts'

const tool = (id: string, kind: ToolKind, subject: string, atSec: number) => ev('agent.tool', { phase: 'start', tool: kind === 'edit' ? 'Edit' : 'Bash', kind, subject, isError: false }, { agent: id, atSec })
const usage = (id: string, output: number, atSec: number, requested?: string, model = 'claude-opus-5-5') =>
  ev('agent.usage', { model, input: 0, output, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...(requested !== undefined && { requested }) }, { agent: id, atSec })

function busy(): SwarmEvent[] {
  return [
    ev('swarm.started', { name: 'auth refactor', topology: 'hierarchical', implicit: false }, { atSec: 0 }),
    usage(LEAD, 10_000, 1),
    ev('agent.started', { name: 'coder-1', role: 'coder', description: '', parent: LEAD }, { agent: 'a1', atSec: 60 }),
    ev('agent.started', { name: 'coder-2', role: 'coder', description: '', parent: LEAD }, { agent: 'a2', atSec: 60 }),
    usage('a1', 50_000, 120, 'claude-opus-5-5', 'claude-sonnet-5-5'),
    usage('a2', 100_000, 130),
    tool('a1', 'edit', 'src/a.ts', 200), tool('a1', 'edit', 'src/b.ts', 210), tool('a2', 'edit', 'src/a.ts', 220),
    ev('clash.blocked', { path: 'src/a.ts', holder: 'a1', mode: 'block' }, { agent: 'a2', atSec: 220 }),
    ev('agent.stuck', { pattern: 'repeating', count: 4, subject: 'npm test', delivered: true }, { agent: 'a2', atSec: 300 }),
    ev('guard.warned', { limit: 'time', value: 20.1, threshold: 20 }, { agent: 'a2', atSec: 1260 }),
    ev('agent.finished', { outcome: 'answer' }, { agent: 'a1', atSec: 600 }),
    ev('agent.finished', { outcome: 'failed', reason: 'refusal' }, { agent: 'a2', atSec: 1320 }),
    ev('task.created', { id: 't1', title: 'Split the token module' }, { atSec: 70 }),
    ev('task.created', { id: 't2', title: 'Fix the flaky login test' }, { atSec: 71 }),
    ev('task.updated', { id: 't1', state: 'done' }, { atSec: 600 }),
    ev('task.updated', { id: 't2', state: 'failed' }, { atSec: 1320 }),
    ev('swarm.ended', { outcome: 'done' }, { atSec: 1380 }),
  ]
}

test('the report of a busy swarm', () => {
  const s = foldAll('auth-refactor', busy())
  // at(0) is the helpers' epoch; the expected times below are that epoch in UTC+60.
  const md = reportMarkdown(s, at(1400), 60)
  assert.equal(md, EXPECTED_BUSY)
})

test('a quiet swarm leaves out Problems, Routing and Tasks and says it is still running', () => {
  const s = foldAll('s1', [
    ev('swarm.started', { name: 's1', topology: 'mesh', implicit: true }, { atSec: 0 }),
    ev('agent.started', { name: 'tester', role: 'tester', description: '', parent: LEAD }, { agent: 'a1', atSec: 10 }),
  ])
  const md = reportMarkdown(s, at(130), 0)
  assert.match(md, /still running/)
  assert.doesNotMatch(md, /## Problems|## Routing|## Tasks/)
  assert.match(md, /\| tester \| tester \| running \| 2 min \|/)
})

test('a name or path with a pipe cannot break the table', () => {
  const s = foldAll('s1', [
    ev('agent.started', { name: 'a|b', role: 'coder', description: '', parent: LEAD }, { agent: 'a1', atSec: 0 }),
    tool('a1', 'edit', 'x|y.ts', 1),
  ])
  assert.ok(reportMarkdown(s, at(60), 0).split('\n').includes(String.raw`| a\|b | coder | running | 1 min | ≈$0.00 | 0 | x\|y.ts |`))
})

test('markdown in model-influenced strings is escaped, so nothing renders as an image or link', () => {
  const s = foldAll('![sw](http://h/?s)', [
    ev('agent.started', { name: '![x](http://h/?a)', role: 'coder', description: '', parent: LEAD }, { agent: 'a1', atSec: 0 }),
    ev('agent.stuck', { pattern: 'repeating', count: 4, subject: '<img src=x>', delivered: true }, { agent: 'a1', atSec: 5 }),
    ev('agent.finished', { outcome: 'failed', reason: '*bold* `code` [l](u)' }, { agent: 'a1', atSec: 9 }),
    ev('task.created', { id: 't1', title: '<b>x_y_</b>' }, { atSec: 1 }),
    ev('task.updated', { id: 't1', state: 'failed' }, { atSec: 2 }),
  ])
  const md = reportMarkdown(s, at(60), 0)
  assert.ok(md.startsWith(String.raw`# Swarm report: \!\[sw\](http://h/?s)` + '\n'))
  assert.ok(md.includes(String.raw`| \!\[x\](http://h/?a) |`))
  assert.ok(md.includes(String.raw`(last: repeating, \<img src=x\>)`))
  assert.ok(md.includes(String.raw`failed: \*bold\* \`code\` \[l\](u).`))
  assert.ok(md.includes(String.raw`- Failed: t1 \<b\>x\_y\_\</b\>`))
  assert.doesNotMatch(md, /(^|[^\\])!\[/m)
  assert.doesNotMatch(md, /(^|[^\\])</m)
})

test('an unfinished agent stops running at the end of an ended swarm', () => {
  const s = foldAll('s1', [
    ev('swarm.started', { name: 's1', topology: 'mesh', implicit: false }, { atSec: 0 }),
    ev('agent.started', { name: 'tester', role: 'tester', description: '', parent: LEAD }, { agent: 'a1', atSec: 0 }),
    ev('swarm.ended', { outcome: 'done' }, { atSec: 600 }),
  ])
  assert.match(reportMarkdown(s, at(6000), 0), /\| tester \| tester \| running \| 10 min \|/)
})

test('six files show five and +1 more', () => {
  const events: SwarmEvent[] = [ev('agent.started', { name: 'c', role: 'coder', description: '', parent: LEAD }, { agent: 'a1', atSec: 0 })]
  for (let i = 1; i <= 6; i++) events.push(tool('a1', 'edit', `f${i}.ts`, i))
  assert.match(reportMarkdown(foldAll('s1', events), at(60), 0), /f1\.ts, f2\.ts, f3\.ts, f4\.ts, f5\.ts, \+1 more \|/)
})

test('the summary and the pointer line', () => {
  const s = foldAll('auth-refactor', busy())
  const sum = reportSummary(s, at(1400))
  assert.deepEqual(sum, { agents: 2, minutes: 23, costUsd: Math.round(s.agents[LEAD]!.costUsd * 100 + s.agents.a1!.costUsd * 100 + s.agents.a2!.costUsd * 100) / 100 })
  assert.equal(pointerText('.omnis-swarm/reports/x.md', { agents: 2, minutes: 23, costUsd: 4.5 }), 'Swarm report: .omnis-swarm/reports/x.md · 2 agents · 23 min · ≈$4.50.')
  assert.equal(pointerText('r.md', { agents: 1, minutes: 0, costUsd: 0 }), 'Swarm report: r.md · 1 agent · 0 min · ≈$0.00.')
})

test('the clash line keeps (blocked) when the holder edits again after the refusal', () => {
  const md = reportMarkdown(foldAll('auth-refactor', [...busy(), tool('a1', 'edit', 'src/a.ts', 230)]), at(1400), 60)
  assert.ok(md.includes('- Clash on src/a.ts: coder-1, coder-2 (blocked).'))
})

const EXPECTED_BUSY = `# Swarm report: auth refactor

hierarchical · started 2026-10-21 11:00 · ended 2026-10-21 11:23 · 23 min · ≈$2.70 · 2 agents

| Agent | Role | Outcome | Time | Cost | Tokens | Files edited |
|---|---|---|---|---|---|---|
| main | lead | – | 23 min | ≈$0.20 | 10,000 | – |
| coder-1 | coder | done | 9 min | ≈$0.50 | 50,000 | src/a.ts, src/b.ts |
| coder-2 | coder | failed | 21 min | ≈$2.00 | 100,000 | – |

## Problems

- coder-2 passed its 20 min time-box warning.
- Clash on src/a.ts: coder-1, coder-2 (blocked).
- coder-2 looked stuck 1 time and was asked to step back (last: repeating, npm test).
- coder-2 failed: refusal.

## Routing

- coder-1: asked for claude-opus-5-5, answered by claude-sonnet-5-5, saved ≈$0.50.
- Total saved: ≈$0.50.

## Tasks

0 pending, 0 active, 1 done, 1 failed.
- Failed: t2 Fix the flaky login test
`

const gate = (task: string, result: string, atSec: number) => ev('gate.ran', { task, result, ms: 1000, mode: 'block' } as never, { atSec })
const gateSwarm = (...extra: SwarmEvent[]) => foldAll('g', [
  ev('swarm.started', { name: 'g', topology: 'mesh', implicit: false }, { atSec: 0 }),
  ev('agent.started', { name: 'coder|1', role: 'coder', description: '', parent: LEAD }, { agent: 'a1', atSec: 1 }),
  ev('task.created', { id: 't1', title: 'One' }, { atSec: 2 }),
  ev('task.created', { id: 't2', title: 'Two' }, { atSec: 2 }),
  ev('task.created', { id: 't3', title: 'Three' }, { atSec: 2 }),
  ...extra,
])

test('Gates lists each task that ran a gate, results in order, after Tasks', () => {
  const md = reportMarkdown(gateSwarm(gate('t1', 'failed', 5), gate('t1', 'passed', 6), gate('t2', 'skipped', 7), gate('t2', 'none', 8)), at(60), 0)
  assert.match(md, /## Tasks[\s\S]*## Gates\n\n- t1 ✕ failed then ✓\n- t2 skipped then no gate\n/)
  assert.doesNotMatch(md, /- t3/)
})

test('Gates is left out when no task ran a gate', () => {
  assert.doesNotMatch(reportMarkdown(gateSwarm(), at(60), 0), /## Gates/)
})

test('Problems names failed, timed out, errored and skipped latest gates only', () => {
  const md = reportMarkdown(gateSwarm(gate('t1', 'failed', 5), gate('t1', 'passed', 6), gate('t2', 'timeout', 7), gate('t3', 'error', 8), gate('t3', 'skipped', 9)), at(60), 0)
  assert.doesNotMatch(md, /Gate failed for t1/)
  assert.match(md, /- Gate failed for t2 \(timed out\)\./)
  assert.match(md, /- Gate skipped for t3\./)
  const e = reportMarkdown(gateSwarm(gate('t3', 'error', 8), gate('t1', 'failed', 9)), at(60), 0)
  assert.match(e, /- Gate failed for t3 \(could not start\)\./)
  assert.match(e, /- Gate failed for t1 \(failed\)\./)
})

test('Problems counts fenced edits per agent and escapes the name', () => {
  const one = reportMarkdown(gateSwarm(ev('fence.blocked', { path: 'x.ts', tasks: ['t1'], mode: 'block' }, { agent: 'a1', atSec: 5 })), at(60), 0)
  assert.match(one, /- coder\\|1 was fenced out of 1 edit\./)
  const two = reportMarkdown(gateSwarm(ev('fence.blocked', { path: 'x.ts', tasks: ['t1'], mode: 'block' }, { agent: 'a1', atSec: 5 }), ev('fence.blocked', { path: 'y.ts', tasks: ['t1'], mode: 'warn' }, { agent: 'a1', atSec: 90 })), at(120), 0)
  assert.match(two, /was fenced out of 2 edits\./)
})

test('reportMarkdown adds a Hints section only when it is given lines, escaped like the rest', () => {
  const s = foldAll('s1', [ev('swarm.started', { name: 's1', topology: 'hierarchical', implicit: false }, { src: 'mcp' })])
  assert.equal(reportMarkdown(s, at(60), 0).includes('## Hints'), false)
  assert.match(reportMarkdown(s, at(60), 0, ["dev_x: Sonnet finished clean 5 of 5 (≈$0.10 avg) vs Opus 5 of 5 (≈$1.00). Try model: 'sonnet'."]),
    /\n## Hints\n\n- dev\\_x: Sonnet finished clean 5 of 5 /)
})
