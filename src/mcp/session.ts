/** Per-session swarm state: which swarm this server is working in, and its folded state held between calls. */
import { readCurrent, writeCurrent } from '../core/log.ts'
import { advance, loadState, type Loaded } from '../core/snapshot.ts'
import { announceSwarm, publishCurrent, uniqueSwarmId } from '../core/swarm.ts'
import { InputError } from './validate.ts'

const stamp = (d: Date): string => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)

export class Session {
  readonly root: string
  readonly #load: (root: string, id: string) => Loaded
  readonly #held = new Map<string, Loaded>()
  /** The swarm this server started or adopted. Other sessions in the same project may share `current`. */
  #mine: string | null = null
  /** True only when this server started `#mine`. An adopted swarm belongs to another session and is never ended or renamed here. */
  #owned = false

  /** `load` is only replaced in tests, to count full loads. */
  constructor(root: string, load: (root: string, id: string) => Loaded = loadState) {
    this.root = root
    this.#load = load
  }

  /** True when this session started the swarm it is in. */
  get owned(): boolean {
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

  /** My live swarm, adopting `current` while I have none (unless `adopt` is false). */
  mySwarm(adopt = true): string | null {
    if (this.#mine !== null && this.hasEnded(this.#mine)) this.letGo()
    if (this.#mine === null && adopt) {
      const c = readCurrent(this.root)
      if (c !== null && !this.hasEnded(c)) {
        this.#mine = c
        this.#owned = false
      }
    }
    return this.#mine
  }

  /** Records that this session started swarm `id`. */
  begin(id: string): void {
    this.#mine = id
    this.#owned = true
  }

  /** Forgets the current swarm without ending it. */
  letGo(): void {
    this.#mine = null
    this.#owned = false
  }

  /** My live swarm, starting an implicit one if there is none. */
  swarmOrCreate(now: Date): string {
    const id = this.mySwarm()
    if (id !== null) return id
    const root = this.root
    const idHint = `session-${stamp(now)}`
    const current = readCurrent(root)
    const claimed = uniqueSwarmId(root, idHint)
    announceSwarm(root, claimed, { src: 'mcp', now })
    if (current !== null && this.hasEnded(current)) {
      // current names an ended swarm: replace it, as an explicit init would
      writeCurrent(root, claimed)
      this.#mine = claimed
    } else {
      // Another session may publish first; then we adopt its swarm and don't own it.
      this.#mine = publishCurrent(root, claimed)
    }
    this.#owned = this.#mine === claimed
    return this.#mine
  }

  runningSwarm(): string {
    const id = this.mySwarm()
    if (id === null) throw new InputError('No swarm is running. Call omnis_swarm_init first.')
    return id
  }
}
