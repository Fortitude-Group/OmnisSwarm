/** OmnisSwarm MCP server, started by start.mjs. Logs only to stderr; stdout carries the protocol. */
import './stdio-guard.ts' // must stay the first import
import { resolve } from 'node:path'
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
const tools = toolFactories.flatMap(factory => factory({ root, session }))
void runStdio(tools, { name: 'omnis-swarm', version: '0.1.0' })
