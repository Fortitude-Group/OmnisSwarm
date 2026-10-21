/** Per-session swarm state: which swarm this server is working in, and its folded state held between calls. */
import { makeEvent } from '../core/events.ts'
import { appendEvent, readCurrent, writeCurrent } from '../core/log.ts'
import { SESSION_ID } from '../core/recording.ts'
import { advance, loadState, type Loaded } from '../core/snapshot.ts'
import { announceSwarm, publishCurrent, sessionKey, swarmOwner, uniqueSwarmId } from '../core/swarm.ts'
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
  /** Set when a second, different session id arrives: log-based ownership is then off for this process. */
  #conflict = false
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

  /** The key stored in swarm logs for this session, or null while the id is unknown or in conflict. */
  get sessionKey(): string | null {
    return this.#sessionId === null || this.#conflict ? null : sessionKey(this.#sessionId)
  }

  /**
   * Records which Claude Code session this server serves. One server process serves one session: a later,
   * different id is a conflict, so it warns once and owns nothing from the log from then on (fail closed).
   * When the id first arrives and this process already owns a swarm it started before knowing the id,
   * the swarm is re-announced with the session key so a restart can still find its owner.
   */
  noteSession(id: string): void {
    if (!SESSION_ID.test(id)) return
    if (this.#sessionId === null) {
      this.#sessionId = id
      const mine = this.#mine
      if (mine !== null && this.#owned) {
        const { swarm } = this.state(mine).state
        const stamped = appendEvent(this.root, makeEvent({
          type: 'swarm.started',
          swarm: mine,
          src: 'mcp',
          data: {
            name: swarm.name,
            topology: swarm.topology,
            ...(swarm.goal !== null && { goal: swarm.goal }),
            implicit: swarm.implicit,
            session: sessionKey(id),
          },
        }))
        if (!stamped) process.stderr.write(`omnis: could not stamp the session on swarm ${mine}; it will not be claimable after a restart\n`)
        this.#ownerRead = mine
      }
    } else if (id !== this.#sessionId && !this.#conflict) {
      this.#conflict = true
      process.stderr.write('omnis: a second, different Claude session id reached this server; it will not claim swarm ownership from the log.\n')
    }
  }

  /** True when this session started the swarm it is in: in this process, or before a restart by the session id in the swarm's log. */
  get owned(): boolean {
    const id = this.#mine
    const key = this.sessionKey
    if (!this.#owned && id !== null && key !== null && this.#ownerRead !== id) {
      this.#ownerRead = id
      this.#owned = swarmOwner(this.root, id) === key
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
        const key = this.sessionKey
        const ours = key !== null && swarmOwner(this.root, c) === key
        if (adopt || ours) {
          this.#mine = c
          this.#owned = ours
          this.#ownerRead = this.sessionKey === null ? null : c
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
    const key = this.sessionKey
    const idHint = sid !== null ? `session-${sid.slice(0, 8)}` : `session-${stamp(now)}`
    const current = readCurrent(root)
    const claimed = uniqueSwarmId(root, idHint)
    announceSwarm(root, claimed, { src: 'mcp', now, ...(key !== null && { session: key }) })
    if (current !== null && this.hasEnded(current)) {
      // current names an ended swarm: replace it, as an explicit init would
      writeCurrent(root, claimed)
      this.#mine = claimed
    } else {
      // Another session may publish first; then we adopt its swarm and don't own it.
      this.#mine = publishCurrent(root, claimed)
    }
    this.#owned = this.#mine === claimed
    this.#ownerRead = key === null ? null : this.#mine
    return this.#mine
  }

  runningSwarm(): string {
    const id = this.mySwarm()
    if (id === null) throw new InputError('No swarm is running. Call omnis_swarm_init first.')
    return id
  }
}
