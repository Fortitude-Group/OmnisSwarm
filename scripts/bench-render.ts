/**
 * Times the pane's render, the way its frame loop runs it: one state, the clock stepping 50 ms a frame.
 *   node scripts/bench-render.ts [frames]        (default 300 timed frames per case, after 40 warm-up frames)
 * Per case it prints the mean, median and 95th percentile ms of render(), of encoding both grids for a blit, and of
 * the Svg for the top grid. Then it splits one case into the steps render() takes, timed apart. Development only;
 * not shipped in the plugin's mod. Timing lives here rather than in a test, so the suite never flakes on a busy machine.
 */
import { performance } from 'node:perf_hooks'
import { makeEvent, type EventData, type EventType, type SwarmEvent, type Topology } from '../src/core/events.ts'
import { foldAll, type SwarmState } from '../src/core/fold.ts'
import { agentStats, fileClashes, swarmTotals, type AgentStats } from '../src/core/stats.ts'
import { pulsesFrom } from '../src/mod/pane-model.ts'
import { drawFeed } from '../src/render/feed.ts'
import { render } from '../src/render/frame.ts'
import { drawGraph } from '../src/render/graph.ts'
import { Grid, limitPairs } from '../src/render/grid.ts'
import { drawHeader } from '../src/render/header.ts'
import { layoutNodes, structuralEdges } from '../src/render/layout.ts'
import { planRegions } from '../src/render/regions.ts'
import { drawSpotlight } from '../src/render/spotlight.ts'
import { gridToSvg } from '../src/render/svg.ts'
import { drawTimeline } from '../src/render/timeline.ts'
import { CANVAS, PAIR_BUDGET, TEXT } from '../src/render/tokens.ts'
import type { Size, View } from '../src/render/types.ts'
import { FIVE_AT, FIVE_SWARM, fiveAgentEvents } from '../tests/fixtures/swarm-five.ts'

const FRAMES = Math.max(10, Number(process.argv[2]) || 300)
const WARM = 40
const STEP_MS = 50

const T0 = Date.parse('2026-10-21T10:00:00.000Z')
const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']
const KINDS = ['read', 'edit', 'bash', 'search'] as const

/** A swarm of `n` agents: six leads under the lead, the rest spread under them, all running, with messages and tools in flight at `at`. */
function bigSwarm(n: number, topology: Topology): { events: SwarmEvent[]; at: number } {
  const events: SwarmEvent[] = []
  const e = <K extends EventType>(sec: number, type: K, data: EventData[K], agent?: string): void => {
    events.push(makeEvent({ type, data, swarm: 'big', src: 'recorder', ...(agent !== undefined && { agent }), now: new Date(T0 + Math.round(sec * 1000)) }) as SwarmEvent)
  }
  e(0, 'swarm.started', { name: 'big swarm', topology, goal: 'stress the pane', implicit: false })
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const id = `a${i}`
    const parent = i < 6 ? 'lead' : `a${i % 6}`
    e(1 + i * 0.1, 'agent.started', { name: `agent-${i}`, role: 'coder', description: `job ${i}`, parent }, id)
    e(2 + i * 0.1, 'agent.usage', { model: MODELS[i % MODELS.length]!, input: 1000 * (1 + (i % 7)), output: 500, cacheRead: 10_000, cacheWrite5m: 2000, cacheWrite1h: 0 }, id)
    ids.push(id)
  }
  const at = 60
  for (let i = 0; i < n; i++) {
    const kind = KINDS[i % KINDS.length]!
    e(at - 5 + (i % 10) * 0.4, 'agent.tool', { phase: 'start', tool: kind, kind, subject: `src/f${i % 9}.ts`, isError: false }, ids[i]!)
    if (i % 3 === 0) e(at - 0.6 + (i % 5) * 0.1, 'message.sent', { to: `agent-${(i + 7) % n}`, summary: `note ${i}` }, ids[i]!)
  }
  return { events, at: T0 + at * 1000 }
}

type Case = { name: string; state: () => SwarmState; view: View; at: number; size: Size }

function fiveCase(name: string, at: number, size: Size): Case {
  const events = fiveAgentEvents('hierarchical')
  return { name, state: () => foldAll(FIVE_SWARM, events), view: { pinned: null, spotlight: null, pulses: pulsesFrom(events), lagMs: 0, tween: null }, at, size }
}
function bigCase(name: string, n: number, topology: Topology, size: Size): Case {
  const { events, at } = bigSwarm(n, topology)
  return { name, state: () => foldAll('big', events), view: { pinned: null, spotlight: null, pulses: pulsesFrom(events), lagMs: 0, tween: null }, at, size }
}

const FULL = { columns: 120, rows: 44 }
const CASES: Case[] = [
  fiveCase('five mid 120x44', FIVE_AT.mid, FULL),
  fiveCase('five idle 120x44', FIVE_AT.idle, FULL),
  bigCase('60 hier 120x44', 60, 'hierarchical', FULL),
  bigCase('60 mesh 120x44', 60, 'mesh', FULL),
  bigCase('60 hier 200x60', 60, 'hierarchical', { columns: 200, rows: 60 }),
]

const stats = (xs: number[]): { mean: number; p50: number; p95: number } => {
  const s = [...xs].sort((a, b) => a - b)
  return { mean: xs.reduce((a, b) => a + b, 0) / xs.length, p50: s[Math.floor(s.length / 2)]!, p95: s[Math.floor(s.length * 0.95)]! }
}
const ms = (x: number): string => x.toFixed(2).padStart(7)

function bench(c: Case): void {
  const state = c.state()
  const renders: number[] = []
  const encodes: number[] = []
  let svg = 0
  let step = ''
  for (let i = 0; i < WARM + FRAMES; i++) {
    const now = c.at + (i % 40) * STEP_MS
    const t0 = performance.now()
    const f = render(state, c.view, now, c.size)
    const t1 = performance.now()
    f.top.encode()
    f.bottom?.encode()
    const t2 = performance.now()
    if (i >= WARM) {
      renders.push(t1 - t0)
      encodes.push(t2 - t1)
    }
    if (i === WARM) {
      const t3 = performance.now()
      gridToSvg(f.top, f.alt, Number.MAX_SAFE_INTEGER)
      svg = performance.now() - t3
      step = `${f.step} fps ${f.fps}`
    }
  }
  const r = stats(renders)
  const e = stats(encodes)
  console.log(`${c.name.padEnd(18)} render mean ${ms(r.mean)} p50 ${ms(r.p50)} p95 ${ms(r.p95)} | encode mean ${ms(e.mean)} | svg(top) ${ms(svg)} | ${step}`)
}

/** The steps render() takes, each timed on its own over the same frames. Mirrors frame.ts; layout is cached there, so it is timed once. */
function phases(c: Case): void {
  const state = c.state()
  const totals: Record<string, number> = {}
  const add = (k: string, t: number): void => {
    totals[k] = (totals[k] ?? 0) + t
  }
  const regionsOf = planRegions(c.size, Object.keys(state.agents).length - 1)
  const g = regionsOf.graph
  let t = performance.now()
  const positions = g === null ? {} : layoutNodes(state, state.swarm.topology, g.w, g.h * 2)
  const layoutOnce = performance.now() - t
  const edges = structuralEdges(state, state.swarm.topology)
  for (let i = 0; i < WARM + FRAMES; i++) {
    const now = c.at + (i % 40) * STEP_MS
    const timed = i >= WARM
    const time = (k: string, fn: () => void): void => {
      const a = performance.now()
      fn()
      if (timed) add(k, performance.now() - a)
    }
    let clashes: ReturnType<typeof fileClashes> = []
    const st: Record<string, AgentStats> = {}
    time('stats (clashes, totals, agentStats)', () => {
      clashes = fileClashes(state, now)
      swarmTotals(state, now, clashes)
      for (const id of Object.keys(state.agents)) {
        const s = agentStats(state, id, now, clashes)
        if (s !== null) st[id] = s
      }
    })
    const regions = planRegions(c.size, Object.keys(st).length)
    let top = new Grid(1, 1)
    time('grids (new Grid x2)', () => {
      top = new Grid(regions.top.columns, regions.top.rows, CANVAS, TEXT.primary)
      if (regions.bottom !== null) new Grid(regions.bottom.columns, regions.bottom.rows, CANVAS, TEXT.primary)
    })
    const bottom = regions.bottom === null ? null : new Grid(regions.bottom.columns, regions.bottom.rows, CANVAS, TEXT.primary)
    time('header', () => drawHeader(top, regions.header, state, swarmTotals(state, now, clashes)))
    if (regions.graph !== null) {
      time('graph (drawGraph)', () => drawGraph(top, regions.graph!, { state, stats: st, positions, clashes, view: c.view, now, tEff: now, edges }))
    }
    if (bottom !== null && regions.spotlight !== null) {
      const id = Object.keys(st)[1]
      if (id !== undefined) time('spotlight', () => drawSpotlight(bottom, regions.spotlight!, st[id]!, state.agents[id]!, now, false))
    }
    if (bottom !== null && regions.timeline !== null) time('timeline', () => drawTimeline(bottom, regions.timeline!, state, now))
    if (bottom !== null && regions.feed !== null) time('feed', () => drawFeed(bottom, regions.feed!, state, now))
    time('limitPairs (pairCount)', () => {
      limitPairs(top, PAIR_BUDGET.top)
      if (bottom !== null) limitPairs(bottom, PAIR_BUDGET.bottom)
    })
    time('encode (base64, both grids)', () => {
      top.encode()
      bottom?.encode()
    })
  }
  console.log(`\nsteps for ${c.name} (mean ms a frame over ${FRAMES} frames; layout uncached once: ${layoutOnce.toFixed(2)} ms)`)
  const sum = Object.values(totals).reduce((a, b) => a + b, 0)
  for (const [k, v] of Object.entries(totals)) console.log(`  ${k.padEnd(36)} ${ms(v / FRAMES)}  ${((v / sum) * 100).toFixed(0).padStart(3)}%`)
}

console.log(`render benchmark: ${FRAMES} frames a case, ${WARM} warm-up, clock +${STEP_MS} ms a frame, node ${process.version}\n`)
for (const c of CASES) bench(c)
if (process.argv.includes('--steps')) for (const c of CASES) phases(c)
