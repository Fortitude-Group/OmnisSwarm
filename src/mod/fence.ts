/** The scope fence's pure parts (spec section 3): the setting, the server's answer, the cache, the verdict and the texts. Mod-safe. */
import { clip } from '../core/events.ts'
import { matchesAny } from '../core/glob.ts'
import { BLOCK_DEDUPE_MS, normalisePath } from './holds.ts'

export const FENCE_CACHE_MS = 10_000
export const FENCE_ASK_MS = 2_000
const PATTERNS_MAX = 120

export const FENCE_SETTINGS = ['block', 'warn', 'off'] as const
export type FenceSetting = (typeof FENCE_SETTINGS)[number]
export const fenceSettingFrom = (x: unknown): FenceSetting => (x === 'warn' || x === 'off' ? x : 'block')

export const SKIP_GATE_REFUSAL = 'Only main can skip the gate. Report the problem to main instead.'

export const fenceRefusal = (path: string, tasks: readonly string[], owns: readonly string[]): string =>
  `${path} is outside the files your task owns (${tasks.join(', ')}: ${clip(owns.join(', '), PATTERNS_MAX)}). Ask main to widen the task, or leave it to the agent that owns it.`
export const fenceWarn = (agent: string, path: string, tasks: readonly string[]): string =>
  `[OmnisSwarm scope fence] ${agent} edited ${path}, outside ${tasks.join(', ')}'s files.`

/** omnis_fence's answer. */
export type Fence = { fenced: false } | { fenced: true; tasks: string[]; owns: string[]; roots: string[] }

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
  return { fenced: true, tasks: [...o.tasks], owns: [...o.owns], roots: [...o.roots] }
}

const DRIVE = /^[A-Za-z]:\//
const ABSOLUTE = /^([A-Za-z]:\/|\/)/

/**
 * Whether the edit of `key` (a normalisePath key) is inside the fence. The path is made relative to the longest root it
 * sits under; under no root it passes. Matching folds case when that root has a drive letter.
 */
export function fenceAllows(fence: Fence, key: string): boolean {
  if (!fence.fenced) return true
  let best: { prefix: string; fold: boolean } | null = null
  for (const raw of fence.roots) {
    const root = normalisePath(raw, '/')?.key
    if (root === undefined || !ABSOLUTE.test(root)) continue
    const fold = DRIVE.test(root)
    const base = fold ? root.toLowerCase() : root
    const prefix = base.endsWith('/') ? base : `${base}/`
    const path = fold ? key.toLowerCase() : key
    if ((path === base || path.startsWith(prefix)) && (best === null || prefix.length > best.prefix.length)) best = { prefix, fold }
  }
  if (best === null) return true
  const path = best.fold ? key.toLowerCase() : key
  return matchesAny(fence.owns, path.slice(best.prefix.length), best.fold)
}

/** Each agent's answer for FENCE_CACHE_MS. clear() drops them all, and an answer asked for before a clear is not kept. */
export class FenceCache {
  #held = new Map<string, { fence: Fence; at: number }>()
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

  /** Keeps `fence`, unless the cache was cleared since generation `asked` was read. */
  set(agent: string, fence: Fence, now: number, asked: number): void {
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
