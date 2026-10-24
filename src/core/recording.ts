/** What the recorder mod sends to the server's internal omnis_record tool, and the rule that guards it. Pure and mod-safe: no Node. */
import type { EventData } from './events.ts'

/** The only event types omnis_record accepts. The server writes the swarm, memory and task events itself. */
export const RECORDER_TYPES = ['agent.started', 'agent.finished', 'agent.usage', 'agent.tool', 'message.sent', 'session.measure', 'budget.set', 'guard.warned', 'guard.nudged', 'guard.blocked', 'clash.blocked', 'agent.stuck', 'fence.blocked'] as const
export type RecorderType = (typeof RECORDER_TYPES)[number]

export const RECORD_TOOL = 'omnis_record'

/** The internal tool the pane pulls the swarm from. */
export const FEED_TOOL = 'omnis_feed'

/** The internal tool the pane replays a finished swarm from. */
export const REPLAY_TOOL = 'omnis_replay'

/** The internal tool that renders a swarm to a GIF. */
export const EXPORT_TOOL = 'omnis_export'

/** The internal tool that writes a run report. */
export const REPORT_TOOL = 'omnis_report'

/** The internal tool the mod asks which files an agent's tasks let it edit. */
export const FENCE_TOOL = 'omnis_fence'

/** The server's key under mcpServers in plugin.json, as $.mcp.connect takes it. */
export const SERVER_KEY = 'omnis-swarm'

/** Past this many omnis_record calls in flight, the recorder drops events and counts them (spec section 6). */
export const MAX_IN_FLIGHT = 64

/** A Claude Code session id, as $.session.id() gives it (the transcript file's name, a UUID). */
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/

/**
 * The internal tools under any server alias: `mcp__plugin_<plugin>_<server>__omnis_record` (plugin-bundled; a
 * marketplace install may rename the plugin segment) or `mcp__omnis-swarm__omnis_record` (registered in .mcp.json).
 * Another plugin's own tool ending the same way is blocked too; that over-block is accepted.
 */
export const INTERNAL_TOOL = /^mcp__.+__omnis_(record|feed|replay|export|report|fence)$/

/** A plugin name without an `@marketplace` suffix. Plugin names can't contain `@`, so the part before it is the name. */
const bareName = (name: string): string => name.split('@', 1)[0] ?? ''

/**
 * An internal tool may be called only from this plugin's own hooks. Every other tool is not the guard's business.
 * Both names come from the host: $.plugin.name and next.origin.plugin are the manifest name today, and the match
 * also holds if either ever carries the install id (`omnis-swarm@omnis-swarm`).
 */
export function guardVerdict(tool: string, origin: string, self: string): 'pass' | 'deny' {
  if (!INTERNAL_TOOL.test(tool)) return 'pass'
  const name = bareName(self)
  return name !== '' && bareName(origin) === name ? 'pass' : 'deny'
}

export type RecordBody<K extends RecorderType = RecorderType> = {
  [T in K]: { type: T; agent?: string; data: EventData[T] }
}[K]

/** One omnis_record call. `ts` is the mod's clock at hook time; `dropped` counts events lost since the last call that got through. */
export type RecordArgs = RecordBody & { sessionId: string; ts: string; dropped?: number }
