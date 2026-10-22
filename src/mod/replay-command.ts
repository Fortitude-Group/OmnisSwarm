// src/mod/replay-command.ts  (Task 6 fills it in)
import type { EngineInterface } from 'claude-code'
import type { Sub } from './commands.ts'

export const replaySub: Sub | null = null

/** Null until the subcommand exists: runOmnis answers the usage. */
export async function replayCommand(_$: EngineInterface, _words: readonly string[]): Promise<string | null> {
  return null
}
