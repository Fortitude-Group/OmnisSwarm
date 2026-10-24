import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { readEvents, swarmLogPath } from '../../src/core/log.ts'
import { sessionKey } from '../../src/core/swarm.ts'
import { tmpRoot } from '../helpers.ts'

const SERVER = fileURLToPath(new URL('../../src/mcp/server.ts', import.meta.url))
const NOISY = fileURLToPath(new URL('./fixtures/noisy-server.ts', import.meta.url))
const START = fileURLToPath(new URL('../../src/mcp/start.mjs', import.meta.url))
const MANIFEST = JSON.parse(readFileSync(fileURLToPath(new URL('../../.claude-plugin/plugin.json', import.meta.url)), 'utf8')) as { version: string }

function start(script: string, env: Record<string, string>) {
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  const stdoutLines: string[] = []
  const out = { stderr: '' }
  child.stderr.on('data', (d: Buffer) => {
    out.stderr += d.toString()
  })
  const waiting = new Map<number, (reply: any) => void>()
  createInterface({ input: child.stdout }).on('line', line => {
    stdoutLines.push(line)
    let reply: any
    try {
      reply = JSON.parse(line)
    } catch {
      return
    }
    waiting.get(reply.id)?.(reply)
    waiting.delete(reply.id)
  })
  const call = (id: number, method: string, params: unknown = {}) =>
    new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no reply to ${method}`)), 10_000)
      waiting.set(id, reply => {
        clearTimeout(timer)
        resolve(reply)
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  const stop = async () => {
    child.kill()
    await once(child, 'exit')
  }
  return { child, call, stdoutLines, out, stop }
}

test('the server speaks MCP over stdio and writes the swarm log', async () => {
  const root = tmpRoot()
  const s = start(SERVER, { OMNIS_PROJECT_DIR: root })
  try {
    const init = await s.call(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
    assert.equal(init.result.serverInfo.name, 'omnis-swarm')
    assert.equal(init.result.protocolVersion, '2025-11-25')
    s.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

    const list = await s.call(2, 'tools/list')
    assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name).sort(), [
      'omnis_export', 'omnis_feed', 'omnis_gate_approve', 'omnis_gate_plan', 'omnis_memory_get', 'omnis_memory_list', 'omnis_memory_put', 'omnis_record', 'omnis_replay', 'omnis_report', 'omnis_swarm_end',
      'omnis_swarm_init', 'omnis_swarm_status', 'omnis_task_create', 'omnis_task_update',
    ])

    const started = await s.call(3, 'tools/call', { name: 'omnis_swarm_init', arguments: { name: 'E2E run', topology: 'mesh' } })
    assert.equal(started.result.isError, false)
    assert.ok(existsSync(join(root, '.omnis-swarm', 'swarms', 'e2e-run.jsonl')))

    const bad = await s.call(4, 'tools/call', { name: 'omnis_swarm_init', arguments: { name: 'x', topology: 'ring' } })
    assert.equal(bad.result.isError, true)
    assert.match(bad.result.content[0].text, /topology must be one of/)

    for (const line of s.stdoutLines) assert.doesNotThrow(() => JSON.parse(line), `non-JSON on stdout: ${line}`)
    // Claude Code logs a server's stderr as [ERROR], so a normal start writes nothing there.
    assert.ok(!s.out.stderr.includes('omnis: project root'))
  } finally {
    await s.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test('an unexpanded placeholder root is ignored in favour of CLAUDE_PROJECT_DIR', async () => {
  const root = tmpRoot()
  // OMNIS_DEBUG makes the server say which root it chose.
  const s = start(SERVER, { OMNIS_PROJECT_DIR: '${CLAUDE_PROJECT_DIR}', CLAUDE_PROJECT_DIR: root, OMNIS_DEBUG: '1' })
  try {
    await s.call(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
    assert.ok(s.out.stderr.includes(root))
  } finally {
    await s.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test('console output from modules imported before the server goes to stderr, never stdout', async () => {
  const root = tmpRoot()
  const s = start(NOISY, { OMNIS_PROJECT_DIR: root })
  try {
    await s.call(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
    assert.ok(s.stdoutLines.length >= 1)
    for (const line of s.stdoutLines) assert.doesNotThrow(() => JSON.parse(line), `non-JSON on stdout: ${line}`)
    assert.match(s.out.stderr, /omnis-noisy-import/)
    assert.match(s.out.stderr, /noisy: true/)
  } finally {
    await s.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test('start.mjs runs the server: initialize answers with the manifest version, and stdout stays protocol-only', async () => {
  const root = tmpRoot()
  const s = start(START, { OMNIS_PROJECT_DIR: root })
  try {
    const reply = await s.call(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
    assert.deepEqual(reply.result.serverInfo, { name: 'omnis-swarm', version: MANIFEST.version })
    for (const line of s.stdoutLines) assert.doesNotThrow(() => JSON.parse(line), `non-JSON on stdout: ${line}`)
  } finally {
    await s.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test('server.ts imports the stdio guard before anything else', () => {
  const source = readFileSync(SERVER, 'utf8')
  const firstImport = source.split(/\r?\n/).map(l => l.trim()).find(l => /^(import|export)\b/.test(l))
  assert.match(firstImport ?? '', /^import '\.\/stdio-guard\.ts'/)
})

test('omnis_record over stdio starts the session swarm and appends the event as the recorder wrote it', async () => {
  const root = tmpRoot()
  const s = start(SERVER, { OMNIS_PROJECT_DIR: root })
  try {
    await s.call(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
    const sessionId = 'abcdef12-3456-7890-abcd-ef1234567890'
    const ts = new Date().toISOString()
    const data = { phase: 'start', tool: 'Bash', kind: 'bash', subject: 'npm test', isError: false }
    const ok = await s.call(2, 'tools/call', { name: 'omnis_record', arguments: { sessionId, ts, type: 'agent.tool', agent: 'lead', data } })
    assert.equal(ok.result.isError, false)
    const refused = await s.call(3, 'tools/call', { name: 'omnis_record', arguments: { sessionId, ts, type: 'memory.put', data: {} } })
    assert.equal(refused.result.isError, true)
    const events = readEvents(swarmLogPath(root, `session-${sessionKey(sessionId).slice(0, 8)}`)).events
    assert.deepEqual(events.map(e => [e.type, e.src]), [['swarm.started', 'mcp'], ['agent.tool', 'recorder']])
    assert.deepEqual(events[1]?.data, data)
  } finally {
    await s.stop()
  }
})
