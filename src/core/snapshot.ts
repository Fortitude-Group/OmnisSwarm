/** Loads swarm state from a snapshot plus the log tail, and keeps it current with `advance`. */
import { randomUUID } from 'node:crypto'
import { closeSync, fstatSync, openSync, readSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, relative } from 'node:path'
import { emptyState, fold, type SwarmState } from './fold.ts'
import { ensureLogDirs, isLink, logPaths, renameWithRetry, readEvents, sortEvents, swarmLogPath } from './log.ts'
import { isSwarmState } from './state-check.ts'

export const SNAPSHOT_EVERY = 500

/** The most a snapshot file may hold; anything bigger is ignored. */
export const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024

export type Loaded = { state: SwarmState; offset: number; sinceSnapshot: number }

export const snapshotPath = (root: string, id: string): string => swarmLogPath(root, id).replace(/\.jsonl$/, '.snap.json')

export function saveSnapshot(root: string, loaded: Loaded): void {
  ensureLogDirs(root)
  const file = snapshotPath(root, loaded.state.swarm.id)
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  let renamed = false
  try {
    writeFileSync(tmp, JSON.stringify({ v: 1, offset: loaded.offset, state: loaded.state }), { flag: 'wx' })
    renameWithRetry(tmp, file)
    renamed = true
  } finally {
    if (!renamed) rmSync(tmp, { force: true })
  }
}

/** Null unless the snapshot is a plain file in a real log folder, of sane size, with a valid state inside. */
export function loadSnapshot(root: string, id: string): Loaded | null {
  let fd: number | undefined
  try {
    const paths = logPaths(root)
    if (isLink(paths.dir) || isLink(paths.swarms)) return null
    const rel = relative(realpathSync(root), realpathSync(paths.swarms))
    if (rel.startsWith('..') || isAbsolute(rel)) return null
    const file = snapshotPath(root, id)
    if (isLink(file)) return null
    fd = openSync(file, 'r')
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES) return null
    const buf = Buffer.alloc(stat.size)
    let got = 0
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, got)
      if (n === 0) break
      got += n
    }
    const raw = JSON.parse(buf.subarray(0, got).toString('utf8')) as { v?: unknown; offset?: unknown; state?: unknown }
    const offset = raw.offset
    if (raw.v !== 1 || typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) return null
    if (!isSwarmState(raw.state, id)) return null
    return { state: raw.state, offset, sinceSnapshot: 0 }
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** Folds any new complete lines into `loaded`, reading in batches until the log is caught up. Returns how many events were added. */
export function advance(root: string, loaded: Loaded): number {
  const id = loaded.state.swarm.id
  const file = swarmLogPath(root, id)
  let added = 0
  for (;;) {
    const before = loaded.offset
    const read = readEvents(file, loaded.offset)
    if (read.reset) {
      loaded.state = emptyState(id)
      loaded.sinceSnapshot = 0
      added = 0
    }
    for (const event of sortEvents(read.events)) fold(loaded.state, event)
    loaded.state.gaps += read.bad
    loaded.offset = read.offset
    loaded.sinceSnapshot += read.events.length
    added += read.events.length
    if (read.events.length === 0 && !read.reset && read.offset === before) break
  }
  if (loaded.sinceSnapshot >= SNAPSHOT_EVERY) {
    try {
      saveSnapshot(root, loaded)
    } catch {
      // A missed snapshot only costs replay time next load.
    }
    loaded.sinceSnapshot = 0
  }
  return added
}

export function loadState(root: string, id: string): Loaded {
  const snap = loadSnapshot(root, id)
  if (snap !== null) {
    try {
      advance(root, snap)
      return snap
    } catch {
      // A snapshot that breaks the fold is discarded; replay the whole log instead.
    }
  }
  const loaded: Loaded = { state: emptyState(id), offset: 0, sinceSnapshot: 0 }
  advance(root, loaded)
  return loaded
}
