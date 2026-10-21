/**
 * Keeps the model and other plugins off the internal omnis_record and omnis_feed tools (spec section 6).
 * The server must list them for $.mcp.call to reach them, so they can't be hidden, only deferred and refused.
 * next.origin is set by the host: the model's call reads { plugin: 'engine' }, our own reads our plugin name.
 *
 * INTERNAL_TOOL matches every server alias, including the bare `mcp__omnis-swarm__` name used when the server is also
 * registered in .mcp.json. It therefore also blocks another plugin's own `*__omnis_record`; that over-block is accepted.
 * The guard is not the only defence: the server validates omnis_record input itself (Task 6).
 */
import type { On } from 'claude-code'
import { INTERNAL_TOOL, guardVerdict } from '../core/recording.ts'

export const DENY_REASON =
  'omnis_record and omnis_feed are internal to the omnis-swarm plugin and only its own hooks may call them. Use the public omnis_* tools instead.'
export const INTERNAL_DESCRIPTION = 'Internal to the omnis-swarm plugin. Not for use: calls from anywhere but the plugin itself are refused.'

export function registerGuard(on: On): void {
  on('tool.check', ($, e, next) =>
    guardVerdict(e.tool, next.origin.plugin, $.plugin.name) === 'deny'
      ? { decision: 'deny' as const, reason: DENY_REASON }
      : next(e),
  ).catch(($, e, next) => (INTERNAL_TOOL.test(e.tool) ? { decision: 'deny' as const, reason: DENY_REASON } : next(e)))

  on('tool.describe', async ($, e, next) => {
    const described = await next(e)
    return INTERNAL_TOOL.test(e.tool) ? { description: INTERNAL_DESCRIPTION, isDeferred: true } : described
  })
}
