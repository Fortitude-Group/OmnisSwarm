/** Shared memory values, one JSON file per swarm. The log only records that a write happened. */
import { closeSync, fstatSync, lstatSync, openSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureLogDirs, isValidSwarmId, logPaths } from '../core/log.ts'

export const MAX_VALUE_BYTES = 4096

/** The most bytes readMemory takes from a file; anything larger reads as empty. */
export const MAX_MEMORY_FILE_BYTES = 4 * 1024 * 1024

export type StoredValue = { value: string; writer: string; at: string }

const BANNED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function fileFor(root: string, swarm: string): string {
  if (!isValidSwarmId(swarm)) throw new Error(`invalid swarm id: ${JSON.stringify(swarm.slice(0, 80))}`)
  return join(logPaths(root).memory, `${swarm}.json`)
}

function isStored(entry: unknown): entry is StoredValue {
  if (typeof entry !== 'object' || entry === null) return false
  const e = entry as Record<string, unknown>
  return typeof e.value === 'string' && typeof e.writer === 'string' && typeof e.at === 'string'
}

/** Reads the file as text, or null if it is missing, a link, not a regular file or too big. */
function readCapped(file: string): string | null {
  if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink() !== false) return null
  const fd = openSync(file, 'r')
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_MEMORY_FILE_BYTES) return null
    const buf = Buffer.alloc(stat.size)
    const got = readSync(fd, buf, 0, buf.length, 0)
    return buf.subarray(0, got).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

export function readMemory(root: string, swarm: string): Record<string, StoredValue> {
  const file = fileFor(root, swarm)
  const out = Object.create(null) as Record<string, StoredValue>
  try {
    const text = readCapped(file)
    if (text === null) return out
    const raw = JSON.parse(text) as unknown
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out
    for (const key of Object.keys(raw)) {
      if (BANNED_KEYS.has(key)) continue
      const entry = (raw as Record<string, unknown>)[key]
      if (isStored(entry)) out[key] = { value: entry.value, writer: entry.writer, at: entry.at }
    }
  } catch {
    // missing or corrupt: empty
  }
  return out
}

export function putMemory(root: string, swarm: string, key: string, value: string, writer: string, now = new Date()): void {
  const file = fileFor(root, swarm)
  if (BANNED_KEYS.has(key)) throw new Error(`invalid memory key: ${key}`)
  ensureLogDirs(root)
  const all = readMemory(root, swarm)
  all[key] = { value, writer, at: now.toISOString() }
  const tmp = `${file}.tmp`
  rmSync(tmp, { force: true })
  writeFileSync(tmp, JSON.stringify(all), { flag: 'wx' })
  renameSync(tmp, file)
}
