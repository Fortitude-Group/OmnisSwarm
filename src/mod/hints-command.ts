/** /omnis hints (spec 2026-10-25 section 6): the model history table and hint lines, from the server. */
import type { EngineInterface } from 'claude-code'
import { HINTS_TOOL } from '../core/recording.ts'
import type { Sub } from './commands.ts'
import { connectServer } from './server.ts'

const USAGE = 'Usage: /omnis hints shows which models past runs did well on.'
const MAX_TEXT = 4000

export const hintsSub: Sub = {
  name: 'hints',
  describe: '/omnis hints shows which models past runs did well on',
  hint: 'hints',
  usage: USAGE,
}

/** `words` are the lower-cased words after /omnis, "hints" first. */
export async function hintsCommand($: EngineInterface, words: readonly string[]): Promise<string | null> {
  if (words.length !== 1) return USAGE
  try {
    const server = await connectServer($)
    if (server === null) return 'The swarm server is not connected yet; try again in a moment.'
    const result = await $.mcp.call(server, HINTS_TOOL, {})
    const block = result.content[0]
    const text = block !== undefined && block.type === 'text' && typeof block.text === 'string' ? block.text.slice(0, MAX_TEXT) : ''
    if (text === '') return 'The model history could not be read.'
    return result.isError === true ? `No hints: ${text}` : text
  } catch {
    return 'The model history could not be read.'
  }
}
