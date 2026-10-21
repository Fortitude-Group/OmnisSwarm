/**
 * `npm run test:mod`: `claude plugin validate` on the plugin, then `claude plugin test` on a staged copy.
 * `claude plugin test` runs every *.test.ts under the folder it is given, and tests/ holds node:test
 * suites the engine can't load, so the copy holds only what the plugin ships.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
// tests/fixtures is copied when it exists, for kit tests that read fixture data (phase 3).
const SHIPPED = ['.claude-plugin', 'hooks', 'types', 'src', 'tests/fixtures']

type Launcher = { command: string; shell: boolean }
const quote = (arg: string): string => `"${arg.replaceAll('"', '\\"')}"`

// A bare `claude` is an exe or script spawnSync can run. An npm install on Windows is a claude.cmd shim,
// which needs a shell (Node refuses to spawn .cmd files directly since the CVE-2024-27980 fix).
const candidates: Launcher[] = [{ command: 'claude', shell: false }]
if (process.platform === 'win32') candidates.push({ command: 'claude.cmd', shell: true })

let launcher: Launcher | undefined
let firstError: NodeJS.ErrnoException | undefined
for (const candidate of candidates) {
  const probe = spawnSync(candidate.command, ['--version'], { encoding: 'utf8', shell: candidate.shell })
  if (probe.error === undefined && probe.status === 0) { launcher = candidate; break }
  firstError ??= probe.error as NodeJS.ErrnoException | undefined
}
if (launcher === undefined) {
  if (firstError?.code === 'ENOENT') {
    process.stdout.write('test:mod skipped: the claude CLI is not on PATH\n')
    const ci = (process.env.CI ?? '').toLowerCase()
    process.exit(ci !== '' && ci !== '0' && ci !== 'false' ? 1 : 0)
  }
  process.stderr.write(`test:mod failed: could not run the claude CLI (${firstError?.code ?? 'non-zero exit from --version'})\n`)
  process.exit(1)
}
const { command, shell } = launcher

const claude = (args: string[]): number => {
  const run = spawnSync(command, shell ? args.map(quote) : args, { stdio: 'inherit', shell })
  return run.error === undefined ? (run.status ?? 1) : 1
}

// The engine lays .claude-plugin/types down on hot reload; it is not part of what the plugin ships.
const skipEngineTypes = (src: string): boolean => !src.split(sep).join('/').endsWith('.claude-plugin/types')

let status = claude(['plugin', 'validate', root])
if (status === 0) {
  const stage = mkdtempSync(join(tmpdir(), 'omnis-mod-'))
  try {
    for (const name of SHIPPED) {
      if (existsSync(join(root, name))) cpSync(join(root, name), join(stage, name), { recursive: true, filter: skipEngineTypes })
    }
    status = claude(['plugin', 'test', stage])
  } finally {
    rmSync(stage, { recursive: true, force: true, maxRetries: 3 })
  }
}
process.exit(status)
