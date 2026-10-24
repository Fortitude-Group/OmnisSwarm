/** The scope fence's pure parts (spec section 3): the setting, the server's answer, the cache, the verdict and the texts. Mod-safe. */
import { clip } from '../core/events.ts'
import { matchesAny } from '../core/glob.ts'
import { BLOCK_DEDUPE_MS, normalisePath } from './holds.ts'

export const FENCE_CACHE_MS = 10_000
export const FENCE_ASK_MS = 2_000
const PATTERNS_MAX = 120
/** Longer or deeper paths are refused before matching (review L7); Windows' own limit is far above any real file. */
export const PATH_MAX = 4096
export const SEGMENTS_MAX = 256

export const FENCE_SETTINGS = ['block', 'warn', 'off'] as const
export type FenceSetting = (typeof FENCE_SETTINGS)[number]
export const fenceSettingFrom = (x: unknown): FenceSetting => (x === 'warn' || x === 'off' ? x : 'block')

export const SKIP_GATE_REFUSAL = 'Only main can skip the gate. Report the problem to main instead.'
export const OWNS_REFUSAL = 'Only main can change what a task owns. Ask main instead.'

export const fenceRefusal = (path: string, tasks: readonly string[], owns: readonly string[]): string =>
  `${path} is outside the files your task owns (${tasks.join(', ')}: ${clip(owns.join(', '), PATTERNS_MAX)}). Ask main to widen the task, or leave it to the agent that owns it.`
export const fenceWarn = (agent: string, path: string, tasks: readonly string[]): string =>
  `[OmnisSwarm scope fence] ${agent} edited ${path}, outside ${tasks.join(', ')}'s files.`

/**
 * omnis_fence's answer. `roots` holds every root in every spelling, the project's first. `home`, when present, is the
 * roots the agent may edit under (every fencing task names a worktree).
 */
export type Fence = { fenced: false } | { fenced: true; tasks: string[]; owns: string[]; roots: string[]; home?: string[] }

const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every(s => typeof s === 'string')

/** The server's reply text as a Fence, or null when it isn't one (the caller then fails open). */
export function parseFence(text: string): Fence | null {
  let x: unknown
  try {
    x = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof x !== 'object' || x === null) return null
  const o = x as Record<string, unknown>
  if (o.fenced === false) return { fenced: false }
  if (o.fenced !== true || !strings(o.tasks) || !strings(o.owns) || !strings(o.roots)) return null
  if (o.home !== undefined && !strings(o.home)) return null
  return { fenced: true, tasks: [...o.tasks], owns: [...o.owns], roots: [...o.roots], ...(o.home !== undefined && { home: [...o.home] }) }
}

const DRIVE = /^[A-Za-z]:\//
const ABSOLUTE = /^([A-Za-z]:\/|\/)/
/** \\.\ and \\?\ (any slashes): device and long-path spellings, never a scratch file. */
const DEVICE = /^[\\/]{2}[?.][\\/]/

/** A root as a key and prefix, folding case for drive letters and UNC shares. */
type Root = { base: string; prefix: string; fold: boolean }
function rootOf(raw: string): Root | null {
  const key = normalisePath(raw, '/')?.key
  if (key === undefined || !ABSOLUTE.test(key)) return null
  const fold = DRIVE.test(key) || key.startsWith('//')
  const base = fold ? key.toLowerCase() : key
  return { base, prefix: base.endsWith('/') ? base : `${base}/`, fold }
}
const under = (r: Root, key: string): boolean => {
  const path = r.fold ? key.toLowerCase() : key
  return path === r.base || path.startsWith(r.prefix)
}

/**
 * Whether the edit of `key` (a normalisePath key) is inside the fence. `raw` is the path as the tool got it and `cwd` the
 * session's folder, which counts as a spelling of the project root unless it already sits under a root.
 * - Device-form paths, and paths over PATH_MAX characters or SEGMENTS_MAX segments, are outside.
 * - The path is measured from the longest root it sits under. Under no root it passes, unless it is a UNC path.
 * - With home roots, a path under any other root is outside.
 * - Matching folds case when that root has a drive letter or is a UNC share.
 */
export function fenceAllows(fence: Fence, key: string, at: { raw?: unknown; cwd?: string | null } = {}): boolean {
  if (!fence.fenced) return true
  if (typeof at.raw === 'string' && DEVICE.test(at.raw.trim())) return false
  if (key.length > PATH_MAX || key.split('/').length > SEGMENTS_MAX) return false
  const roots: Array<Root & { home: boolean }> = []
  const homes = (fence.home ?? []).map(rootOf).filter((r): r is Root => r !== null)
  const isHome = (r: Root): boolean => fence.home === undefined || homes.some(h => h.base === r.base)
  for (const raw of fence.roots) {
    const r = rootOf(raw)
    if (r !== null) roots.push({ ...r, home: isHome(r) })
  }
  const cwd = typeof at.cwd === 'string' ? rootOf(at.cwd) : null
  const project = roots[0]
  if (cwd !== null && project !== undefined && !roots.some(r => under(r, cwd.base))) roots.push({ ...cwd, home: project.home })
  let best: (Root & { home: boolean }) | null = null
  for (const r of roots) if (under(r, key) && (best === null || r.prefix.length > best.prefix.length)) best = r
  if (best === null) return !key.startsWith('//')
  if (!best.home) return false
  const path = best.fold ? key.toLowerCase() : key
  return matchesAny(fence.owns, path.slice(best.prefix.length), best.fold)
}

/**
 * Each agent's answer for FENCE_CACHE_MS. clear() drops them all, and an answer asked for before a clear is not kept.
 * Separately, each agent's last fenced answer is kept until an unfenced one comes, for when the server can't answer (L6).
 */
export class FenceCache {
  #held = new Map<string, { fence: Fence; at: number }>()
  #last = new Map<string, Fence>()
  #generation = 0

  get generation(): number {
    return this.#generation
  }

  get(agent: string, now: number): Fence | undefined {
    const held = this.#held.get(agent)
    if (held === undefined) return undefined
    if (now - held.at >= FENCE_CACHE_MS || now < held.at) {
      this.#held.delete(agent)
      return undefined
    }
    return held.fence
  }

  /** The agent's last fenced answer, however old. */
  last(agent: string): Fence | undefined {
    return this.#last.get(agent)
  }

  /** Keeps `fence`, unless the cache was cleared since generation `asked` was read. */
  set(agent: string, fence: Fence, now: number, asked: number): void {
    if (fence.fenced) this.#last.set(agent, fence)
    else this.#last.delete(agent)
    if (asked !== this.#generation) return
    for (const [k, h] of this.#held) if (now - h.at >= FENCE_CACHE_MS) this.#held.delete(k)
    this.#held.set(agent, { fence, at: now })
  }

  clear(): void {
    this.#held.clear()
    this.#generation++
  }
}

/** True at most once per agent and path in BLOCK_DEDUPE_MS: whether this refusal or warning is recorded. */
export class FenceTold {
  #told = new Map<string, number>()

  should(agent: string, key: string, now: number): boolean {
    for (const [k, t] of this.#told) if (now - t >= BLOCK_DEDUPE_MS) this.#told.delete(k)
    const id = `${agent}\n${key}`
    if (this.#told.has(id)) return false
    this.#told.set(id, now)
    return true
  }
}
