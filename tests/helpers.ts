import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeEvent, type EventData, type EventType, type Source, type SwarmEvent } from '../src/core/events.ts'

const BASE = Date.parse('2026-10-21T10:00:00.000Z')

/** A fresh empty project folder in the OS temp dir. */
export const tmpRoot = (): string => mkdtempSync(join(tmpdir(), 'omnis-'))

/** Milliseconds for `sec` seconds after the fixed test epoch. */
export const at = (sec: number): number => BASE + sec * 1000

/** A valid event at `atSec` seconds after the test epoch. */
export function ev<K extends EventType>(
  type: K,
  data: EventData[K],
  opts: { agent?: string; atSec?: number; swarm?: string; src?: Source } = {},
): SwarmEvent<K> {
  return makeEvent({
    type,
    data,
    swarm: opts.swarm ?? 's1',
    src: opts.src ?? 'recorder',
    ...(opts.agent !== undefined && { agent: opts.agent }),
    now: new Date(at(opts.atSec ?? 0)),
  })
}
