/** OmnisSwarm MCP server, started by start.mjs. Logs only to stderr; stdout carries the protocol. */
import './stdio-guard.ts' // must stay the first import
import { resolve } from 'node:path'
import { installShutdown, killAllGates } from './gate/run.ts'
import { hintsOptions } from './history-store.ts'
import { runStdio } from './protocol.ts'
import { toolFactories } from './registry.ts'
import { Session } from './session.ts'

/** First non-empty candidate that isn't an unexpanded `${...}` placeholder. */
const pick = (...candidates: Array<string | undefined>): string | undefined =>
  candidates.find(c => c !== undefined && c.trim() !== '' && !c.includes('${'))

const root = resolve(pick(process.env.OMNIS_PROJECT_DIR, process.env.CLAUDE_PROJECT_DIR) ?? process.cwd())
// Claude Code logs anything on a server's stderr as [ERROR], so this note only shows when asked for.
if (process.env.OMNIS_DEBUG) process.stderr.write(`omnis: project root ${root}\n`)

const session = new Session(root)
// The one place the gate and hints settings are read from the environment (tools default to both off).
const tools = toolFactories.flatMap(factory => factory({ root, session, gate: { env: process.env }, hints: hintsOptions(process.env) }))
// A gate's process tree must not outlive the server: killed on a shutdown signal and when stdin ends (the end of
// stdin also aborts each running call, which kills its gate). A hard kill of the server can't be caught.
installShutdown(process, code => process.exit(code))
void runStdio(tools, { name: 'omnis-swarm', version: '0.6.2' }).then(killAllGates)
