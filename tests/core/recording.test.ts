import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EVENT_TYPES } from '../../src/core/events.ts'
import {
  FENCE_TOOL, INTERNAL_TOOL, MAX_IN_FLIGHT, RECORDER_TYPES, RECORD_TOOL, SERVER_KEY, SESSION_ID, guardVerdict,
} from '../../src/core/recording.ts'

const RECORD = 'mcp__plugin_omnis-swarm_omnis-swarm__omnis_record'
const FEED = 'mcp__plugin_omnis-swarm_omnis-swarm__omnis_feed'

test('recorder types are log event types, and never the server-only ones', () => {
  for (const t of RECORDER_TYPES) assert.ok((EVENT_TYPES as readonly string[]).includes(t), t)
  for (const t of ['swarm.started', 'swarm.ended', 'memory.put', 'task.created', 'task.updated']) {
    assert.equal((RECORDER_TYPES as readonly string[]).includes(t), false, t)
  }
})

test('fence.blocked comes from the mod, gate.ran from the server', () => {
  assert.ok((RECORDER_TYPES as readonly string[]).includes('fence.blocked'))
  assert.equal((RECORDER_TYPES as readonly string[]).includes('gate.ran'), false)
})

test('names and limits', () => {
  assert.equal(RECORD_TOOL, 'omnis_record')
  assert.equal(FENCE_TOOL, 'omnis_fence')
  assert.equal(SERVER_KEY, 'omnis-swarm')
  assert.equal(MAX_IN_FLIGHT, 64)
})

test('session ids look like the transcript name Claude Code uses', () => {
  assert.ok(SESSION_ID.test('dd60181f-79e4-43c2-9346-5b2af987d4c1'))
  for (const bad of ['', 'short', '-dd60181f', 'dd60181f/../x', 'dd60181f 79e4', 'a'.repeat(65)]) {
    assert.equal(SESSION_ID.test(bad), false, bad)
  }
})

test('the internal tool pattern matches our two tools by full name and nothing public', () => {
  assert.ok(INTERNAL_TOOL.test(RECORD))
  assert.ok(INTERNAL_TOOL.test(FEED))
  assert.ok(INTERNAL_TOOL.test('mcp__omnis-swarm__omnis_record'))
  assert.ok(INTERNAL_TOOL.test('mcp__other__omnis_record'))
  for (const name of ['omnis_replay', 'omnis_export', 'omnis_fence']) {
    assert.ok(INTERNAL_TOOL.test(`mcp__plugin_omnis-swarm_omnis-swarm__${name}`), name)
    assert.ok(INTERNAL_TOOL.test(`mcp__omnis-swarm__${name}`), name)
    assert.equal(guardVerdict(`mcp__plugin_omnis-swarm_omnis-swarm__${name}`, 'engine', 'omnis-swarm'), 'deny', name)
    assert.equal(guardVerdict(`mcp__omnis-swarm__${name}`, 'omnis-swarm', 'omnis-swarm'), 'pass', name)
  }
  for (const other of ['omnis_record', 'mcp__plugin_omnis-swarm_omnis-swarm__omnis_swarm_status', 'Bash']) {
    assert.equal(INTERNAL_TOOL.test(other), false, other)
  }
})

test('the guard rule denies an internal tool to anyone but this plugin, and ignores other tools', () => {
  assert.equal(guardVerdict(RECORD, 'omnis-swarm', 'omnis-swarm'), 'pass')
  assert.equal(guardVerdict(RECORD, 'engine', 'omnis-swarm'), 'deny')
  assert.equal(guardVerdict(FEED, 'intruder', 'omnis-swarm'), 'deny')
  assert.equal(guardVerdict('Bash', 'engine', 'omnis-swarm'), 'pass')
})

test('the guard matches this plugin by name with or without an @marketplace suffix, on either side', () => {
  assert.equal(guardVerdict(RECORD, 'omnis-swarm@omnis-swarm', 'omnis-swarm'), 'pass')
  assert.equal(guardVerdict(RECORD, 'omnis-swarm', 'omnis-swarm@omnis-swarm'), 'pass')
  assert.equal(guardVerdict(FEED, 'omnis-swarm@other-market', 'omnis-swarm@omnis-swarm'), 'pass')
  // Look-alikes stay out: a longer name, our name after the @, an empty origin.
  assert.equal(guardVerdict(RECORD, 'omnis-swarm-evil', 'omnis-swarm'), 'deny')
  assert.equal(guardVerdict(RECORD, 'evil@omnis-swarm', 'omnis-swarm'), 'deny')
  assert.equal(guardVerdict(RECORD, '', 'omnis-swarm'), 'deny')
  assert.equal(guardVerdict(RECORD, 'engine', 'omnis-swarm'), 'deny')
  assert.equal(guardVerdict(RECORD, 'xomnis-swarm', 'omnis-swarm'), 'deny')
  assert.equal(guardVerdict(RECORD, '@omnis-swarm', 'omnis-swarm'), 'deny')
  assert.equal(guardVerdict(RECORD, '@x', ''), 'deny')
  assert.equal(guardVerdict(RECORD, '', ''), 'deny')
})
