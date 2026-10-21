/** Import this FIRST in server.ts: imports run before the importer's own code, so the guard has to be a module. */
import { Console } from 'node:console'

// stdout carries the protocol. Any console output, from any module, goes to stderr instead.
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr })

// Claude Code closing the pipe (EPIPE) is a normal shutdown; anything else is a real failure.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0)
  process.stderr.write(`omnis: stdout ${err.code ?? 'error'}\n`)
  process.exit(1)
})
