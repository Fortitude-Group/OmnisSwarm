import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The vendored engine declarations mirror what the engine lays down in .claude-plugin/types: the core in
// claude-code, the built-in tool schemas in claude-code-tools, the connected MCP tools in claude-code-mcp.
// Without the schemas `e.tool === 'Agnet'` and `$.tool.call({ tool: 'Bash', commandd: 'ls' })` typecheck, so a
// refresh that copies only the core must fail here.
const typesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'types')
const read = (root: string) => readFileSync(join(typesDir, root, 'index.d.ts'), 'utf8').replaceAll('\r\n', '\n')
const VERSION = /Claude Code \d+\.\d+\.\d+/

/** The body of the first `interface <name> {` inside a `declare module 'claude-code' {` block, or null. */
function interfaceIn(text: string, name: string): string | null {
  const module = text.indexOf("declare module 'claude-code' {")
  if (module === -1) return null
  const start = text.indexOf(`interface ${name} {`, module)
  if (start === -1) return null
  const end = text.indexOf('\n  }\n', start)
  return end === -1 ? null : text.slice(start, end)
}

test('the core declarations name the Claude Code version that wrote them on their first line', () => {
  assert.match(read('claude-code').split('\n')[0] ?? '', /^\/\/ Written by Claude Code \d+\.\d+\.\d+\.$/)
})

test('the built-in tool schemas are vendored, with their source version in the header', () => {
  const tools = read('claude-code-tools')
  assert.match(tools.split('\n').slice(0, 3).join('\n'), VERSION)
  const inputs = interfaceIn(tools, 'BuiltinToolInputs')
  assert.ok(inputs !== null, "no interface BuiltinToolInputs in a declare module 'claude-code' block")
  for (const tool of ['Agent', 'Bash', 'Read', 'SendMessage']) assert.match(inputs, new RegExp(`\\n    ${tool}: \\{`), `no ${tool} input schema`)
  assert.ok(interfaceIn(tools, 'BuiltinToolResults') !== null, 'no interface BuiltinToolResults')
})

test("the MCP declarations are vendored, with their source version in the header, and hold this plugin's tools", () => {
  const mcp = read('claude-code-mcp')
  assert.match(mcp.split('\n').slice(0, 4).join('\n'), VERSION)
  const inputs = interfaceIn(mcp, 'McpToolInputs')
  assert.ok(inputs !== null, "no interface McpToolInputs in a declare module 'claude-code' block")
  for (const server of ['plugin_omnis-swarm_omnis-swarm', 'omnis-swarm']) {
    for (const tool of ['omnis_swarm_init', 'omnis_feed', 'omnis_record']) assert.ok(inputs.includes(`"mcp__${server}__${tool}": {`), `no ${tool} under ${server}`)
  }
})

test("the MCP declarations hold no other server's tools: the repo does not describe anyone's own setup", () => {
  const names = [...read('claude-code-mcp').matchAll(/^ {4}"?(mcp__[^"\s:]+)"?: \{/gm)].map(m => m[1] ?? '')
  assert.ok(names.length > 0)
  assert.deepEqual(names.filter(n => !/^mcp__(plugin_omnis-swarm_omnis-swarm|omnis-swarm)__/.test(n)), [])
})

const WRITTEN_BY = /^\/\/ Written by Claude Code (\d+)\.(\d+)\.(\d+)\./
const versionOf = (file: string): [number, number, number] | null => {
  const m = WRITTEN_BY.exec(readFileSync(file, 'utf8').split(/\r?\n/, 1)[0] ?? '')
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])]
}
/** Negative when a is older than b. */
const compareVersions = (a: readonly number[], b: readonly number[]): number => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!

test('compareVersions orders major, then minor, then patch', () => {
  assert.ok(compareVersions([2, 1, 307], [2, 1, 308]) < 0)
  assert.ok(compareVersions([2, 2, 0], [2, 1, 999]) > 0)
  assert.equal(compareVersions([2, 1, 308], [2, 1, 308]), 0)
})

test('the vendored types are not older than the ones the engine last laid down (warns, never fails)', t => {
  const engineFile = join(typesDir, '..', '.claude-plugin', 'types', 'claude-code', 'index.d.ts')
  if (!existsSync(engineFile)) {
    t.skip('no engine-laid types here (they appear once Claude Code loads the mod from this folder)')
    return
  }
  const vendored = versionOf(join(typesDir, 'claude-code', 'index.d.ts'))
  const engine = versionOf(engineFile)
  assert.ok(vendored !== null && engine !== null, 'both type files start with a "Written by Claude Code x.y.z." line')
  if (compareVersions(vendored, engine) < 0) {
    t.diagnostic(`WARNING: types/claude-code is from Claude Code ${vendored.join('.')}, the engine laid down ${engine.join('.')}. ` +
      'Refresh: copy .claude-plugin/types/claude-code{,-tools,-mcp}/index.d.ts over types/ (keep the vendored headers), then npm run check.')
  }
})
