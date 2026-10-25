/**
 * The outcome-row stores for model hints (spec 2026-10-25 sections 3, 4, 7, 8): `.omnis-swarm/history.jsonl` and one
 * `history.jsonl` in the plugin's data folder. Best effort throughout: nothing here may fail a report, an init or a call.
 */
import { createHash } from 'node:crypto'
import { appendFileSync, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { isOneOf, isValidSwarmId } from '../core/events.ts'
import { foldAll } from '../core/fold.ts'
import { hintLines } from '../core/hints.ts'
import { parseRow, rowLine, rowsFromState, type HistoryRow } from '../core/history.ts'
import { ensureLogDirs, isLink, logPaths, readEvents, sortEvents, swarmLogPath } from '../core/log.ts'
import type { SwarmEvent } from '../core/events.ts'
import type { Session } from './session.ts'

export const HINTS_MODES = ['on', 'project', 'off'] as const
export type HintsMode = (typeof HINTS_MODES)[number]
export type HintsOptions = { mode: HintsMode; machineDir: string | null }
export const HINTS_OFF: HintsOptions = Object.freeze({ mode: 'off', machineDir: null })
export const MAX_ROWS = 500
const MAX_BYTES = 262_144
const FILE = 'history.jsonl'

const usable = (x: string | undefined): x is string => x !== undefined && x.trim() !== '' && !x.includes('${')

export function hintsOptions(env: Record<string, string | undefined>): HintsOptions {
  const raw = env.OMNIS_MODEL_HINTS?.trim()
  const mode: HintsMode = isOneOf(HINTS_MODES, raw) ? raw : 'on'
  const dir = env.OMNIS_DATA_DIR
  const machineDir = mode === 'on' && usable(dir) && isAbsolute(dir.trim()) ? resolve(dir.trim()) : null
  return { mode, machineDir }
}

export function projectKey(root: string): string {
  const path = resolve(root)
  return createHash('sha256').update(process.platform === 'win32' ? path.toLowerCase() : path).digest('hex').slice(0, 16)
}

const projectStore = (root: string): string => join(logPaths(root).dir, FILE)
const machineStore = (dir: string): string => join(dir, FILE)

/** Newest first, at most MAX_ROWS, from the file's last MAX_BYTES. Missing, linked or unreadable reads as empty. */
export function readRows(file: string): HistoryRow[] {
  try {
    if (lstatSync(file, { throwIfNoEntry: false }) === undefined || isLink(file)) return []
    const fd = openSync(file, 'r')
    let text: string
    let start: number
    try {
      const size = fstatSync(fd).size
      start = Math.max(0, size - MAX_BYTES)
      const buf = Buffer.alloc(size - start)
      readSync(fd, buf, 0, buf.length, start)
      text = buf.toString('utf8')
    } finally {
      closeSync(fd)
    }
    const all = text.split('\n')
    if (start > 0) all.shift() // the first line may be cut
    return all.map(l => l.trim()).filter(Boolean).map(parseRow).filter((r): r is HistoryRow => r !== null).slice(-MAX_ROWS).reverse()
  } catch {
    return []
  }
}

function appendRows(file: string, rows: readonly HistoryRow[]): void {
  if (rows.length === 0) return
  if (isLink(file)) throw new Error(`refusing to write through a link: ${file}`)
  appendFileSync(file, rows.map(rowLine).join(''))
}

/** Every event of a log, read in pages. */
function allEvents(file: string): SwarmEvent[] {
  const events: SwarmEvent[] = []
  let offset = 0
  for (;;) {
    const page = readEvents(file, offset)
    events.push(...page.events)
    if (page.offset <= offset) break
    offset = page.offset
  }
  return events
}

/** The first time the project store is missing, folds every old log once (bar `skip`, the swarm being reported, whose rows recordRun writes to both stores) and writes their rows. */
export function ensureBackfill(root: string, skip?: string): void {
  try {
    const file = projectStore(root)
    if (lstatSync(file, { throwIfNoEntry: false }) !== undefined) return
    const dir = logPaths(root).swarms
    if (lstatSync(dir, { throwIfNoEntry: false }) === undefined || isLink(dir)) return
    const key = projectKey(root)
    const ids = readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => f.slice(0, -6)).filter(id => isValidSwarmId(id) && id !== skip)
    const rows = ids.flatMap(id => {
      const path = swarmLogPath(root, id)
      return isLink(path) ? [] : rowsFromState(foldAll(id, sortEvents(allEvents(path))), key)
    })
    ensureLogDirs(root)
    writeFileSync(file, rows.map(rowLine).join(''), { flag: 'wx' }) // wx: another writer got there first, theirs stands
  } catch {
    // A failed backfill leaves hints quieter, nothing else.
  }
}

/** After a report: appends rows for the swarm's finished agents not yet in the project store, then the machine store. */
export function recordRun(root: string, session: Session, swarm: string, opts: HintsOptions): void {
  if (opts.mode === 'off') return
  try {
    ensureBackfill(root, swarm)
    const have = new Set(readRows(projectStore(root)).map(r => r.id))
    const rows = rowsFromState(session.state(swarm).state, projectKey(root)).filter(r => !have.has(r.id))
    if (rows.length === 0) return
    ensureLogDirs(root)
    appendRows(projectStore(root), rows)
    if (opts.mode === 'on' && opts.machineDir !== null) {
      try {
        if (isLink(opts.machineDir)) return
        mkdirSync(opts.machineDir, { recursive: true })
        appendRows(machineStore(opts.machineDir), rows)
      } catch {
        // The machine store is best effort.
      }
    }
  } catch (err) {
    process.stderr.write(`omnis: model history not written: ${err instanceof Error ? err.message : String(err)}\n`)
  }
}

export function loadRows(root: string, opts: HintsOptions): { project: HistoryRow[]; machine: HistoryRow[] } {
  if (opts.mode === 'off') return { project: [], machine: [] }
  ensureBackfill(root)
  const project = readRows(projectStore(root))
  const machine = opts.mode === 'on' && opts.machineDir !== null ? readRows(machineStore(opts.machineDir)) : []
  return { project, machine }
}

/** Control and format characters out, so a stored role can't steer the terminal. */
const plain = (s: string): string => s.replace(/[\p{Cc}\p{Cf}]/gu, '')

/** The init reply's block: '' when there is nothing to say. */
export function hintBlock(root: string, opts: HintsOptions): string {
  try {
    const { project, machine } = loadRows(root, opts)
    const lines = hintLines(project, machine)
    return lines.length === 0 ? '' : `\n\nModel hints from past runs:\n${lines.map(l => `- ${plain(l)}`).join('\n')}`
  } catch {
    return ''
  }
}
