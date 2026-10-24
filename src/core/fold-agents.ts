/** The agent.tool case of the fold. Split from fold.ts to keep that file small; it shares its helpers. */
import { TOOL_KINDS, isOneOf, isSafeKey, type SwarmEvent, type ToolKind } from './events.ts'
import { MAX_EDITS, MAX_FILES, agentOf, dropFailedEdit, revive, text, trim, type SwarmState } from './fold.ts'

/** How many ended calls an agent's trail keeps, and how many failures its errs keep. */
export const TRAIL_KEEP = 8
export const ERRS_KEEP = 3
export const MAX_ERROR_TEXT = 160

export function foldAgentTool(state: SwarmState, e: SwarmEvent, at: number, who: string): void {
  if (e.type !== 'agent.tool') return
  const d = e.data
  const a = agentOf(state, who, at)
  if (d.phase === 'start') revive(a, at)
  const kind: ToolKind = isOneOf(TOOL_KINDS, d.kind) ? d.kind : 'other'
  const subject = text(d.subject, 80)
  if (d.phase === 'start') {
    a.tools[kind]++
    a.openTools++
    if ((kind === 'read' || kind === 'edit') && subject !== '' && !a.files.includes(subject) && a.files.length < MAX_FILES) {
      a.files.push(subject)
    }
    if (kind === 'edit' && subject !== '' && isSafeKey(subject)) {
      const list = Object.hasOwn(state.edits, subject) ? state.edits[subject]! : (state.edits[subject] = [])
      list.push({ agent: a.id, at })
      trim(list, MAX_EDITS)
    }
    // An edit start re-arms nothing by itself: only an edit that goes ahead (its end, below) does.
    if (a.stuckBy?.on === true && kind !== 'edit' && a.stuckBy.p === 'repeating' && subject !== a.stuckBy.s) a.stuckBy.on = false
  } else {
    a.openTools = Math.max(0, a.openTools - 1)
    const failed = d.isError === true
    const tool = text(d.tool, 80)
    const trail = (a.trail ??= [])
    trail.push({ tool, subject, ok: !failed })
    trim(trail, TRAIL_KEEP)
    if (failed) {
      a.errors++
      a.errorsInRow++
      const errs = (a.errs ??= [])
      errs.push({ tool, subject, text: text(d.error, MAX_ERROR_TEXT), at })
      trim(errs, ERRS_KEEP)
      if (kind === 'edit') dropFailedEdit(state, a.id, subject)
    } else {
      a.errorsInRow = 0
      if (a.stuckBy !== undefined && (a.stuckBy.p === 'failing' || kind === 'edit')) a.stuckBy.on = false
    }
  }
  a.lastActivity = at
}
