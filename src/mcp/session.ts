/** Per-session swarm state: which swarm this server is working in, and its folded state held between calls. */
import { readCurrent, writeCurrent } from '../core/log.ts'
import { SESSION_ID } from '../core/recording.ts'
import { advance, loadState, type Loaded } from '../core/snapshot.ts'
import { announceSwarm, publishCurrent, swarmOwner, uniqueSwarmId } from '../core/swarm.ts'
import { InputError } from './validate.ts'

const stamp = (d: Date): string => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)

export class Session {
  readonly root: string
  readonly #load: (root: string, id: string) => Loaded
  readonly #held = new Map<string, Loaded>()
  /** The swarm this server started or adopted. Other sessions in the same project may share `current`. */
  #mine: string | null = null
  /** True when this session started `#mine`. An adopted swarm of another session is never ended or renamed here. */
  #owned = false
  /** The Claude Code session this server serves, learned from the recorder's first omnis_record call. */
  #sessionId: string | null = null
  /** The swarm whose owner was last read from its log, so each swarm's log is read once per session id. */
  #ownerRead: string | null = null

  /** `load` is only replaced in tests, to count full loads. */
  constructor(root: string, load: (root: string, id: string) => Loaded = loadState) {
    this.root = root
    this.#load = load
  }

  get sessionId(): string | null {
    return this.#sessionId
  }

  /** Records which Claude Code session this server serves. The first valid id wins: one server process serves one session. */
  noteSession(id: string): void {
    if (this.#sessionId === null && SESSION_ID.test(id)) this.#sessionId = id
  }

  /** True when this session started the swarm it is in: in this process, or before a restart by the session id in the swarm's log. */
  get owned(): boolean {
    const id = this.#mine
    if (!this.#owned && id !== null && this.#sessionId !== null && this.#ownerRead !== id) {
      this.#ownerRead = id
      this.#owned = swarmOwner(this.root, id) === this.#sessionId
    }
    return this.#owned
  }

  /** The folded state of swarm `id`, loaded once and then advanced by whatever was appended since. Treat it as read-only. */
  state(id: string): Loaded {
    const held = this.#held.get(id)
    if (held === undefined) {
      const loaded = this.#load(this.root, id)
      this.#held.set(id, loaded)
      return loaded
    }
    advance(this.root, held)
    return held
  }

  hasEnded(id: string): boolean {
    return this.state(id).state.swarm.endedAt !== null
  }

  /** My live swarm. While I have none I adopt `current`: always when `adopt` is true, otherwise only if its log says this session started it. */
  mySwarm(adopt = true): string | null {
    if (this.#mine !== null && this.hasEnded(this.#mine)) this.letGo()
    if (this.#mine === null) {
      const c = readCurrent(this.root)
      if (c !== null && !this.hasEnded(c)) {
        const ours = this.#sessionId !== null && swarmOwner(this.root, c) === this.#sessionId
        if (adopt || ours) {
          this.#mine = c
          this.#owned = ours
          this.#ownerRead = this.#sessionId === null ? null : c
        }
      }
    }
    return this.#mine
  }

  /** Records that this session started swarm `id`. */
  begin(id: string): void {
    this.#mine = id
    this.#owned = true
    this.#ownerRead = id
  }

  /** Forgets the current swarm without ending it. */
  letGo(): void {
    this.#mine = null
    this.#owned = false
    this.#ownerRead = null
  }

  /** My live swarm, starting an implicit one if there is none: `session-<first 8 of the session id>`, or by time before the id is known. */
  swarmOrCreate(now: Date): string {
    const id = this.mySwarm()
    if (id !== null) return id
    const root = this.root
    const sid = this.#sessionId
    const idHint = sid !== null ? `session-${sid.slice(0, 8)}` : `session-${stamp(now)}`
    const current = readCurrent(root)
    const claimed = uniqueSwarmId(root, idHint)
    announceSwarm(root, claimed, { src: 'mcp', now, ...(sid !== null && { session: sid }) })
    if (current !== null && this.hasEnded(current)) {
      // current names an ended swarm: replace it, as an explicit init would
      writeCurrent(root, claimed)
      this.#mine = claimed
    } else {
      // Another session may publish first; then we adopt its swarm and don't own it.
      this.#mine = publishCurrent(root, claimed)
    }
    this.#owned = this.#mine === claimed
    this.#ownerRead = sid === null ? null : this.#mine
    return this.#mine
  }

  runningSwarm(): string {
    const id = this.mySwarm()
    if (id === null) throw new InputError('No swarm is running. Call omnis_swarm_init first.')
    return id
  }
}
