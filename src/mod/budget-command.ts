// src/mod/budget-command.ts  (Task 3b fills it in)
import type { EngineInterface } from 'claude-code'
import type { Sub } from './commands.ts'

export const budgetSub: Sub | null = null

/** Null until the subcommand exists: runOmnis answers the usage. */
export async function budgetCommand(_$: EngineInterface, _words: readonly string[]): Promise<string | null> {
  return null
}
