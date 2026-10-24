/**
 * The gate's settings and which command it runs (spec sections 2.3 and 2.5). The command comes from the user's
 * setting or from marker files in the run directory, never from a tool argument.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const GATE_SETTING_MODES = ['block', 'warn', 'off'] as const
export type GateSettingMode = (typeof GATE_SETTING_MODES)[number]
export type GateSettings = { mode: GateSettingMode; command: string; minutes: number }

export const DEFAULT_MINUTES = 10
export const MIN_MINUTES = 1
export const MAX_MINUTES = 60
/** A package.json bigger than this is not read. */
const MAX_PACKAGE_BYTES = 1_048_576
/** Solution names used in a shell command: plain characters only, so nothing in a file name reaches the shell. */
const SAFE_SOLUTION = /^[A-Za-z0-9._ +-]+$/

/** A value as the server was given it; blank or an unexpanded `${user_config.x}` placeholder counts as unset. */
const setting = (env: Record<string, string | undefined>, key: string): string | undefined => {
  const v = env[key]?.trim()
  return v === undefined || v === '' || v.includes('${') ? undefined : v
}

/** OMNIS_VERIFY_GATE, OMNIS_GATE_COMMAND and OMNIS_GATE_MINUTES, read through one place. */
export function gateSettings(env: Record<string, string | undefined>): GateSettings {
  const rawMode = setting(env, 'OMNIS_VERIFY_GATE')?.toLowerCase()
  const mode: GateSettingMode = rawMode === 'warn' || rawMode === 'off' ? rawMode : 'block'
  const command = setting(env, 'OMNIS_GATE_COMMAND') ?? ''
  const n = Number(setting(env, 'OMNIS_GATE_MINUTES') ?? NaN)
  const minutes = Number.isFinite(n) ? Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(n))) : DEFAULT_MINUTES
  return { mode, command, minutes }
}

/** Without an environment given (tests, anything but server.ts) the gate is off. */
const GATE_OFF = { OMNIS_VERIFY_GATE: 'off' }
export const settingsFor = (env: Record<string, string | undefined> | undefined): GateSettings => gateSettings(env ?? GATE_OFF)

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function packageScripts(dir: string): Record<string, unknown> | null {
  const file = join(dir, 'package.json')
  try {
    const stat = statSync(file)
    if (!stat.isFile() || stat.size > MAX_PACKAGE_BYTES) return null
    const json: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof json !== 'object' || json === null) return null
    const scripts = (json as Record<string, unknown>).scripts
    return typeof scripts === 'object' && scripts !== null && !Array.isArray(scripts) ? (scripts as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const nonEmpty = (x: unknown): x is string => typeof x === 'string' && x.trim() !== ''

function solution(dir: string): string | null {
  let names: string[]
  try {
    names = readdirSync(dir).filter(n => isFile(join(dir, n)))
  } catch {
    return null
  }
  const of = (ext: string) => names.filter(n => n.toLowerCase().endsWith(ext))
  const slnx = of('.slnx')
  const sln = of('.sln')
  const pick = slnx.length === 1 ? slnx[0]! : sln.length === 1 ? sln[0]! : null
  if (pick === null || !SAFE_SOLUTION.test(pick)) return null
  return pick.includes(' ') ? `"${pick}"` : pick
}

/** The first marker found in `dir`, in the spec's order, as the command to run there; null when there is none. */
export function detectCommand(dir: string): string | null {
  if (isFile(join(dir, 'scripts', 'build-test.ps1'))) return 'pwsh -NoProfile -File scripts/build-test.ps1'
  if (isFile(join(dir, 'scripts', 'build-test.sh'))) return 'bash scripts/build-test.sh'
  const scripts = packageScripts(dir)
  if (scripts !== null && nonEmpty(scripts.check)) return 'npm run check'
  if (scripts !== null && nonEmpty(scripts.test) && !scripts.test.includes('no test specified')) return 'npm test'
  const sln = solution(dir)
  return sln === null ? null : `dotnet test ${sln}`
}
