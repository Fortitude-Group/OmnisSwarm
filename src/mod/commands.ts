/**
 * The /omnis command. Each subcommand lives in its own file and is listed here once: its text (Sub, plain data) in
 * SUBS, its handler in the switch. The mod checker refuses `$` passed through a property call, so dispatch is by
 * direct calls to each module's named export.
 */
import type { EngineInterface } from 'claude-code'
import { budgetCommand, budgetSub } from './budget-command.ts'
import { exportCommand, exportSub } from './export-command.ts'
import { hintsCommand, hintsSub } from './hints-command.ts'
import { paneCommand, paneSub } from './pane-commands.ts'
import { replayCommand, replaySub } from './replay-command.ts'
import { reportCommand, reportSub } from './run-report.ts'

export type Sub = {
  /** The first word after /omnis. */
  name: string
  /** Its part of the command's description, after "OmnisSwarm: ". */
  describe: string
  /** Its part of the argument hint. */
  hint: string
  /** One sentence of usage, shown for anything the command can't read. */
  usage: string
}

/** Subcommands not built yet are null: they add nothing to the text and answer null, which runOmnis turns into the usage. */
const SUBS: readonly Sub[] = [paneSub, budgetSub, replaySub, exportSub, reportSub, hintsSub].filter((s): s is Sub => s !== null)

export const COMMAND_DESCRIPTION = `OmnisSwarm: ${SUBS.map(s => s.describe).join(', ')}`
export const COMMAND_HINT = SUBS.map(s => s.hint).join(' | ')
export const USAGE = SUBS.map(s => s.usage).join(' ')

/** `words` are the lower-cased words after /omnis, the subcommand's name first. */
export async function runOmnis($: EngineInterface, args: string): Promise<string> {
  const words = args.trim().toLowerCase().split(/\s+/)
  switch (words[0]) {
    case 'pane': return paneCommand($, words)
    case 'budget': return (await budgetCommand($, words)) ?? USAGE
    case 'replay': return (await replayCommand($, words)) ?? USAGE
    case 'export': return (await exportCommand($, words)) ?? USAGE
    case 'report': return (await reportCommand($, words)) ?? USAGE
    case 'hints': return (await hintsCommand($, words)) ?? USAGE
    default: return USAGE
  }
}
