/** omnis_hints (spec 2026-10-25 section 6): the model history table for /omnis hints. Internal: the mod's guard refuses the model. */
import { hintsText } from '../../core/hints.ts'
import { HINTS_TOOL } from '../../core/recording.ts'
import { HINTS_OFF, loadRows } from '../history-store.ts'
import type { ToolDef } from '../protocol.ts'
import type { ToolContext } from '../tools.ts'

export function createHintsTools(ctx: ToolContext): ToolDef[] {
  const opts = ctx.hints ?? HINTS_OFF
  return [{
    name: HINTS_TOOL,
    description: 'Internal to the OmnisSwarm plugin: the model history table for /omnis hints. When the OmnisSwarm mod is loaded it refuses calls from the model.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => {
      if (opts.mode === 'off') return { text: 'Model hints are off (the modelHints setting).' }
      const { project, machine } = loadRows(ctx.root, opts)
      return { text: hintsText(project, machine) }
    },
  }]
}
