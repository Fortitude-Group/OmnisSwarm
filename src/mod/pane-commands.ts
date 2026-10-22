/** The pane's /omnis subcommand, the auto-open and the pin chips. */
import type { EngineInterface, RenderElement } from 'claude-code'
import { hex } from '../render/color.ts'
import { GLYPH } from '../render/tokens.ts'
import type { Frame } from '../render/types.ts'
import type { Sub } from './commands.ts'
import { closed, hooks, openPane } from './pane-draw.ts'
import { wake, PANE_ID } from './pane-pull.ts'
import { rt, saveStyle, togglePin, type Kit } from './pane-runtime.ts'

/** /omnis pane style robot|globe: saved as the pin is, and drawn at once when the pane is open. */
async function styleCommand($: EngineInterface, arg: string): Promise<string> {
  if (arg !== 'robot' && arg !== 'globe') return PANE_USAGE
  try {
    await saveStyle($, arg)
  } catch {
    return 'The swarm pane style could not be saved.'
  }
  rt.style = arg
  rt.last = null
  if (rt.host !== null) rt.host.invalidate()
  return `Swarm pane style: ${arg === 'robot' ? 'robots' : 'globes'}.`
}

const PANE_USAGE = 'Usage: /omnis pane, /omnis pane close, or /omnis pane style robot|globe.'

async function openOrClose($: EngineInterface, arg: string): Promise<string> {
  if (arg === 'close') {
    await $.ui.close({ id: PANE_ID }).catch(() => undefined)
    closed(true)
    return 'Swarm pane closed.'
  }
  if (rt.panel === 'off') return 'The swarm pane is off (the panel setting). Set it to command or auto in /config to use it.'
  const opened = await openPane($)
  return opened.isPlaced ? 'Swarm pane open.' : `The swarm pane is waiting to be shown: ${opened.reason}`
}

/** True while an auto-open is in flight, so tool calls in quick succession open the pane once. */
let autoOpening = false

/** Run in the background by its hook, started before next(e) and never awaited: a tool call never waits on ui.open. */
export async function maybeAutoOpen($: EngineInterface): Promise<void> {
  if (rt.panel !== 'auto' || rt.open || rt.closedByPerson || autoOpening) return
  autoOpening = true
  try {
    await openPane($)
  } finally {
    autoOpening = false
  }
}

/** What a command answers when its hook fails: the session goes on, and the markdown fallback is not sent to the model. */
export const COMMAND_FAILED = { text: 'The swarm pane could not be opened.' }


/** The chip row: one plain Button per agent, as many as fit, then "+n". Pressing one pins it; pressing it again unpins. */
export function chipRow($: EngineInterface, kit: Kit, frame: Frame, columns: number): RenderElement[] {
  if (frame.chips.length === 0) return []
  const shown: typeof frame.chips = []
  let width = 0
  for (const chip of frame.chips) {
    const w = [...chip.label].length + 4
    if (shown.length > 0 && width + w > columns - 4) break
    shown.push(chip)
    width += w
  }
  const buttons = shown.map(chip => kit.Button({
    key: `pin:${chip.id}`,
    plain: true,
    ...(chip.pinned && { variant: 'primary' as const }),
    onPress: () => {
      // A pin that could not be saved leaves the pane as it was.
      void togglePin($, chip.id).catch(() => undefined)
      if (rt.host !== null) wake(hooks, rt.host)
    },
    children: [kit.Text({ color: hex(chip.color), children: chip.pinned ? GLYPH.pinned : GLYPH.dot }), ` ${chip.label}`],
  }))
  const more = frame.chips.length - shown.length
  return [kit.Box({ key: 'chips', flexDirection: 'row', gap: 2, children: [...buttons, ...(more > 0 ? [kit.Text({ dimColor: true, children: `+${more}` })] : [])] })]
}

export function resetAutoOpen(): void {
  autoOpening = false
}

export const paneSub: Sub = {
  name: 'pane',
  describe: '/omnis pane shows the live swarm pane, /omnis pane close hides it, /omnis pane style robot|globe picks the node style',
  hint: 'pane [close | style robot|globe]',
  usage: PANE_USAGE,
}

/** `words` are the lower-cased words after /omnis, pane first. */
export async function paneCommand($: EngineInterface, words: readonly string[]): Promise<string> {
  const [, arg = '', value = ''] = words
  if (arg === 'style') return words.length > 3 ? PANE_USAGE : styleCommand($, value)
  return openOrClose($, arg)
}
