/**
 * The outcome-row stores for model hints (spec 2026-10-25 sections 3, 4, 7, 8): `.omnis-swarm/history.jsonl` and one
 * `history.jsonl` in the plugin's data folder. Best effort throughout: nothing here may fail a report, an init or a call.
 */
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { isOneOf, isValidSwarmId } from '../core/events.ts'
import { foldAll, type SwarmState } from '../core/fold.ts'
import { hintLines } from '../core/hints.ts'
import { parseRow, rowLine, rowsFromState, type HistoryRow } from '../core/history.ts'
import { ensureLogDirs, isLink, logPaths, readEvents, renameWithRetry, sortEvents, swarmLogPath } from '../core/log.ts'
import type { SwarmEvent } from '../core/events.ts'
import type { Session } from './session.ts'

export const HINTS_MODES = ['on', 'project', 'off'] as const
export type HintsMode = (typeof HINTS_MODES)[number]
export type HintsOptions = { mode: HintsMode; machineDir: string | null }
export const HINTS_OFF: HintsOptions = Object.freeze({ mode: 'off', machineDir: null })
export const MAX_ROWS = 500
const MAX_BYTES = 262_144
/** The machine store is cut back to its newest TRIM_KEEP rows once it grows past TRIM_OVER bytes. */
export const TRIM_OVER = 1_048_576
export const TRIM_KEEP = 2_000
const TRIM_READ = 4 * TRIM_OVER
/** Backfill folds at most this many logs, newest first, and none bigger than BACKFILL_MAX_BYTES. */
export const BACKFILL_LOGS = 50
export const BACKFILL_MAX_BYTES = 8 * 1024 * 1024
const FILE = 'history.jsonl'

// No following links and no waiting on a FIFO where the platform has the flags (POSIX). Windows has neither, so there
// the lstat and fstat checks are what stand, best effort.
const NOFOLLOW = constants.O_NOFOLLOW ?? 0
const READ_FLAGS = constants.O_RDONLY | NOFOLLOW | (constants.O_NONBLOCK ?? 0)
const APPEND_FLAGS = constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | NOFOLLOW

const usable = (x: string | undefined): x is string => x !== undefined && x.trim() !== '' && !x.includes('${')

/** Fails closed: unset, blank or an unexpanded `${...}` is the default 'on'; any other value it doesn't know is 'project'. */
function modeOf(value: string | undefined): HintsMode {
  const raw = value?.trim().toLowerCase() ?? ''
  if (raw === '' || raw.includes('${')) return 'on'
  return isOneOf(HINTS_MODES, raw) ? raw : 'project'
}

export function hintsOptions(env: Record<string, string | undefined>): HintsOptions {
  const mode = modeOf(env.OMNIS_MODEL_HINTS)
  const dir = env.OMNIS_DATA_DIR
  const machineDir = mode === 'on' && usable(dir) && isAbsolute(dir.trim()) ? resolve(dir.trim()) : null
  return { mode, machineDir }
}

/** Hashes the real path, so a junction, a subst drive or another spelling of the same folder gives the same key. */
export function projectKey(root: string): string {
  let path = resolve(root)
  try {
    path = realpathSync.native(path)
  } catch {
    // A folder that can't be resolved keys on its spelling.
  }
  return createHash('sha256').update(process.platform === 'win32' ? path.toLowerCase() : path).digest('hex').slice(0, 16)
}

const projectStore = (root: string): string => join(logPaths(root).dir, FILE)
const machineStore = (dir: string): string => join(dir, FILE)
const isRegular = (path: string): boolean => lstatSync(path, { throwIfNoEntry: false })?.isFile() === true

/** The state's rows with an opaque id, so the swarm name (user text) never reaches either store. */
function storedRows(state: SwarmState, key: string): HistoryRow[] {
  return rowsFromState(state, key).map(r => ({ ...r, id: createHash('sha256').update(`${key}\u0000${r.id}`).digest('hex').slice(0, 16) }))
}

/** The complete lines in the file's last `maxBytes`. Throws for a file that is missing, a link or not regular. */
function tailLines(file: string, maxBytes: number): string[] {
  if (!isRegular(file)) throw new Error(`not a regular file: ${file}`)
  const fd = openSync(file, READ_FLAGS)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw new Error(`not a regular file: ${file}`)
    const start = Math.max(0, stat.size - maxBytes)
    const from = Math.max(0, start - 1) // one byte before the cut says whether it fell on a line start
    const buf = Buffer.alloc(stat.size - from)
    const got = readSync(fd, buf, 0, buf.length, from)
    const lines = buf.subarray(start - from, got).toString('utf8').split('\n')
    if (start > 0 && buf[0] !== 0x0a) lines.shift() // the first line was cut
    return lines
  } finally {
    closeSync(fd)
  }
}

const parseLines = (lines: readonly string[]): HistoryRow[] =>
  lines.map(l => l.trim()).filter(Boolean).map(parseRow).filter((r): r is HistoryRow => r !== null)

/** Newest first, at most MAX_ROWS, from the file's last MAX_BYTES. Missing, linked, not regular or unreadable reads as empty. */
export function readRows(file: string): HistoryRow[] {
  try {
    return parseLines(tailLines(file, MAX_BYTES)).slice(-MAX_ROWS).reverse()
  } catch {
    return []
  }
}

function appendRows(file: string, rows: readonly HistoryRow[]): void {
  if (rows.length === 0) return
  const before = lstatSync(file, { throwIfNoEntry: false })
  if (before !== undefined && !before.isFile()) throw new Error(`refusing to write to a link or special file: ${file}`)
  const fd = openSync(file, APPEND_FLAGS, 0o644)
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`refusing to write to a special file: ${file}`)
    writeSync(fd, rows.map(rowLine).join(''))
  } finally {
    closeSync(fd)
  }
}

/**
 * Once the store passes `overBytes`, rewrites it with its newest `keep` rows through a temp file in the same folder.
 * Best effort: a row another session appends between the read and the rename is lost. Accepted, as it only happens past
 * the threshold and costs one row of evidence.
 */
export function trimStore(file: string, overBytes = TRIM_OVER, keep = TRIM_KEEP): void {
  const stat = lstatSync(file, { throwIfNoEntry: false })
  if (stat === undefined || !stat.isFile() || stat.size <= overBytes) return
  const rows = parseLines(tailLines(file, TRIM_READ)).slice(-keep)
  const temp = `${file}.${process.pid}.tmp`
  rmSync(temp, { force: true })
  try {
    writeFileSync(temp, rows.map(rowLine).join(''), { flag: 'wx' })
    if (!isRegular(file)) throw new Error(`refusing to replace a link or special file: ${file}`)
    renameWithRetry(temp, file)
  } finally {
    rmSync(temp, { force: true })
  }
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

/** One old log's rows. A log that can't be read or folded gives none and spoils nothing else. */
function logRows(root: string, id: string, key: string): HistoryRow[] {
  try {
    const path = swarmLogPath(root, id)
    return isRegular(path) ? storedRows(foldAll(id, sortEvents(allEvents(path))), key) : []
  } catch {
    return []
  }
}

/**
 * The first time the project store is missing, folds the newest BACKFILL_LOGS old logs once and writes their rows.
 * Leaves out links, special files, logs over BACKFILL_MAX_BYTES and `skip` (the swarm being reported or started,
 * whose rows recordRun writes to both stores later).
 */
export function ensureBackfill(root: string, skip?: string): void {
  try {
    const file = projectStore(root)
    if (lstatSync(file, { throwIfNoEntry: false }) !== undefined) return
    const dir = logPaths(root).swarms
    if (lstatSync(dir, { throwIfNoEntry: false }) === undefined || isLink(dir)) return
    const key = projectKey(root)
    const logs = readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => f.slice(0, -6)).filter(id => isValidSwarmId(id) && id !== skip)
      .flatMap(id => {
        const stat = lstatSync(swarmLogPath(root, id), { throwIfNoEntry: false })
        return stat !== undefined && stat.isFile() && stat.size <= BACKFILL_MAX_BYTES ? [{ id, mtime: stat.mtimeMs }] : []
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, BACKFILL_LOGS)
    const rows = logs.flatMap(({ id }) => logRows(root, id, key))
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
    const rows = storedRows(session.state(swarm).state, projectKey(root)).filter(r => !have.has(r.id))
    if (rows.length === 0) return
    ensureLogDirs(root)
    appendRows(projectStore(root), rows)
    if (opts.mode === 'on' && opts.machineDir !== null) {
      try {
        if (isLink(opts.machineDir)) return
        mkdirSync(opts.machineDir, { recursive: true })
        appendRows(machineStore(opts.machineDir), rows)
        trimStore(machineStore(opts.machineDir))
      } catch {
        // The machine store is best effort.
      }
    }
  } catch (err) {
    process.stderr.write(`omnis: model history not written: ${err instanceof Error ? err.message : String(err)}\n`)
  }
}

/** Both stores' rows. Project-store rows from another project (a history file cloned from elsewhere) are left out. */
export function loadRows(root: string, opts: HintsOptions, skip?: string): { project: HistoryRow[]; machine: HistoryRow[] } {
  if (opts.mode === 'off') return { project: [], machine: [] }
  ensureBackfill(root, skip)
  const key = projectKey(root)
  const project = readRows(projectStore(root)).filter(r => r.project === key)
  const machine = opts.mode === 'on' && opts.machineDir !== null ? readRows(machineStore(opts.machineDir)) : []
  return { project, machine }
}

/** Control and format characters out, so a stored role can't steer the terminal. */
const plain = (s: string): string => s.replace(/[\p{Cc}\p{Cf}]/gu, '')

/** The init reply's block: '' when there is nothing to say. `skip`: the swarm being named or started. */
export function hintBlock(root: string, opts: HintsOptions, skip?: string): string {
  try {
    const { project, machine } = loadRows(root, opts, skip)
    const lines = hintLines(project, machine)
    return lines.length === 0 ? '' : `\n\nModel hints from past runs:\n${lines.map(l => `- ${plain(l)}`).join('\n')}`
  } catch {
    return ''
  }
}
