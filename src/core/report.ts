/** The run report (spec section 4.2): plain markdown from the folded state. Pure. */
import { LEAD, limitText, type AgentState, type SwarmState } from './fold.ts'
import { TASK_STATES } from './events.ts'
import { fileClashes, totalTokens } from './stats.ts'

const MAX_FILES = 5
const pad2 = (n: number): string => String(n).padStart(2, '0')
/** yyyy-mm-dd hh:mm at `tzOffsetMin` minutes east of UTC. */
const local = (ms: number, tz: number): string => {
  const d = new Date(ms + tz * 60_000)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
}
const minutes = (ms: number): number => Math.round(Math.max(0, ms) / 60_000)
const usd = (x: number): string => `≈$${x.toFixed(2)}`
const int = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
/** A table cell: a pipe would end the cell. */
const cell = (s: string): string => s.replace(/\|/g, '\|')
const times = (n: number): string => (n === 1 ? '1 time' : `${n} times`)

const shown = (s: SwarmState): AgentState[] => {
  const all = Object.values(s.agents).filter(a => !a.placeholder)
  return [...all.filter(a => a.id === LEAD), ...all.filter(a => a.id !== LEAD).sort((x, y) => x.startedAt - y.startedAt)]
}
const runMs = (a: AgentState, now: number): number => a.activeMs + (a.finishedAt === null ? Math.max(0, now - a.startedAt) : 0)
const nameOf = (s: SwarmState, id: string): string => (Object.hasOwn(s.agents, id) ? s.agents[id]!.name : id)
const wallMs = (s: SwarmState, now: number): number => (s.swarm.endedAt ?? now) - (s.swarm.startedAt ?? now)

function filesEdited(s: SwarmState, id: string): string {
  const paths = Object.entries(s.edits).filter(([, list]) => list.some(e => e.agent === id && e.blocked !== true)).map(([p]) => p)
  if (paths.length === 0) return '–'
  const more = paths.length - MAX_FILES
  return paths.slice(0, MAX_FILES).join(', ') + (more > 0 ? `, +${more} more` : '')
}

function outcome(a: AgentState): string {
  if (a.id === LEAD) return '–'
  if (a.outcome === null) return 'running'
  return a.outcome === 'answer' ? 'done' : a.outcome
}

function problems(s: SwarmState): string[] {
  const out: string[] = []
  if (s.guard.warn !== null) out.push(`- Swarm passed half its budget (${limitText('swarmCost', s.guard.warn)}).`)
  if (s.guard.block !== null) out.push(`- Swarm reached its ${limitText('swarmCost', s.guard.block)} budget and new agents were blocked.`)
  for (const a of shown(s)) {
    const g = a.guard
    if (g === undefined) continue
    if (g.timeWarn !== null) out.push(`- ${a.name} passed its ${limitText('time', g.timeWarn)} time-box warning.`)
    if (g.timeAct !== null) out.push(`- ${a.name} was asked to wrap up at its ${limitText('time', g.timeAct)} time-box.`)
    if (g.costWarn !== null) out.push(`- ${a.name} passed its ${limitText('agentCost', g.costWarn)} warning.`)
    if (g.costAct !== null) out.push(`- ${a.name} was asked to wrap up at its ${limitText('agentCost', g.costAct)} budget.`)
  }
  for (const c of fileClashes(s)) out.push(`- Clash on ${c.path}: ${c.agents.map(id => nameOf(s, id)).join(', ')}${c.blocked ? ' (blocked)' : ''}.`)
  for (const a of shown(s)) {
    if (a.stuckBy !== undefined) out.push(`- ${a.name} looked stuck ${times(a.stuckBy.n)} and was asked to step back (last: ${a.stuckBy.p}, ${a.stuckBy.s || 'no subject'}).`)
  }
  for (const a of shown(s)) if (a.outcome === 'failed') out.push(`- ${a.name} failed${a.reason === null ? '' : `: ${a.reason}`}.`)
  return out
}

function routing(s: SwarmState): string[] {
  const routed = shown(s).filter(a => a.route !== undefined)
  if (routed.length === 0) return []
  const lines = routed.map(a => `- ${a.name}: asked for ${a.route!.q}, answered by ${a.model ?? 'an unknown model'}, saved ${usd(a.route!.d)}.`)
  lines.push(`- Total saved: ${usd(routed.reduce((t, a) => t + a.route!.d, 0))}.`)
  return lines
}

function tasks(s: SwarmState): string[] {
  const all = Object.values(s.tasks)
  if (all.length === 0) return []
  const counts = TASK_STATES.map(k => `${all.filter(t => t.state === k).length} ${k}`).join(', ')
  return [`${counts}.`, ...all.filter(t => t.state === 'failed').map(t => `- Failed: ${t.id} ${t.title}`)]
}

export function reportSummary(s: SwarmState, nowMs: number): { agents: number; minutes: number; costUsd: number } {
  const agents = shown(s)
  return {
    agents: agents.filter(a => a.id !== LEAD).length,
    minutes: minutes(wallMs(s, nowMs)),
    costUsd: Math.round(agents.reduce((t, a) => t + a.costUsd, 0) * 100) / 100,
  }
}

export function reportMarkdown(s: SwarmState, nowMs: number, tzOffsetMin: number): string {
  const sum = reportSummary(s, nowMs)
  const started = local(s.swarm.startedAt ?? nowMs, tzOffsetMin)
  const ended = s.swarm.endedAt === null ? 'still running' : `ended ${local(s.swarm.endedAt, tzOffsetMin)}`
  const lines = [
    `# Swarm report: ${s.swarm.name}`,
    '',
    `${s.swarm.topology} · started ${started} · ${ended} · ${sum.minutes} min · ${usd(sum.costUsd)} · ${sum.agents} agent${sum.agents === 1 ? '' : 's'}`,
    '',
    '| Agent | Role | Outcome | Time | Cost | Tokens | Files edited |',
    '|---|---|---|---|---|---|---|',
  ]
  for (const a of shown(s)) {
    const cost = usd(a.costUsd) + (a.costKnown ? '' : '+')
    const name = a.id === LEAD ? 'main' : a.name
    lines.push(`| ${cell(name)} | ${cell(a.role)} | ${outcome(a)} | ${minutes(runMs(a, nowMs))} min | ${cost} | ${int(totalTokens(a.tokens))} | ${cell(filesEdited(s, a.id))} |`)
  }
  for (const [title, body] of [['Problems', problems(s)], ['Routing', routing(s)], ['Tasks', tasks(s)]] as const) {
    if (body.length > 0) lines.push('', `## ${title}`, '', ...body)
  }
  return `${lines.join('\n')}\n`
}

export const pointerText = (path: string, s: { agents: number; minutes: number; costUsd: number }): string =>
  `Swarm report: ${path} · ${s.agents} agent${s.agents === 1 ? '' : 's'} · ${s.minutes} min · ${usd(s.costUsd)}.`
