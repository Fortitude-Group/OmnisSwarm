import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { RecordBody } from '../../src/core/recording.ts'
import { Session } from '../../src/mcp/session.ts'
import { createRecordTools } from '../../src/mcp/tools/record.ts'
import {
  agentFinished, agentStarted, agentUsage, messageSent, protocolMessage, sessionMeasure, toolEvent,
} from '../../src/mod/record-events.ts'
import { tmpRoot } from '../helpers.ts'

const SID = 'abcdef12-3456-7890-abcd-ef1234567890'

test("every body the recorder builds, awkward input included, is accepted by omnis_record", () => {
  const root = tmpRoot()
  const [record] = createRecordTools({ root, session: new Session(root) })
  const nasty = `  tab\there\nnew\u0007line 😀${'z'.repeat(400)}  `
  const bodies: Array<RecordBody | null> = [
    agentStarted({ name: nasty, subagentType: nasty, description: nasty, parentAgentId: nasty }, 'a1'),
    agentStarted({}, 'a2'),
    agentFinished('refusal', 'a1'),
    agentFinished(nasty, 'a1'),
    agentUsage({ input_tokens: -1, output_tokens: 1e20, cache_read_input_tokens: 0.5, cache_creation_input_tokens: 9, model: nasty }, 'a1'),
    toolEvent('start', 'Bash', { command: nasty }, 'lead'),
    toolEvent('end', nasty, { file_path: nasty }, 'lead', true),
    toolEvent('start', 'Read', { file_path: `C:/${'deep/'.repeat(40)}x.ts` }, 'a1'),
    messageSent(nasty, nasty, 'a1'),
    protocolMessage({ to: nasty, message: { type: nasty, approve: true, reason: nasty } }, 'lead'),
    sessionMeasure({ context: { tokens: 1.5, window: 1e7, percent: 250 }, cost: { usd: 12.3456 }, changed: ['cost'] }),
  ]
  for (const body of bodies) {
    assert.ok(body !== null)
    const reply = record!.handler({ sessionId: SID, ts: new Date(Date.now()).toISOString(), ...body })
    assert.deepEqual(reply, { text: 'ok' }, JSON.stringify(body).slice(0, 160))
  }
})
