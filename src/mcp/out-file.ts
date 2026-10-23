/** Files the server writes for a person (GIF exports, run reports): named by swarm and local minute, never overwritten. */
import { lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isLink, logPaths } from '../core/log.ts'

/** Second and later files in the same minute get -2, -3, … after the stamp. */
const MAX_SAME_MINUTE = 99
const pad2 = (n: number): string => String(n).padStart(2, '0')
const taken = (path: string): boolean => lstatSync(path, { throwIfNoEntry: false }) !== undefined

/** yyyymmdd-hhmm in the server machine's local time zone (sorts by time within a zone). */
export const stamp = (d: Date): string => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`

/**
 * Writes `data` to .omnis-swarm/<folder>/<base><ext>, or <base>-2<ext> and on when taken, through a temp file and a
 * rename. The name is built only from the caller's validated base, a counter and the extension. No await between
 * choosing it and the rename, so two writes in this server cannot pick the same name. Answers the file name.
 */
export function writeUnique(root: string, folder: 'exports' | 'reports', base: string, ext: '.gif' | '.md', data: string | Uint8Array): string {
  const logDir = logPaths(root).dir
  const dir = join(logDir, folder)
  if (isLink(logDir) || isLink(dir)) throw new Error(`refusing a link for the ${folder} folder`)
  mkdirSync(dir, { recursive: true })
  let n = 1
  while (n <= MAX_SAME_MINUTE && taken(join(dir, n === 1 ? `${base}${ext}` : `${base}-${n}${ext}`))) n++
  if (n > MAX_SAME_MINUTE) throw new Error(`too many ${folder} this minute`)
  const name = n === 1 ? `${base}${ext}` : `${base}-${n}${ext}`
  const target = join(dir, name)
  const temp = `${target}.${process.pid}.tmp`
  try {
    rmSync(temp, { force: true })
    writeFileSync(temp, data, { flag: 'wx' })
    renameSync(temp, target)
  } finally {
    rmSync(temp, { force: true })
  }
  return name
}
