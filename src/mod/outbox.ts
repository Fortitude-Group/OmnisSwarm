/** The recorder's in-flight cap and drop counter (spec section 6). Pure and mod-safe; node:test covers it. */
import { MAX_IN_FLIGHT } from '../core/recording.ts'

export class Outbox {
  readonly limit: number
  inFlight = 0
  /** Events lost since the last call that got a slot. */
  dropped = 0

  constructor(limit = MAX_IN_FLIGHT) {
    this.limit = limit
  }

  /** Reserves a slot and hands back the drop count to carry on this call (then cleared), or null when full (the event is counted as dropped). */
  take(): number | null {
    if (this.inFlight >= this.limit) {
      this.dropped++
      return null
    }
    this.inFlight++
    const carried = this.dropped
    this.dropped = 0
    return carried
  }

  /** A call settled. A failed one counts itself and whatever it carried as dropped. */
  settle(ok: boolean, carried: number): void {
    this.inFlight = Math.max(0, this.inFlight - 1)
    if (!ok) this.dropped += 1 + carried
  }

  /** Counts events lost before they could be sent. */
  lose(n = 1): void {
    this.dropped += n
  }
}
