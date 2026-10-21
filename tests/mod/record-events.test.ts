import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  agentFinished, agentStarted, agentUsage, cleanPath, cleanText, messageSent, protocolMessage, redact,
  sessionMeasure, toolEvent, toolKind, toolSubject, whoOf,
} from '../../src/mod/record-events.ts'

test('cleanText strips control and format characters, collapses whitespace and cuts with an ellipsis', () => {
  assert.equal(cleanText('  a\tb\n\nc\u0007d\u200Be  ', 80), 'a b c d e')
  assert.equal(cleanText('abcdef', 4), 'abc…')
  assert.equal(cleanText(42, 10), '')
})

test('cleanText never splits a surrogate pair and stays within max UTF-16 units', () => {
  const out = cleanText('😀'.repeat(50), 9)
  assert.ok(out.length <= 9)
  assert.equal(out, '😀😀😀😀…')
})

test('cleanPath keeps the end of a long path', () => {
  const path = `C:/projects/${'deep/'.repeat(30)}src/mod/recorder.ts`
  const out = cleanPath(path, 80)
  assert.equal(out.length, 80)
  assert.ok(out.startsWith('…'))
  assert.ok(out.endsWith('src/mod/recorder.ts'))
  assert.equal(cleanPath('src/a.ts', 80), 'src/a.ts')
})

test('redact blanks token-shaped runs', () => {
  assert.equal(redact('curl -H "Authorization: Bearer ghp_abcdefghijklmnop1234"'), 'curl -H "Authorization: Bearer [redacted]"')
  assert.equal(redact(7), '')
})

test('tool kinds', () => {
  assert.equal(toolKind('Read'), 'read')
  assert.equal(toolKind('Edit'), 'edit')
  assert.equal(toolKind('Write'), 'edit')
  assert.equal(toolKind('NotebookEdit'), 'edit')
  assert.equal(toolKind('Bash'), 'bash')
  assert.equal(toolKind('PowerShell'), 'bash')
  assert.equal(toolKind('Glob'), 'search')
  assert.equal(toolKind('Grep'), 'search')
  assert.equal(toolKind('WebFetch'), 'web')
  assert.equal(toolKind('WebSearch'), 'web')
  assert.equal(toolKind('Agent'), 'agent')
  assert.equal(toolKind('SendMessage'), 'agent')
  assert.equal(toolKind('ToolSearch'), 'other')
  assert.equal(toolKind('mcp__plugin_omnis-swarm_omnis-swarm__omnis_swarm_status'), 'other')
  assert.equal(toolKind('constructor'), 'other')
})

test('tool subjects: path, command, pattern, url, description; nothing for other tools', () => {
  assert.equal(toolSubject('Read', { file_path: 'src/a.ts' }), 'src/a.ts')
  assert.equal(toolSubject('NotebookEdit', { notebook_path: 'n.ipynb' }), 'n.ipynb')
  assert.equal(toolSubject('Bash', { command: 'npm   test\n--watch' }), 'npm test --watch')
  assert.equal(toolSubject('Bash', { command: 'echo sk-abcdefghijklmnopqrstu' }), 'echo [redacted]')
  assert.equal(toolSubject('Grep', { pattern: 'TODO', path: 'src' }), 'TODO')
  assert.equal(toolSubject('WebFetch', { url: 'https://example.com/a' }), 'https://example.com/a')
  assert.equal(toolSubject('WebSearch', { query: 'mod api' }), 'mod api')
  assert.equal(toolSubject('Agent', { description: 'Find the docs', prompt: 'a long secret prompt' }), 'Find the docs')
  assert.equal(toolSubject('SendMessage', { to: 'main', message: 'hi' }), 'main')
  assert.equal(toolSubject('ToolSearch', { query: 'x' }), '')
  assert.equal(toolSubject('Bash', {}), '')
  assert.equal(toolSubject('Bash', { command: `echo ${'ab '.repeat(100)}` }).length, 80)
})

test('whoOf: no id is the lead, a seen id is itself, anything else is ignored', () => {
  const seen = new Set(['a1'])
  assert.equal(whoOf(undefined, seen), 'lead')
  assert.equal(whoOf('a1', seen), 'a1')
  assert.equal(whoOf('fork-9', seen), null)
  assert.equal(whoOf(5, seen), null)
})

test('agentStarted', () => {
  assert.deepEqual(agentStarted({ name: 'probe-worker', subagentType: 'general-purpose', description: 'Find the docs' }, 'a1'), {
    type: 'agent.started',
    agent: 'a1',
    data: { name: 'probe-worker', role: 'general-purpose', description: 'Find the docs', parent: 'lead' },
  })
  assert.equal(agentStarted({}, 'a1')?.data.role, 'agent')
  assert.equal(agentStarted({ parentAgentId: 'a0' }, 'a1')?.data.parent, 'a0')
  assert.equal(agentStarted({ parentAgentId: 'bad id' }, 'a1')?.data.parent, 'lead')
  assert.equal(agentStarted({ description: 'x'.repeat(300) }, 'a1')?.data.description.length, 120)
  assert.equal(agentStarted({}, 'bad id'), null)
  assert.equal(agentStarted({}, 'lead'), null)
})

test('agentFinished maps the engine reasons', () => {
  assert.deepEqual(agentFinished('answer', 'a1'), { type: 'agent.finished', agent: 'a1', data: { outcome: 'answer', reason: 'answer' } })
  assert.equal(agentFinished('aborted', 'a1').data.outcome, 'aborted')
  assert.equal(agentFinished('refusal', 'a1').data.outcome, 'failed')
  assert.equal(agentFinished('error', 'a1').data.outcome, 'failed')
  assert.equal(agentFinished('something-new', 'a1').data.outcome, 'failed')
})

test('agentUsage puts all cache writes in the 5-minute bucket and cleans the numbers', () => {
  assert.deepEqual(
    agentUsage({ input_tokens: 2, output_tokens: 210, cache_read_input_tokens: 0, cache_creation_input_tokens: 42374, model: 'claude-opus-5-5' }, 'a1'),
    { type: 'agent.usage', agent: 'a1', data: { model: 'claude-opus-5-5', input: 2, output: 210, cacheRead: 0, cacheWrite5m: 42374, cacheWrite1h: 0 } },
  )
  const odd = agentUsage({ input_tokens: -5, output_tokens: 3.7, cache_read_input_tokens: Number.NaN, cache_creation_input_tokens: 1e15, model: 'm' }, 'lead')
  assert.deepEqual(odd.data, { model: 'm', input: 0, output: 3, cacheRead: 0, cacheWrite5m: 1e12, cacheWrite1h: 0 })
})

test('toolEvent', () => {
  assert.deepEqual(toolEvent('start', 'Bash', { command: 'ls' }, 'lead'), {
    type: 'agent.tool', agent: 'lead', data: { phase: 'start', tool: 'Bash', kind: 'bash', subject: 'ls', isError: false },
  })
  assert.equal(toolEvent('end', 'Bash', {}, 'lead', true).data.isError, true)
})

test('messageSent takes a name or an { agentId } address and the first 200 characters', () => {
  assert.deepEqual(messageSent('main', 'hello from probe', 'a1'), { type: 'message.sent', agent: 'a1', data: { to: 'main', summary: 'hello from probe' } })
  assert.equal(messageSent({ agentId: 'a2' }, 'x', 'a1')?.data.to, 'a2')
  assert.equal(messageSent({ sessionId: 's' }, 'x', 'a1'), null)
  assert.equal(messageSent('main', 'word '.repeat(100), 'a1')?.data.summary.length, 200)
})

test('protocolMessage records the type and approval only', () => {
  assert.deepEqual(protocolMessage({ to: 'w1', message: { type: 'shutdown_request', reason: 'all done here' } }, 'lead'), {
    type: 'message.sent', agent: 'lead', data: { to: 'w1', summary: '[shutdown_request]' },
  })
  assert.equal(protocolMessage({ to: 'w1', message: { type: 'plan_approval_response', request_id: 'r', approve: false, feedback: 'no' } }, 'lead')?.data.summary, '[plan_approval_response] approve: no')
  assert.equal(protocolMessage({ to: 'w1', message: { type: 'shutdown_response', request_id: 'r', approve: true } }, 'a1')?.data.summary, '[shutdown_response] approve: yes')
  assert.equal(protocolMessage({ to: 'w1', message: 'plain text' }, 'lead'), null)
  assert.equal(protocolMessage({ message: { type: 'shutdown_request' } }, 'lead'), null)
})

test('sessionMeasure only when context or cost changed', () => {
  assert.deepEqual(
    sessionMeasure({ context: { tokens: 54378, window: 1000000, percent: 5 }, cost: { usd: 0.5079974 }, changed: ['context', 'cost'] }),
    { type: 'session.measure', data: { contextWindow: 1000000, contextTokens: 54378, contextPercent: 5, costUsd: 0.5079974 } },
  )
  assert.deepEqual(sessionMeasure({ context: { window: 200000 }, changed: ['context'] }), { type: 'session.measure', data: { contextWindow: 200000 } })
  assert.equal(sessionMeasure({ context: { window: 1 }, changed: ['rateLimits'] }), null)
  assert.equal(sessionMeasure({ context: { window: 1, percent: 140 }, changed: ['context'] })?.data.contextPercent, 100)
  assert.equal(sessionMeasure({ context: { window: 1 }, cost: { usd: -1 }, changed: ['cost'] })?.data.costUsd, undefined)
})

test('a 5 MB command is cut before it is scanned', () => {
  const huge = `echo ${'ab '.repeat(2_000_000)}`
  const start = Date.now()
  const out = toolSubject('Bash', { command: huge })
  assert.equal(out.length, 80)
  assert.ok(Date.now() - start < 500)
  assert.equal(cleanPath('x'.repeat(5_000_000) + 'tail.ts', 80).endsWith('tail.ts'), true)
  assert.equal(cleanText('y'.repeat(5_000_000), 10), 'yyyyyyyyy…')
})

test('hostile payloads do not throw', () => {
  const bad = null as never
  assert.equal(toolSubject('Bash', bad), '')
  assert.equal(toolEvent('start', 'Bash', undefined as never, 'lead').data.subject, '')
  assert.equal(protocolMessage(bad, 'lead'), null)
  assert.equal(sessionMeasure({ context: { window: 5 } } as never), null)
  assert.equal(sessionMeasure({ context: 'x', changed: ['cost'], cost: { usd: 1 } } as never)?.data.contextWindow, 0)
  assert.equal(sessionMeasure(bad), null)
  assert.equal(agentStarted(bad, 'a1')?.data.role, 'agent')
  assert.equal(agentUsage(bad, 'a1').data.input, 0)
})

test('protocol type is allow-listed', () => {
  assert.equal(protocolMessage({ to: 'w1', message: { type: 'my password is hunter2 okay' } }, 'lead')?.data.summary, '[protocol]')
})

test('grep and glob subjects are redacted', () => {
  assert.equal(toolSubject('Grep', { pattern: 'ghp_abcdefghijklmnop1234' }), '[redacted]')
})

test('redaction covers URL credentials, key=value pairs, -p flags and split tokens', () => {
  assert.equal(toolSubject('WebFetch', { url: 'https://admin:hunter2@host/x?token=abc123' }), 'https://[redacted]@host/x?token=[redacted]')
  assert.equal(toolSubject('Bash', { command: 'mysql -pS3cretPw!' }), 'mysql -p[redacted]')
  assert.equal(toolSubject('Bash', { command: 'export API_KEY=abcd1234' }), 'export API_KEY=[redacted]')
  assert.equal(toolSubject('Bash', { command: 'echo gh\u200Bp_abcdefghijklmnop1234' }), 'echo [redacted]')
})

test('lone surrogates are stripped and unsafe agent ids refused', () => {
  assert.equal(cleanText('a\uD800b', 10), 'a b')
  assert.equal(agentStarted({}, '__proto__'), null)
})

test('redact does not backtrack badly on long scheme-like runs', () => {
  const dots = 'a.'.repeat(2048)
  const start = Date.now()
  assert.equal(redact(dots), dots)
  assert.equal(redact('a'.repeat(4096)), '[redacted]')
  assert.ok(Date.now() - start < 500)
  assert.equal(redact('https://admin:hunter2@host/x'), 'https://[redacted]@host/x')
})
