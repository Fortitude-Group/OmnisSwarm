// src/mod/export-command.ts  (Task 9 fills it in)
import type { EngineInterface } from 'claude-code'
import type { Sub } from './commands.ts'

export const exportSub: Sub | null = null

/** Null until the subcommand exists: runOmnis answers the usage. */
export async function exportCommand(_$: EngineInterface, _words: readonly string[]): Promise<string | null> {
  return null
}
