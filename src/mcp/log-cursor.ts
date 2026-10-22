/** Byte-offset helpers over a swarm log, shared by omnis_feed and omnis_replay. */
import { closeSync, openSync, readSync } from 'node:fs'
import { LIMITS, parseLine } from '../core/events.ts'
import { MAX_READ_BYTES } from '../core/log.ts'

/** True when the byte before `offset` is a newline, so `offset` starts a line. */
export function atLineStart(file: string, offset: number): boolean {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(1)
    return readSync(fd, buf, 0, 1, offset - 1) === 1 && buf[0] === 0x0a
  } finally {
    closeSync(fd)
  }
}

/**
 * Where the log stands just after the `count`th event line at or beyond `since`, and how many bad lines came before it.
 * Walks the lines the way readEvents does, so the two agree on what is an event.
 */
export function offsetAfter(file: string, since: number, count: number): { offset: number; bad: number } {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(MAX_READ_BYTES)
    const data = buf.subarray(0, readSync(fd, buf, 0, buf.length, since))
    let from = 0
    let seen = 0
    let bad = 0
    for (let nl = data.indexOf(0x0a, from); nl !== -1; nl = data.indexOf(0x0a, from)) {
      const raw = data.subarray(from, nl)
      from = nl + 1
      if (raw.length > LIMITS.line) {
        bad++
        continue
      }
      const line = raw.toString('utf8')
      if (line.trim() === '') continue
      const parsed = parseLine(line)
      if (parsed.ok) {
        if (++seen === count) return { offset: since + from, bad }
      } else if (parsed.reason !== 'version') bad++
    }
    throw new Error('the log changed under the feed')
  } finally {
    closeSync(fd)
  }
}
