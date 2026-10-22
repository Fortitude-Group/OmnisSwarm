/** /omnis replay [swarm] [speed] and /omnis replay stop (spec section 3). */
import type { EngineInterface } from 'claude-code'
import { isValidSwarmId } from '../core/events.ts'
import { MAX_SPEED, MIN_SPEED } from '../core/replay-clock.ts'
import type { Sub } from './commands.ts'
import { openPane } from './pane-draw.ts'
import { hostOf, rt } from './pane-runtime.ts'
import { loadReplay, startReplay, stopReplay } from './replay.ts'

const USAGE = 'Usage: /omnis replay [swarm] [speed 1-60], or /omnis replay stop.'
const DEFAULT_SPEED = 10

/**
 * [swarm] [speed], in that order: a lone number is the speed, a lone id the swarm. Any all-digit word is a speed
 * (out of range, or not last, is the usage), never a swarm id.
 */
export function parseReplay(words: readonly string[]): { swarm: string | null; speed: number } | 'stop' | null {
  const rest = words.slice(1)
  if (rest.length === 1 && rest[0] === 'stop') return 'stop'
  if (rest.length > 2) return null
  let swarm: string | null = null
  let speed = DEFAULT_SPEED
  for (const [i, w] of rest.entries()) {
    if (/^\d+$/.test(w)) {
      if (i !== rest.length - 1) return null
      speed = Number(w)
      if (speed < MIN_SPEED || speed > MAX_SPEED) return null
    } else if (i === 0 && isValidSwarmId(w) && w !== 'stop') swarm = w
    else return null
  }
  return { swarm, speed }
}

export const replaySub: Sub | null = {
  name: 'replay',
  describe: '/omnis replay [swarm] [speed] replays a recorded swarm',
  hint: 'replay [swarm] [speed] | replay stop',
  usage: USAGE,
}

/** `words` are the lower-cased words after /omnis, replay first. */
export async function replayCommand($: EngineInterface, words: readonly string[]): Promise<string | null> {
  const parsed = parseReplay(words)
  if (parsed === null) return USAGE
  const host = rt.host ?? hostOf($)
  if (parsed === 'stop') {
    if (rt.replay === null) return 'No replay is playing.'
    stopReplay(host)
    return 'Back to the live swarm.'
  }
  if (rt.panel === 'off') return 'The swarm pane is off (the panel setting). Set it to command or auto in /config to use it.'
  const loaded = await loadReplay(host, parsed.swarm)
  if (!loaded.ok) return loaded.text
  if (!rt.open) await openPane($)
  startReplay(host, loaded.swarm, loaded.events, parsed.speed)
  return `Replaying ${loaded.swarm} at ${parsed.speed}×. /omnis replay stop returns to live.`
}
