/**
 * `npm run test:mod`: `claude plugin validate` on the plugin, then `claude plugin test` on a staged copy.
 * `claude plugin test` runs every *.test.ts under the folder it is given, and tests/ holds node:test
 * suites the engine can't load, so the copy holds only what the plugin ships.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
// tests/fixtures is copied when it exists, for kit tests that read fixture data (phase 3).
const SHIPPED = ['.claude-plugin', 'hooks', 'types', 'src', 'tests/fixtures']

const probe = spawnSync('claude', ['--version'], { encoding: 'utf8' })
if (probe.error !== undefined) {
  process.stdout.write('test:mod skipped: the claude CLI is not on PATH\n')
  process.exit(process.env.CI === '1' ? 1 : 0)
}

const claude = (args: string[]): number => {
  const run = spawnSync('claude', args, { stdio: 'inherit' })
  return run.error === undefined ? (run.status ?? 1) : 1
}

let status = claude(['plugin', 'validate', root])
if (status === 0) {
  const stage = mkdtempSync(join(tmpdir(), 'omnis-mod-'))
  try {
    for (const name of SHIPPED) if (existsSync(join(root, name))) cpSync(join(root, name), join(stage, name), { recursive: true })
    status = claude(['plugin', 'test', stage])
  } finally {
    rmSync(stage, { recursive: true, force: true, maxRetries: 3 })
  }
}
process.exit(status)
