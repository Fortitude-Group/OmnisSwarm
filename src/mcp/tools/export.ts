/**
 * omnis_export (spec section 4): renders a recorded swarm to a looping GIF in .omnis-swarm/exports and answers its
 * path. Internal (the mod's guard refuses the model). Async: it yields every few frames so the recorder and the pane
 * keep being answered while it renders.
 */
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isValidSwarmId, type SwarmEvent } from '../../core/events.ts'
import { emptyState, fold, foldAll } from '../../core/fold.ts'
import { isLink, logPaths, readEvents, swarmLogPath } from '../../core/log.ts'
import { EXPORT_TOOL } from '../../core/recording.ts'
import { fitSpeed, logTimeAt, retime } from '../../core/replay-clock.ts'
import { swarmTotals } from '../../core/stats.ts'
import { GifWriter } from '../../gif/encode.ts'
import { drawCard, swarmDurationMs, type CardInfo } from '../../render/card.ts'
import { planRegions } from '../../render/regions.ts'
import { render } from '../../render/frame.ts'
import { cellsOf } from '../../render/raster.ts'
import { chooseSpotlight } from '../../render/spotlight.ts'
import { CELL_H, CELL_W } from '../../render/svg.ts'
import type { Spot, Tween } from '../../render/types.ts'
import { markPulses, prunePulses, pulsesFrom } from '../../mod/pane-model.ts'
import type { Args, AsyncToolDef, ToolResult } from '../protocol.ts'
import type { ToolContext } from '../tools.ts'
import { InputError, reqEnum, reqString } from '../validate.ts'

export const GIF_COLUMNS = 120
export const GIF_ROWS = 44
export const GIF_FPS = 10
export const REPLAY_TARGET_MS = 27_000
export const CARD_MS = 3_000
export const MAX_FRAMES = 600
export const MAX_BYTES = 15 * 1024 * 1024
const MIN_SPEED = 1
/** Re-encodes after the first, each at 1.5x the speed (plan, settled point 9). */
const TRIES = 4
const MAX_EVENTS = 200_000
const STYLES = ['globe', 'robot'] as const
type Style = (typeof STYLES)[number]
type Caps = { maxFrames: number; maxBytes: number }
const FAILED = 'Could not export the swarm (see the server log).'
const nextTick = (): Promise<void> => new Promise(r => setImmediate(r))

/** Every event in the swarm's log, page by page (readEvents reads at most 1 MB a call). */
function allEvents(file: string): SwarmEvent[] {
  const out: SwarmEvent[] = []
  let offset = 0
  for (;;) {
    const read = readEvents(file, offset)
    out.push(...read.events)
    if (read.offset === offset || out.length > MAX_EVENTS) return out
    offset = read.offset
  }
}

async function encodeAt(events: readonly SwarmEvent[], swarm: string, style: Style, speed: number, caps: Caps, pause: () => Promise<void>): Promise<{ gif: Uint8Array; frames: number } | 'over'> {
  const size = { columns: GIF_COLUMNS, rows: GIF_ROWS }
  const startMs = Date.parse(events[0]!.ts)
  const timed = retime(events, speed, startMs)
  const endMs = startMs + (timed.offsets.at(-1) ?? 0)
  const totalMs = (timed.logTs.at(-1) ?? 0) - (timed.logTs[0] ?? 0)
  const writer = new GifWriter(GIF_COLUMNS * CELL_W, GIF_ROWS * CELL_H)
  const state = emptyState(swarm)
  let pulses: ReturnType<typeof prunePulses> = []
  let last: Record<string, number> = {}
  let spot: Spot | null = null
  let tween: Tween | null = null
  let prevKey: string | null = null
  let prevPositions: Record<string, { x: number; y: number }> = {}
  let cursor = 0
  const step = 1000 / GIF_FPS
  for (let now = startMs, n = 0; now <= endMs + step; now += step, n++) {
    const due: SwarmEvent[] = []
    while (cursor < timed.events.length && Date.parse(timed.events[cursor]!.ts) <= now) due.push(timed.events[cursor++]!)
    for (const e of due) fold(state, e)
    const marked = markPulses(pulsesFrom(due), last)
    last = marked.lastFlicker
    pulses = prunePulses([...pulses, ...marked.pulses], now)
    spot = chooseSpotlight(spot, null, state, pulses, now)
    const clockMs = logTimeAt(timed.logTs, timed.offsets, now - startMs) - (timed.logTs[0] ?? 0)
    const replay = { speed, clockMs, totalMs, ended: now >= endMs }
    const frame = render(state, { pinned: null, spotlight: spot, pulses, lagMs: 0, tween, style }, now, size, { replay, wordmark: true })
    if (prevKey !== null && frame.nodesKey !== prevKey) tween = { from: prevPositions, at: now }
    prevKey = frame.nodesKey
    prevPositions = frame.positions
    writer.add(cellsOf([frame.top, frame.bottom], GIF_COLUMNS, GIF_ROWS), Math.round(100 / GIF_FPS))
    if (writer.frames > caps.maxFrames || writer.bytes > caps.maxBytes) return 'over'
    if (n % 10 === 9) await pause()
  }
  // The card (§13.4), over the final frame: 3 fade frames at 10 fps, then held for the rest of CARD_MS. Its figures
  // come from the swarm in log time (the wall-clock duration), not from the re-timed fold the frames were drawn from.
  const real = foldAll(swarm, events)
  const totals = swarmTotals(real, real.lastAt)
  const info: CardInfo = { durationMs: swarmDurationMs(real), clipMs: endMs - startMs, endedAt: real.swarm.endedAt }
  const agentCount = Object.values(state.agents).filter(a => !a.placeholder).length
  const graph = planRegions(size, agentCount).graph
  const finalNotes = { replay: { speed, clockMs: totalMs, totalMs, ended: true }, wordmark: true as const }
  for (const [i, k] of [1 / 3, 2 / 3, 1].entries()) {
    const still = render(state, { pinned: null, spotlight: spot, pulses: [], lagMs: 0, tween: null, style, still: true }, endMs, size, finalNotes)
    if (graph !== null) drawCard(still.top, graph, real, totals, info, k)
    writer.add(cellsOf([still.top, still.bottom], GIF_COLUMNS, GIF_ROWS), i < 2 ? 10 : CARD_MS / 10 - 20)
  }
  const gif = writer.finish()
  return writer.frames > caps.maxFrames || gif.length > caps.maxBytes ? 'over' : { gif, frames: writer.frames }
}

export async function renderGif(events: SwarmEvent[], swarm: string, style: Style, caps: Caps = { maxFrames: MAX_FRAMES, maxBytes: MAX_BYTES }, pause: () => Promise<void> = nextTick): Promise<{ gif: Uint8Array; speed: number; frames: number }> {
  const usable = events.filter(e => !Number.isNaN(Date.parse(e.ts))).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
  if (usable.length === 0) throw new InputError('That swarm has no events to export.')
  // Whole speeds only: the GIF header says ` REPLAY 24× ` (§13.4).
  let speed = Math.ceil(fitSpeed(usable.map(e => Date.parse(e.ts)), REPLAY_TARGET_MS, MIN_SPEED))
  for (let t = 0; t <= TRIES; t++) {
    const out = await encodeAt(usable, swarm, style, speed, caps, pause)
    if (out !== 'over') return { ...out, speed }
    speed = Math.ceil(speed * 1.5)
  }
  throw new InputError('The GIF would be too large even sped up; nothing was written.')
}

/** yyyymmdd-hhmm in UTC. */
const stamp = (d: Date): string => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13)

export function createExportTools(ctx: ToolContext): AsyncToolDef[] {
  const { root } = ctx
  const clock = ctx.now ?? (() => new Date())
  const tool: AsyncToolDef = {
    name: EXPORT_TOOL,
    description: 'Internal to the OmnisSwarm plugin: renders a recorded swarm to a GIF for /omnis export gif. When the OmnisSwarm mod is loaded it refuses calls from the model.',
    inputSchema: {
      type: 'object',
      properties: {
        swarm: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,63}$' },
        style: { type: 'string', enum: [...STYLES] },
      },
      required: ['swarm', 'style'],
      additionalProperties: false,
    },
    handler: async (args: Args): Promise<ToolResult> => {
      const swarm = reqString(args, 'swarm', 64)
      if (!isValidSwarmId(swarm)) throw new InputError('swarm is not a valid swarm id')
      const style = reqEnum(args, 'style', STYLES)
      const file = swarmLogPath(root, swarm)
      if (!existsSync(file) || isLink(file)) throw new InputError(`No swarm ${swarm} here.`)
      try {
        const { gif, speed } = await renderGif(allEvents(file), swarm, style)
        const dir = join(logPaths(root).dir, 'exports')
        if (isLink(dir)) throw new Error('refusing a link for the exports folder')
        mkdirSync(dir, { recursive: true })
        // The name is built only from the validated id and a timestamp, inside the exports folder.
        const name = `${swarm}-${stamp(clock())}.gif`
        const target = join(dir, name)
        if (isLink(target)) throw new Error('refusing a link for the export')
        const temp = `${target}.${process.pid}.tmp`
        rmSync(temp, { force: true })
        writeFileSync(temp, gif, { flag: 'wx' })
        renameSync(temp, target)
        return { text: `GIF written to .omnis-swarm/exports/${name} (${Math.round(gif.length / 1024)} KB, ${speed}× speed).` }
      } catch (err) {
        if (err instanceof InputError) throw err
        process.stderr.write(`omnis: omnis_export failed: ${err instanceof Error ? err.message : String(err)}\n`)
        throw new Error(FAILED)
      }
    },
  }
  return [tool]
}
