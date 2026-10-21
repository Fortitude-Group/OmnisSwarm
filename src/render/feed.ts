/** The flow feed: messages, memory writes, task changes and agent starts and ends, newest first. Pure. */
import type { SwarmState } from '../core/fold.ts'
import { fmtAge } from './format.ts'
import { type Grid, type Part, writeParts } from './grid.ts'
import { FEED_COLOR, FEED_MARK, TEXT } from './tokens.ts'
import type { Rect } from './types.ts'

/** An agent's display name; a placeholder for a name nobody had is shown as `?name`. */
export function nameOf(state: SwarmState, id: string): string {
  if (!Object.hasOwn(state.agents, id)) return id
  const a = state.agents[id]!
  return a.placeholder ? `?${a.name}` : a.name
}

export function drawFeed(grid: Grid, area: Rect, state: SwarmState, now: number): void {
  if (area.h < 1) return
  const items = state.feed.slice(-area.h).reverse()
  const maxX = area.x + area.w - 1
  items.forEach((item, i) => {
    const parts: Part[] = [[fmtAge(now - item.at).padStart(4), TEXT.dim], [` ${FEED_MARK[item.kind]} `, FEED_COLOR[item.kind]]]
    if (item.kind === 'message') {
      parts.push([nameOf(state, item.agent), TEXT.primary], [' → ', TEXT.faint], [nameOf(state, item.to ?? '?'), TEXT.primary], [': ', TEXT.faint], [item.text, FEED_COLOR.message])
    } else {
      parts.push([item.text, FEED_COLOR[item.kind]])
    }
    writeParts(grid, area.x, area.y + i, parts, maxX)
  })
}
