/** Shared memory values, one JSON file per swarm. The log only records that a write happened. */
import { randomUUID } from 'node:crypto'
import {
  closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { isSafeKey } from '../core/events.ts'
import { MEMORY_KEY } from '../core/fold.ts'
import { ensureLogDirs, isValidSwarmId, logPaths } from '../core/log.ts'

export const MAX_VALUE_BYTES = 4096

/** The most keys one swarm's store holds. */
export const MAX_KEYS = 512

/** The most bytes readMemory takes from a file; anything larger reads as empty. */
export const MAX_MEMORY_FILE_BYTES = 4 * 1024 * 1024

export type StoredValue = { value: string; writer: string; at: string }

const WRITER = /^[A-Za-z0-9._-]{1,64}$/
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

const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
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
    if (isSafeKey(key) && isStored(entry)) data[key] = { value: entry.value, writer: entry.writer, at: entry.at }
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

function takeLock(lock: string): void {
  const deadline = Date.now() + LOCK_WAIT_MS
  for (let wait = 10; ; wait = Math.min(wait + 10, 50)) {
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx' })
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw err
    }
    try {
      const stat = lstatSync(lock, { throwIfNoEntry: false })
      if (stat !== undefined && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        rmSync(lock, { force: true })
        continue
      }
    } catch {
      // raced with the holder removing it: just retry
    }
    if (Date.now() > deadline) throw new Error('memory store is busy: could not take the write lock')
    sleep(wait)
  }
}

function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (attempt >= 4 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err
      sleep(20 * (attempt + 1))
    }
  }
}

export function putMemory(root: string, swarm: string, key: string, value: string, writer: string, now = new Date()): void {
  const file = fileFor(root, swarm)
  if (!isSafeKey(key) || !MEMORY_KEY.test(key)) throw new Error(`invalid memory key: ${JSON.stringify(key.slice(0, 80))}`)
  if (Buffer.byteLength(value) > MAX_VALUE_BYTES) throw new Error(`memory value is over ${MAX_VALUE_BYTES} bytes`)
  if (!WRITER.test(writer)) throw new Error('invalid writer name')
  ensureLogDirs(root)
  const lock = `${file}.lock`
  takeLock(lock)
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  let renamed = false
  try {
    const loaded = load(file)
    if (loaded.kind === 'bad') throw new Error(`memory file is unusable (${loaded.why}); not overwriting it`)
    const all = loaded.kind === 'ok' ? loaded.data : emptyStore()
    if (!(key in all) && Object.keys(all).length >= MAX_KEYS) throw new Error(`memory is full: ${MAX_KEYS} keys`)
    all[key] = { value, writer, at: now.toISOString() }
    const json = JSON.stringify(all)
    if (Buffer.byteLength(json) > MAX_MEMORY_FILE_BYTES) throw new Error('memory file would be too big')
    writeFileSync(tmp, json, { flag: 'wx', mode: 0o600 })
    renameWithRetry(tmp, file)
    renamed = true
  } finally {
    if (!renamed) rmSync(tmp, { force: true })
    rmSync(lock, { force: true })
  }
}
