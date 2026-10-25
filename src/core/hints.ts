/** Model hints (spec 2026-10-25 section 5): from outcome rows to at most five lines for the lead. Pure. */
import type { HistoryRow } from './history.ts'

export type Tier = 1 | 2 | 3
export type Source = 'project' | 'machine'
export type HintStat = { role: string; tier: Tier; runs: number; clean: number; avgUsd: number; avgMin: number; source: Source }

export const MIN_RUNS = 5
export const CHEAPER_WITHIN = 10
export const KEEP_BELOW = 25
export const MAX_HINTS = 5
const MAX_TABLE = 40
const NAMES: Record<Tier, string> = { 1: 'Haiku', 2: 'Sonnet', 3: 'Opus' }
const ALIAS: Record<Tier, string> = { 1: 'haiku', 2: 'sonnet', 3: 'opus' }
const NO_HISTORY = 'No run history yet. Hints appear once a role has 5 or more finished runs on each of two models.'
const NO_HINTS = 'No hints yet: no role has 5 or more runs on each of two models.'

export function tierOf(model: string): Tier | null {
  const m = model.toLowerCase()
  if (m.includes('haiku')) return 1
  if (m.includes('sonnet')) return 2
  if (m.includes('opus')) return 3
  return null
}

const round = (x: number, places: number): number => Math.round(x * 10 ** places) / 10 ** places

/** Per role, its tiers' stats in tier order. Rows with an unknown model are skipped. */
function statsBy(rows: readonly HistoryRow[], source: Source): Map<string, HintStat[]> {
  const sums = new Map<string, { role: string; tier: Tier; runs: number; clean: number; usd: number; min: number }>()
  for (const r of rows) {
    const tier = tierOf(r.model)
    if (tier === null) continue
    const key = `${r.role}\u0000${tier}`
    const s = sums.get(key) ?? { role: r.role, tier, runs: 0, clean: 0, usd: 0, min: 0 }
    s.runs += 1
    s.clean += r.clean ? 1 : 0
    s.usd += r.costUsd
    s.min += r.minutes
    sums.set(key, s)
  }
  const out = new Map<string, HintStat[]>()
  for (const s of sums.values()) {
    const list = out.get(s.role) ?? []
    list.push({ role: s.role, tier: s.tier, runs: s.runs, clean: s.clean, avgUsd: round(s.usd / s.runs, 2), avgMin: round(s.min / s.runs, 1), source })
    out.set(s.role, list)
  }
  for (const list of out.values()) list.sort((a, b) => a.tier - b.tier)
  return out
}

const qualifies = (stats: readonly HintStat[]): boolean => stats.filter(s => s.runs >= MIN_RUNS).length >= 2
/** Clean rate in points. Integer maths first, so 3 of 5 is exactly 60. */
const rate = (s: HintStat): number => (s.clean * 100) / s.runs
const usd = (x: number): string => `≈$${x.toFixed(2)}`
const byRole = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** Each role's stats from the project when they qualify, else the machine when those do, else whichever has rows. */
export function hintStats(project: readonly HistoryRow[], machine: readonly HistoryRow[]): HintStat[] {
  const p = statsBy(project, 'project')
  const m = statsBy(machine, 'machine')
  const roles = [...new Set([...p.keys(), ...m.keys()])].sort(byRole)
  return roles.flatMap(role => {
    const ps = p.get(role) ?? []
    const ms = m.get(role) ?? []
    return qualifies(ps) ? ps : qualifies(ms) ? ms : ps.length > 0 ? ps : ms
  })
}

type Hint = { role: string; runs: number; text: string }

function hintFor(role: string, stats: readonly HintStat[]): Hint | null {
  const q = stats.filter(s => s.runs >= MIN_RUNS)
  if (q.length < 2) return null
  const top = q[q.length - 1]!
  const cheaper = q.slice(0, -1)
  const label = top.source === 'machine' ? ' (across projects)' : ''
  const low = cheaper.find(s => rate(s) >= rate(top) - CHEAPER_WITHIN)
  if (low !== undefined) {
    return {
      role, runs: low.runs + top.runs,
      text: `${role}: ${NAMES[low.tier]} finished clean ${low.clean} of ${low.runs} (${usd(low.avgUsd)} avg) vs ${NAMES[top.tier]} ${top.clean} of ${top.runs} (${usd(top.avgUsd)}). Try model: '${ALIAS[low.tier]}'${label}.`,
    }
  }
  const bad = cheaper.find(s => rate(s) <= rate(top) - KEEP_BELOW)
  if (bad === undefined) return null
  return {
    role, runs: bad.runs + top.runs,
    text: `${role}: ${NAMES[bad.tier]} finished clean ${bad.clean} of ${bad.runs} vs ${NAMES[top.tier]} ${top.clean} of ${top.runs}. Keep it on ${NAMES[top.tier]}${label}.`,
  }
}

/** At most MAX_HINTS lines, largest sample first, then by role. */
export function hintLines(project: readonly HistoryRow[], machine: readonly HistoryRow[]): string[] {
  const grouped = new Map<string, HintStat[]>()
  for (const s of hintStats(project, machine)) grouped.set(s.role, [...(grouped.get(s.role) ?? []), s])
  const hints = [...grouped].map(([role, stats]) => hintFor(role, stats)).filter((h): h is Hint => h !== null)
  hints.sort((a, b) => b.runs - a.runs || byRole(a.role, b.role))
  return hints.slice(0, MAX_HINTS).map(h => h.text)
}

/** /omnis hints: the table, then the hint lines. */
export function hintsText(project: readonly HistoryRow[], machine: readonly HistoryRow[]): string {
  const stats = hintStats(project, machine)
  if (stats.length === 0) return NO_HISTORY
  const table = stats.slice(0, MAX_TABLE).map(s => `- ${s.role} · ${NAMES[s.tier]} · ${s.runs} · ${s.clean} · ${usd(s.avgUsd)} · ${s.avgMin} · ${s.source}`)
  const lines = hintLines(project, machine)
  const tail = lines.length > 0 ? ['Hints:', ...lines.map(l => `- ${l}`)] : [NO_HINTS]
  return ['Model history (role · model · runs · clean · avg cost · avg minutes · source):', ...table, '', ...tail].join('\n')
}
