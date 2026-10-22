// The MCP server's entry point: `node start.mjs`. Plain JavaScript so a Node too old to strip types still runs it and
// says why, instead of failing on the .ts file before any check could run. Writes nothing to stdout.
import { nodeVersionProblem } from './node-version.mjs'

const problem = nodeVersionProblem(process.versions.node)
if (problem !== null) {
  process.stderr.write(`${problem}\n`)
  process.exit(1)
}
await import('./server.ts')
