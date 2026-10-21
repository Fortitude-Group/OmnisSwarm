/** Shared memory values, one JSON file per swarm. The log only records that a write happened. */
import { randomUUID } from 'node:crypto'
import {
  closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { isSafeKey, NAME } from '../core/events.ts'
import { MEMORY_KEY } from '../core/fold.ts'
import { ensureLogDirs, isValidSwarmId, logPaths, renameWithRetry, sleep } from '../core/log.ts'

export const MAX_VALUE_BYTES = 4096

/** The most keys one swarm's store holds. */
export const MAX_KEYS = 512

/** The most bytes readMemory takes from a file; anything larger reads as empty. */
export const MAX_MEMORY_FILE_BYTES = 4 * 1024 * 1024

/** The store refused a write because it is at a size limit. The message holds no paths, so it is safe to show the model. */
export class MemoryLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryLimitError'
  }
}

export type StoredValue = { value: string; writer: string; at: string }

const LOCK_WAIT_MS = 2000
const LOCK_STALE_MS = 5000

const emptyStore = (): Record<string, StoredValue> => Object.create(null) as Record<string, StoredValue>

function fileFor(root: string, swarm: string): string {
  if (!isValidSwarmId(swarm)) throw new Error(`invalid swarm id: ${JSON.stringify(swarm.slice(0, 80))}`)
  return join(logPaths(root).memory, `${swarm}.json`)
}

function isStored(entry: unknown): entry is StoredValue {
  if (typeof entry !== 'object' || entry === null) return false
  const e = entry as Record<string, unknown>
  return typeof e.value === 'string' && typeof e.writer === 'string' && typeof e.at === 'string'
}

type Loaded = { kind: 'missing' } | { kind: 'bad'; why: string } | { kind: 'ok'; data: Record<string, StoredValue> }

/** Loads the store, telling a missing file apart from one that is present but unusable. */
function load(file: string): Loaded {
  let stat
  try {
    stat = lstatSync(file, { throwIfNoEntry: false })
  } catch {
    return { kind: 'bad', why: 'cannot stat' }
  }
  if (stat === undefined) return { kind: 'missing' }
  if (stat.isSymbolicLink() || !stat.isFile()) return { kind: 'bad', why: 'not a regular file' }
  let text: string
  try {
    const fd = openSync(file, 'r')
    try {
      const fs = fstatSync(fd)
      if (!fs.isFile()) return { kind: 'bad', why: 'not a regular file' }
      if (fs.size > MAX_MEMORY_FILE_BYTES) return { kind: 'bad', why: 'too big' }
      const buf = Buffer.alloc(fs.size)
      const got = readSync(fd, buf, 0, buf.length, 0)
      text = buf.subarray(0, got).toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return { kind: 'bad', why: 'unreadable' }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { kind: 'bad', why: 'invalid JSON' }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { kind: 'bad', why: 'not an object' }
  const data = emptyStore()
  for (const key of Object.keys(raw)) {
    const entry = (raw as Record<string, unknown>)[key]
    if (isSafeKey(key) && MEMORY_KEY.test(key) && isStored(entry) && NAME.test(entry.writer) && Buffer.byteLength(entry.value) <= MAX_VALUE_BYTES) data[key] = { value: entry.value, writer: entry.writer, at: entry.at }
  }
  return { kind: 'ok', data }
}

/** True if neither log folder is a link and the memory folder really lies inside the project. */
function foldersAreSafe(root: string): boolean {
  try {
    const paths = logPaths(root)
    for (const dir of [paths.dir, paths.memory]) {
      const stat = lstatSync(dir, { throwIfNoEntry: false })
      if (stat === undefined || stat.isSymbolicLink() || !stat.isDirectory()) return false
    }
    const rel = relative(realpathSync(root), realpathSync(paths.memory))
    return !rel.startsWith('..') && !isAbsolute(rel)
  } catch {
    return false
  }
}

export function readMemory(root: string, swarm: string): Record<string, StoredValue> {
  const file = fileFor(root, swarm)
  if (!foldersAreSafe(root)) return emptyStore()
  const loaded = load(file)
  return loaded.kind === 'ok' ? loaded.data : emptyStore()
}

/** Moves a stale lock aside under a unique name. Only one competing waiter's rename succeeds. */
export function takeOverStale(lock: string): boolean {
  const aside = `${lock}.${randomUUID()}.stale`
  try {
    renameSync(lock, aside)
  } catch {
    return false
  }
  rmSync(aside, { force: true })
  return true
}

/** Takes the write lock and returns the token that proves it is ours. */
export function takeLock(lock: string): string {
  const token = randomUUID()
  const deadline = Date.now() + LOCK_WAIT_MS
  for (let wait = 10; ; wait = Math.min(wait + 10, 50)) {
    try {
      writeFileSync(lock, token, { flag: 'wx' })
      return token
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw err
    }
    try {
      const stat = lstatSync(lock, { throwIfNoEntry: false })
      if (stat !== undefined && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        takeOverStale(lock)
        continue
      }
    } catch {
      // raced with the holder removing it: just retry
    }
    if (Date.now() > deadline) throw new Error('memory store is busy: could not take the write lock')
    sleep(wait)
  }
}

/** Removes the lock only if it still holds our token. */
export function releaseLock(lock: string, token: string): void {
  try {
    if (readFileSync(lock, 'utf8') === token) rmSync(lock, { force: true })
  } catch {
    // already gone
  }
}

export function putMemory(root: string, swarm: string, key: string, value: string, writer: string, now = new Date()): void {
  const file = fileFor(root, swarm)
  if (!isSafeKey(key) || !MEMORY_KEY.test(key)) throw new Error(`invalid memory key: ${JSON.stringify(key.slice(0, 80))}`)
  if (Buffer.byteLength(value) > MAX_VALUE_BYTES) throw new Error(`memory value is over ${MAX_VALUE_BYTES} bytes`)
  if (!NAME.test(writer)) throw new Error('invalid writer name')
  ensureLogDirs(root)
  const lock = `${file}.lock`
  const token = takeLock(lock)
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  let renamed = false
  try {
    const loaded = load(file)
    if (loaded.kind === 'bad') throw new Error(`memory file is unusable (${loaded.why}); not overwriting it`)
    const all = loaded.kind === 'ok' ? loaded.data : emptyStore()
    if (!(key in all) && Object.keys(all).length >= MAX_KEYS) throw new MemoryLimitError(`Memory is full: the swarm already holds ${MAX_KEYS} keys.`)
    all[key] = { value, writer, at: now.toISOString() }
    const json = JSON.stringify(all)
    if (Buffer.byteLength(json) > MAX_MEMORY_FILE_BYTES) throw new MemoryLimitError('Memory is full: the store would be too big.')
    writeFileSync(tmp, json, { flag: 'wx', mode: 0o600 })
    renameWithRetry(tmp, file)
    renamed = true
  } finally {
    if (!renamed) rmSync(tmp, { force: true })
    releaseLock(lock, token)
  }
}
