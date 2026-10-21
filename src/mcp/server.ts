/** OmnisSwarm MCP server: `node src/mcp/server.ts`. Logs only to stderr; stdout carries the protocol. */
import { runStdio } from './protocol.ts'
import { toolFactories } from './registry.ts'

// First thing: a stray console.log must not corrupt the protocol stream.
for (const level of ['log', 'info', 'debug', 'warn'] as const) console[level] = console.error
// Claude Code closing the pipe is a normal shutdown, not a crash.
process.stdout.on('error', () => process.exit(0))

const root = process.env.OMNIS_PROJECT_DIR ?? process.env.OMNIS_SWARM_ROOT ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd()

if (process.env.OMNIS_TEST_STARTUP_LOG === '1') console.log('omnis-test-startup-log')

const tools = toolFactories.flatMap(factory => factory({ root }))
void runStdio(tools, { name: 'omnis-swarm', version: '0.1.0' })
