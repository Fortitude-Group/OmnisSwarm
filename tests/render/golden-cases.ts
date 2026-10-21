/** The golden snapshot cases: the five-agent fixture at fixed times, sizes and topologies. Shared with scripts/preview.ts. */
import type { Topology } from '../../src/core/events.ts'
import { foldAll } from '../../src/core/fold.ts'
import { pulsesFrom } from '../../src/mod/pane-model.ts'
import { render } from '../../src/render/frame.ts'
import type { Frame, Size } from '../../src/render/types.ts'
import { FIVE_AT, FIVE_SWARM, fiveAgentEvents } from '../fixtures/swarm-five.ts'

export type GoldenCase = { name: string; size: Size; at: number; topology: Topology }

const FULL = { columns: 120, rows: 44 }

export const GOLDEN_CASES: readonly GoldenCase[] = [
  { name: 'full-mid', size: FULL, at: FIVE_AT.mid, topology: 'hierarchical' },
  { name: 'full-idle', size: FULL, at: FIVE_AT.idle, topology: 'hierarchical' },
  { name: 'mesh-mid', size: FULL, at: FIVE_AT.mid, topology: 'mesh' },
  { name: 'star-mid', size: FULL, at: FIVE_AT.mid, topology: 'star' },
  { name: 'no-timeline-mid', size: { columns: 100, rows: 29 }, at: FIVE_AT.mid, topology: 'hierarchical' },
  { name: 'compact-mid', size: { columns: 80, rows: 21 }, at: FIVE_AT.mid, topology: 'hierarchical' },
  { name: 'tree-mid', size: { columns: 60, rows: 13 }, at: FIVE_AT.mid, topology: 'hierarchical' },
  { name: 'summary-mid', size: { columns: 40, rows: 5 }, at: FIVE_AT.mid, topology: 'hierarchical' },
]

export function goldenFrame(c: GoldenCase): Frame {
  const events = fiveAgentEvents(c.topology)
  return render(foldAll(FIVE_SWARM, events), { pinned: null, spotlight: null, pulses: pulsesFrom(events), lagMs: 0, tween: null }, c.at, c.size)
}
