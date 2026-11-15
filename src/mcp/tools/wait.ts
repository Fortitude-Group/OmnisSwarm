/**
 * omnis_wait: answers after `ms` milliseconds (at most WAIT_MAX_MS), or at once when the call is cancelled. The spawn
 * hold's hook waits in these calls: the engine stops a hook's 10 s budget while a `$` call is in flight, but not through
 * its own clock waits (docs/superpowers/specs/2026-11-15-spawn-hold-design.md). Internal: the mod's guard refuses it to
 * the model, and it does nothing but wait.
 */
import { WAIT_TOOL } from '../../core/recording.ts'
import type { Args, AsyncToolDef, CallContext, ToolResult } from '../protocol.ts'
import { InputError } from '../validate.ts'

export const WAIT_MAX_MS = 5000

export function createWaitTools(): AsyncToolDef[] {
  return [{
    name: WAIT_TOOL,
    description: 'Internal to the omnis-swarm plugin: answers after the given milliseconds, so a held Agent spawn waits on the server. Calls from the model are refused.',
    inputSchema: {
      type: 'object',
      properties: { ms: { type: 'integer', minimum: 1, maximum: WAIT_MAX_MS } },
      required: ['ms'],
      additionalProperties: false,
    },
    handler: (args: Args, ctx?: CallContext): Promise<ToolResult> => {
      const ms = args.ms
      if (typeof ms !== 'number' || !Number.isSafeInteger(ms) || ms < 1 || ms > WAIT_MAX_MS) {
        return Promise.reject(new InputError(`ms must be a whole number from 1 to ${WAIT_MAX_MS}`))
      }
      return new Promise(resolve => {
        const done = (): void => {
          clearTimeout(timer)
          ctx?.signal.removeEventListener('abort', done)
          resolve({ text: 'ok' })
        }
        const timer = setTimeout(done, ms)
        if (ctx?.signal.aborted === true) done()
        else ctx?.signal.addEventListener('abort', done, { once: true })
      })
    },
  }]
}
