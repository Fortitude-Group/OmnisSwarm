import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { tmpRoot } from '../helpers.ts'

const SERVER = fileURLToPath(new URL('../../src/mcp/server.ts', import.meta.url))

test('the server speaks MCP over stdio and writes the swarm log', async () => {
  const root = tmpRoot()
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, OMNIS_PROJECT_DIR: root, OMNIS_TEST_STARTUP_LOG: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stdoutLines: string[] = []
  let stderr = ''
  child.stderr.on('data', (d: Buffer) => {
    stderr += d.toString()
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

  try {
    const init = await call(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
    assert.equal(init.result.serverInfo.name, 'omnis-swarm')
    assert.equal(init.result.protocolVersion, '2025-11-25')
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

    const list = await call(2, 'tools/list')
    assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name).sort(), [
      'omnis_memory_get', 'omnis_memory_list', 'omnis_memory_put', 'omnis_swarm_end',
      'omnis_swarm_init', 'omnis_swarm_status', 'omnis_task_create', 'omnis_task_update',
    ])

    const started = await call(3, 'tools/call', { name: 'omnis_swarm_init', arguments: { name: 'E2E run', topology: 'mesh' } })
    assert.equal(started.result.isError, false)
    assert.ok(existsSync(join(root, '.omnis-swarm', 'swarms', 'e2e-run.jsonl')))

    const bad = await call(4, 'tools/call', { name: 'omnis_swarm_init', arguments: { name: 'x', topology: 'ring' } })
    assert.equal(bad.result.isError, true)
    assert.match(bad.result.content[0].text, /topology must be one of/)

    // stdout carries only JSON-RPC replies; stray console output went to stderr.
    assert.ok(stdoutLines.length >= 4)
    for (const line of stdoutLines) assert.doesNotThrow(() => JSON.parse(line), `non-JSON on stdout: ${line}`)
    assert.match(stderr, /omnis-test-startup-log/)
    assert.ok(!stdoutLines.some(l => l.includes('omnis-test-startup-log')))
  } finally {
    child.kill()
  }
})
