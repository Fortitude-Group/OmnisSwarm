/**
 * Gate wording that the server (src/mcp/gate/gate.ts) and the mod's gate guard both print, so the two can't drift.
 * Pure and mod-safe: no node: imports.
 */
export const PINNED_WHY = 'the gate changed since the task was created'

/** A gate refused before it ran, as the reply to omnis_task_update(done). `shown` is the command as already clipped and redacted. */
export const refusedText = (id: string, why: string, shown: string, state: string): string => `Gate failed for ${id} (${why}, 0 s): ${shown}. The task stays ${state}.`
