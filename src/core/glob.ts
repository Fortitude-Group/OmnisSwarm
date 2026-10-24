/**
 * The scope fence's path patterns (spec section 3.1). Pure and mod-safe: no Node. A pattern is only ever matched,
 * never turned into a path, and the matcher uses no regular expressions, so a hostile pattern can't run long.
 */

export const MAX_PATTERN = 200
const ALLOWED = /^[A-Za-z0-9._/*?@+ -]+$/

/** Null when `p` is a usable pattern, otherwise why it isn't. */
export function validPattern(p: string): string | null {
  if (p.length < 1 || p.length > MAX_PATTERN) return `must be 1 to ${MAX_PATTERN} characters`
  if (p.includes('\\')) return 'must use / between folders, not \\'
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return 'must be relative to the repo root: no leading / and no drive letter'
  if (!ALLOWED.test(p)) return 'can only use letters, digits and . _ / * ? @ + - and spaces'
  const segments = p.split('/')
  if (segments.includes('..')) return "can't have a .. segment"
  // A trailing slash leaves one empty last segment, which means "everything under"; any other empty or `.` segment is a typo.
  if (segments.some((s, i) => (s === '' && i !== segments.length - 1) || s === '.')) return "can't have an empty or . segment"
  return null
}

/** `*` any run of characters, `?` one character. `*` and `?` never see a `/`: callers pass one segment. */
function segmentMatches(pat: string, text: string): boolean {
  let p = 0
  let t = 0
  let star = -1
  let resume = 0
  while (t < text.length) {
    if (p < pat.length && (pat[p] === '?' || pat[p] === text[t])) {
      p++
      t++
    } else if (p < pat.length && pat[p] === '*') {
      star = p++
      resume = t
    } else if (star >= 0) {
      p = star + 1
      t = ++resume
    } else {
      return false
    }
  }
  while (p < pat.length && pat[p] === '*') p++
  return p === pat.length
}

/** `**` as a whole segment matches zero or more segments; every other segment matches one. */
function segmentsMatch(pat: readonly string[], path: readonly string[]): boolean {
  // reach[j]: the pattern segments consumed so far can have consumed exactly path[0..j).
  let reach = new Array<boolean>(path.length + 1).fill(false)
  reach[0] = true
  for (const seg of pat) {
    const next = new Array<boolean>(path.length + 1).fill(false)
    if (seg === '**') {
      let any = false
      for (let j = 0; j <= path.length; j++) {
        any ||= reach[j]!
        next[j] = any
      }
    } else {
      for (let j = 0; j < path.length; j++) if (reach[j] && segmentMatches(seg, path[j]!)) next[j + 1] = true
    }
    reach = next
  }
  return reach[path.length]!
}

/**
 * True when `rel` (a `/`-separated path relative to the repo root) matches any pattern. A trailing `/` means the folder
 * and everything under it. `fold` compares without regard to case. A path that climbs out with `..` never matches.
 */
export function matchesAny(patterns: readonly string[], rel: string, fold: boolean): boolean {
  const lower = (s: string): string => (fold ? s.toLowerCase() : s)
  const path = lower(rel).split('/').filter(s => s !== '' && s !== '.')
  if (path.length === 0 || path.includes('..')) return false
  for (const raw of patterns) {
    const pat = lower(raw).split('/')
    if (pat[pat.length - 1] === '') pat[pat.length - 1] = '**'
    if (segmentsMatch(pat, path)) return true
  }
  return false
}
