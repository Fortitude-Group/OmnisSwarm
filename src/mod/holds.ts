/** The clash guard's file holds (spec section 2.1). Pure and mod-safe; node:test covers it. */
import { cleanPath } from './record-events.ts'

export const HOLD_IDLE_MS = 600_000
export const BLOCK_DEDUPE_MS = 60_000
const SHOWN_MAX = 80
/** Past this many holds, idle ones are swept on the next take. */
const SWEEP_AT = 256

export const CLASH_SETTINGS = ['block', 'warn', 'off'] as const
export type ClashSetting = (typeof CLASH_SETTINGS)[number]
export const clashSettingFrom = (x: unknown): ClashSetting => (x === 'warn' || x === 'off' ? x : 'block')

export type FilePath = { key: string; shown: string }
const DRIVE = /^[A-Za-z]:\//
const ABSOLUTE = /^([A-Za-z]:\/|\/)/

/** Drops `.`, empty segments and `..` (never above the root), keeping `/`, `C:/` or `//server/`. */
function squash(p: string): string {
  const m = /^([A-Za-z]:\/|\/\/[^/]+\/|\/)?(.*)$/.exec(p)!
  const out: string[] = []
  for (const part of (m[2] ?? '').split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return (m[1] ?? '') + out.join('/')
}

/**
 * The path a file tool names, as a hold key and as shown to a person. Relative paths resolve against the cwd, `\` becomes
 * `/`, and the key folds case when the cwd has a drive letter (the mod can't tell the platform).
 */
export function normalisePath(raw: unknown, cwd: string): FilePath | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const base = squash(cwd.replace(/\\/g, '/'))
  const fold = DRIVE.test(base)
  // \\?\UNC\host\share is \\host\share; \\?\C:\ and \\.\C:\ are C:\.
  let p = raw.trim().replace(/\\/g, '/').replace(/^\/\/\?\/UNC\//i, '//').replace(/^\/\/[?.]\//, '')
  // Git Bash writes C:/x as /c/x; only a drive-letter cwd tells us that is what it means.
  if (fold) p = p.replace(/^\/([A-Za-z])(?=\/|$)/, '$1:')
  const full = squash(ABSOLUTE.test(p) ? p : `${base}/${p}`)
  const key = fold ? full.toLowerCase() : full
  const baseKey = fold ? base.toLowerCase() : base
  const prefix = baseKey.endsWith('/') ? baseKey : `${baseKey}/`
  const inside = key.startsWith(prefix) && key.length > prefix.length
  return { key, shown: cleanPath(inside ? full.slice(prefix.length) : full, SHOWN_MAX) }
}

type Hold = { holder: string; lastAt: number }

export class Holds {
  #holds = new Map<string, Hold>()
  #told = new Map<string, number>()

  /** The live holder of `key`; an idle hold is let go first. */
  #holderOf(key: string, now: number): string | null {
    const h = this.#holds.get(key)
    if (h === undefined) return null
    if (now - h.lastAt >= HOLD_IDLE_MS) {
      this.#holds.delete(key)
      return null
    }
    return h.holder
  }

  /** The live holder `agent` would clash with by editing `key` (null for the lead), or null. */
  clashWith(key: string, agent: string | null, now: number): string | null {
    const holder = this.#holderOf(key, now)
    return holder !== null && holder !== agent ? holder : null
  }

  /** A subagent's edit went ahead: take the hold, or refresh its own. The lead never holds, and another live holder keeps it. */
  take(key: string, agent: string | null, now: number): void {
    if (agent === null) return
    const holder = this.#holderOf(key, now)
    if (holder !== null && holder !== agent) return
    if (this.#holds.size >= SWEEP_AT) for (const k of [...this.#holds.keys()]) this.#holderOf(k, now)
    this.#holds.set(key, { holder: agent, lastAt: now })
  }

  /**
   * Like take, but returns an undo: the edit is not yet known to go ahead, so the hold is reserved at once (no await between
   * the clash check and this) and the undo puts back what was there if the edit is then refused or fails.
   */
  reserve(key: string, agent: string | null, now: number): () => void {
    if (agent === null) return () => undefined
    const before = this.#holds.get(key)
    this.take(key, agent, now)
    const mine = this.#holds.get(key)
    return () => {
      if (this.#holds.get(key) !== mine) return
      if (before !== undefined && before.holder === agent) this.#holds.set(key, before)
      else this.#holds.delete(key)
    }
  }

  /** The holder finished: every hold it had ends. */
  releaseAll(agent: string): void {
    for (const [k, h] of this.#holds) if (h.holder === agent) this.#holds.delete(k)
  }

  /** True at most once per agent and path in BLOCK_DEDUPE_MS: whether this refusal or warning is recorded. */
  shouldRecord(agent: string, key: string, now: number): boolean {
    for (const [k, t] of this.#told) if (now - t >= BLOCK_DEDUPE_MS) this.#told.delete(k)
    const id = `${agent}\n${key}`
    if (this.#told.has(id)) return false
    this.#told.set(id, now)
    return true
  }
}
