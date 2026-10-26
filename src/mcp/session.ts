/** Per-session swarm state: which swarm this server is working in, and its folded state held between calls. */
import { existsSync } from 'node:fs'
import { NAME, makeEvent, type EventData } from '../core/events.ts'
import { LEAD, type AgentState, type SwarmState } from '../core/fold.ts'
import { appendEvent, readCurrent, swarmLogPath, writeCurrent } from '../core/log.ts'
import { SESSION_ID } from '../core/recording.ts'
import { advance, loadState, type Loaded } from '../core/snapshot.ts'
import { announceSwarm, publishCurrent, recentSwarmIds, sessionKey, swarmOwner, uniqueSwarmId } from '../core/swarm.ts'
import { InputError } from './validate.ts'

const stamp = (d: Date): string => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)

export type AgentStart = EventData['agent.started']
/** The most agent starts a session remembers; the oldest go first. */
export const MAX_KNOWN_STARTS = 200
/** SendMessage may add a ` [id]` tag after the name, as the fold's resolve strips. */
const bareName = (to: string): string => to.replace(/\s+\[[^\]\s]+\]$/, '').trim()

/** An agent's start as its folded state holds it, fit to write again. */
function startOf(s: SwarmState, a: AgentState): AgentStart {
  return {
    name: s.byName[a.name] === a.id ? a.name : '',
    role: a.role === 'unknown' ? '' : a.role,
    description: a.description,
    parent: NAME.test(a.parent) ? a.parent : LEAD,
  }
}

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
  /**
   * Set when a second, different session id arrives (after /clear or a resume the process carries on under a new id).
   * Log-based ownership is then off for this process, but the session still has an id, so it never adopts a foreign swarm.
   */
  #conflict = false
  /** The newest valid session id seen: after a second id, a new implicit swarm is named after it. */
  #latestId: string | null = null
  /** The swarm whose owner was last read from its log, so each swarm's log is read once per session id. */
  #ownerRead: string | null = null
  /** The session key for which the swarms folder was already searched for this session's own swarm. */
  #searched: string | null = null
  /**
   * Agent id to its start, for agents this session has seen start. The recorder announces an agent once per Claude
   * session, so an agent resumed after its swarm ended reaches the next swarm unannounced; this is how it gets named.
   */
  readonly #known = new Map<string, AgentStart>()

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
   * What a second id means for the session's own swarm: the swarm this process started or claimed stays its own;
   * once that ends, the next implicit swarm is named after the newest id but carries no session key. A foreign
   * swarm is never adopted, because adoption needs no id ever to have been known (see mySwarm).
   * When the id first arrives and this process already owns a swarm it started before knowing the id,
   * the swarm is re-announced with the session key so a restart can still find its owner.
   */
  noteSession(id: string): void {
    if (!SESSION_ID.test(id)) return
    this.#latestId = id
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
      // Keep this session's live swarm for good, but at most one other (a pane may hint at old swarms).
      for (const key of [...this.#held.keys()]) if (key !== this.#mine) this.#held.delete(key)
      this.#held.set(id, loaded)
      return loaded
    }
    advance(this.root, held)
    return held
  }

  hasEnded(id: string): boolean {
    return this.state(id).state.swarm.endedAt !== null
  }

  /**
   * My live swarm. While I have none I adopt `current`. A session whose id is known adopts only a swarm its log says it
   * started, so its recorder events and its tool calls share one swarm and never land in another session's. That holds
   * after a second, conflicting id too: it adopts nothing then. Only a session that never learned an id (no recorder)
   * adopts any live `current`, and only when `adopt` is true.
   */
  mySwarm(adopt = true): string | null {
    if (this.#mine !== null && this.hasEnded(this.#mine)) this.letGo()
    if (this.#mine === null) {
      const c = readCurrent(this.root)
      if (c !== null && !this.hasEnded(c)) {
        const key = this.sessionKey
        const ours = key !== null && swarmOwner(this.root, c) === key
        if (ours || (adopt && this.#sessionId === null)) {
          this.#mine = c
          this.#owned = ours
          this.#ownerRead = this.sessionKey === null ? null : c
        }
      }
      if (this.#mine === null) this.#findOwn()
    }
    return this.#mine
  }

  /**
   * After a restart `current` may name another session's swarm. Looks, once per session key, for a live swarm this
   * session started: the deterministic implicit name first, then the newest few logs by modification time.
   */
  #findOwn(): void {
    const key = this.sessionKey
    if (key === null || this.#searched === key) return
    this.#searched = key
    const live = (id: string): boolean => swarmOwner(this.root, id) === key && !this.hasEnded(id)
    const implicit = `session-${key.slice(0, 8)}`
    const found = (existsSync(swarmLogPath(this.root, implicit)) && live(implicit) ? implicit : null)
      ?? recentSwarmIds(this.root).find(live)
      ?? null
    if (found !== null) {
      this.#mine = found
      this.#owned = true
      this.#ownerRead = found
    }
  }

  /** Remembers an agent's start, so a later swarm it is resumed in can be told who it is. */
  noteStart(agent: string, start: AgentStart): void {
    if (agent === LEAD) return
    this.#known.delete(agent)
    this.#known.set(agent, start)
    for (const oldest of this.#known.keys()) {
      if (this.#known.size <= MAX_KNOWN_STARTS) break
      this.#known.delete(oldest)
    }
  }

  /**
   * The starts to write into `swarm` before an event from `agent` (and, for a message, to the agent named `to`): one
   * for each that this session saw start but the swarm hasn't met.
   */
  startsToCarry(swarm: string, agent: string | undefined, to?: string): Array<{ agent: string; start: AgentStart }> {
    const ids: string[] = []
    if (agent !== undefined) ids.push(agent)
    if (to !== undefined) {
      const name = bareName(to)
      const named = [...this.#known].findLast(([, s]) => s.name === name)
      if (named !== undefined) ids.push(named[0])
    }
    const out: Array<{ agent: string; start: AgentStart }> = []
    if (ids.every(id => !this.#known.has(id))) return out
    const met = this.state(swarm).state.agents
    for (const id of new Set(ids)) {
      const start = this.#known.get(id)
      const seen = Object.hasOwn(met, id) && !met[id]!.placeholder
      if (start !== undefined && !seen) out.push({ agent: id, start })
    }
    return out
  }

  /** Learns the agents of swarm `id` (best effort), so they keep their names if resumed in the next one. */
  #harvest(id: string): void {
    try {
      const s = this.state(id).state
      for (const a of Object.values(s.agents)) {
        if (a.id === LEAD || a.placeholder || !NAME.test(a.id) || this.#known.has(a.id)) continue
        if (a.role === 'unknown' && a.name === a.id) continue // never announced here either: nothing to carry
        this.noteStart(a.id, startOf(s, a))
      }
    } catch {
      // A swarm that can't be read leaves resumed agents unnamed, nothing worse.
    }
  }

  /** Records that this session started swarm `id`. */
  begin(id: string): void {
    if (this.#mine !== null && this.#mine !== id) this.#harvest(this.#mine)
    this.#mine = id
    this.#owned = true
    this.#ownerRead = id
  }

  /** Forgets the current swarm without ending it. */
  letGo(): void {
    if (this.#mine !== null) this.#harvest(this.#mine)
    this.#mine = null
    this.#owned = false
    this.#ownerRead = null
  }

  /**
   * My live swarm, starting an implicit one if there is none: `session-<first 8 of the newest id's key>`, or by time
   * before any id is known. A session with a known id leaves another session's live `current` alone.
   */
  swarmOrCreate(now: Date): string {
    const id = this.mySwarm()
    if (id !== null) return id
    const root = this.root
    const named = this.#latestId
    const key = this.sessionKey
    const idHint = named !== null ? `session-${sessionKey(named).slice(0, 8)}` : `session-${stamp(now)}`
    const current = readCurrent(root)
    const claimed = uniqueSwarmId(root, idHint)
    announceSwarm(root, claimed, { src: 'mcp', now, ...(key !== null && { session: key }) })
    if (this.#sessionId !== null && current !== null && !this.hasEnded(current)) {
      // Another session's live swarm holds `current`: this session works in its own and leaves `current` alone.
      this.#mine = claimed
    } else if (current !== null && this.hasEnded(current)) {
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
