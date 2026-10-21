import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { tmpRoot } from '../helpers.ts'

const SERVER = fileURLToPath(new URL('../../src/mcp/server.ts', import.meta.url))
const NOISY = fileURLToPath(new URL('./fixtures/noisy-server.ts', import.meta.url))

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
      'omnis_memory_get', 'omnis_memory_list', 'omnis_memory_put', 'omnis_swarm_end',
      'omnis_swarm_init', 'omnis_swarm_status', 'omnis_task_create', 'omnis_task_update',
    ])

    const started = await s.call(3, 'tools/call', { name: 'omnis_swarm_init', arguments: { name: 'E2E run', topology: 'mesh' } })
    assert.equal(started.result.isError, false)
    assert.ok(existsSync(join(root, '.omnis-swarm', 'swarms', 'e2e-run.jsonl')))

    const bad = await s.call(4, 'tools/call', { name: 'omnis_swarm_init', arguments: { name: 'x', topology: 'ring' } })
    assert.equal(bad.result.isError, true)
    assert.match(bad.result.content[0].text, /topology must be one of/)

    for (const line of s.stdoutLines) assert.doesNotThrow(() => JSON.parse(line), `non-JSON on stdout: ${line}`)
    assert.ok(s.out.stderr.includes('omnis: project root'))
  } finally {
    await s.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test('an unexpanded placeholder root is ignored in favour of CLAUDE_PROJECT_DIR', async () => {
  const root = tmpRoot()
  const s = start(SERVER, { OMNIS_PROJECT_DIR: '${CLAUDE_PROJECT_DIR}', CLAUDE_PROJECT_DIR: root })
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

test('server.ts imports the stdio guard before anything else', () => {
  const source = readFileSync(SERVER, 'utf8')
  const firstImport = source.split(/\r?\n/).map(l => l.trim()).find(l => /^(import|export)\b/.test(l))
  assert.match(firstImport ?? '', /^import '\.\/stdio-guard\.ts'/)
})
