/** Loads swarm state from a snapshot plus the log tail, and keeps it current with `advance`. */
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { emptyState, fold, type SwarmState } from './fold.ts'
import { ensureLogDirs, readEvents, sortEvents, swarmLogPath } from './log.ts'

export const SNAPSHOT_EVERY = 500

/** The most a snapshot file may hold; anything bigger is ignored. */
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024

export type Loaded = { state: SwarmState; offset: number; sinceSnapshot: number }

export const snapshotPath = (root: string, id: string): string => swarmLogPath(root, id).replace(/\.jsonl$/, '.snap.json')

export function saveSnapshot(root: string, loaded: Loaded): void {
  ensureLogDirs(root)
  const file = snapshotPath(root, loaded.state.swarm.id)
  const tmp = `${file}.tmp`
  rmSync(tmp, { force: true })
  writeFileSync(tmp, JSON.stringify({ v: 1, offset: loaded.offset, state: loaded.state }), { flag: 'wx' })
  renameSync(tmp, file)
}

export function loadSnapshot(root: string, id: string): Loaded | null {
  let fd: number | undefined
  try {
    const file = snapshotPath(root, id)
    if (lstatSync(file).isSymbolicLink()) return null
    fd = openSync(file, 'r')
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES) return null
    const raw = JSON.parse(readFileSync(fd, 'utf8')) as { v?: unknown; offset?: unknown; state?: SwarmState }
    if (raw.v !== 1 || typeof raw.offset !== 'number' || raw.state?.swarm?.id !== id) return null
    return { state: raw.state as SwarmState, offset: raw.offset, sinceSnapshot: 0 }
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
      loaded.sinceSnapshot = 0
    } catch {
      // A missed snapshot only costs replay time next load.
    }
  }
  return added
}

export function loadState(root: string, id: string): Loaded {
  const loaded = loadSnapshot(root, id) ?? { state: emptyState(id), offset: 0, sinceSnapshot: 0 }
  advance(root, loaded)
  return loaded
}
