/**
 * Keeps the model and other plugins off the internal omnis_record and omnis_feed tools (spec section 6).
 * The server must list them for $.mcp.call to reach them, so they can't be hidden, only deferred and refused.
 * next.origin is set by the host: the model's call reads { plugin: 'engine' }, our own reads our plugin name.
 *
 * Name matching has two known edges:
 * - If the server is also registered directly in .mcp.json, the tool is called `mcp__omnis-swarm__omnis_record`
 *   (no `plugin_` segment). BARE_INTERNAL_TOOL covers that.
 * - INTERNAL_TOOL leaves the plugin segment open, so another plugin's own `mcp__plugin_<x>__omnis_record` is
 *   denied to its model as well. That over-block is accepted: a rename-proof match matters more here.
 * The guard is not the only defence: the server validates omnis_record input itself (Task 6).
 */
import type { On } from 'claude-code'
import { INTERNAL_TOOL, guardVerdict } from '../core/recording.ts'

export const DENY_REASON =
  'omnis_record and omnis_feed are internal to the omnis-swarm plugin and only its own hooks may call them. Use the public omnis_* tools instead.'
export const INTERNAL_DESCRIPTION = 'Internal to the omnis-swarm plugin. Not for use: calls from anywhere but the plugin itself are refused.'

const BARE_INTERNAL_TOOL = /^mcp__omnis-swarm__omnis_(record|feed)$/

function isInternal(tool: string): boolean {
  return INTERNAL_TOOL.test(tool) || BARE_INTERNAL_TOOL.test(tool)
}

function verdict(tool: string, origin: string, self: string): 'pass' | 'deny' {
  return guardVerdict(tool, origin, self) === 'deny' || (BARE_INTERNAL_TOOL.test(tool) && origin !== self) ? 'deny' : 'pass'
}

export function registerGuard(on: On): void {
  on('tool.check', ($, e, next) =>
    verdict(e.tool, next.origin.plugin, $.plugin.name) === 'deny'
      ? { decision: 'deny' as const, reason: DENY_REASON }
      : next(e),
  ).catch(($, e, next) => (isInternal(e.tool) ? { decision: 'deny' as const } : next(e)))

  on('tool.describe', async ($, e, next) => {
    const described = await next(e)
    return isInternal(e.tool) ? { description: INTERNAL_DESCRIPTION, isDeferred: true } : described
  })
}
