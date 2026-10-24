/**
 * Where a task's gate runs, what it runs, and the digest that binds a permission check to that run. The gate and
 * omnis_gate_plan both resolve through here, so the check sees exactly what would run.
 */
import { createHash } from 'node:crypto'
import { projectRoots, resolveWorktree } from '../worktrees.ts'
import { detectGate, type Detected } from './detect.ts'

export type Target = { dir: string; command: string | null; digest: string | null; detected: Detected | null }

export const digestOf = (content: string | Uint8Array): string => createHash('sha256').update(content).digest('hex')

/** Windows paths compare without regard to case. */
const same = (a: string, b: string): boolean => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)

/**
 * The run folder: the resolved worktree argument, else the task's stored worktree (checked again, as it may have been
 * removed), else the project root. The command: the gateCommand setting, else what detectGate finds there (null: no
 * gate). The digest: SHA-256 of the setting's command, or of what defines the detected one.
 */
export function gateTarget(root: string, stored: string | null, worktree: string | undefined, setting: string): Target {
  const dir = worktree ?? (stored !== null ? resolveWorktree(root, stored) : projectRoots(root)[0]!)
  if (setting !== '') return { dir, command: setting, digest: digestOf(setting), detected: null }
  const detected = detectGate(dir)
  return detected === null
    ? { dir, command: null, digest: null, detected }
    : { dir, command: detected.command, digest: digestOf(detected.content), detected }
}

const sameContent = (a: string | Uint8Array, b: string | Uint8Array): boolean =>
  typeof a === 'string' || typeof b === 'string' ? a === b : Buffer.from(a).equals(Buffer.from(b))

/**
 * When a detected gate runs in a worktree, what defines it must match the project root's copy, so a task can't
 * neuter its own gate. Answers the differing file (relative), or null when they match or there is nothing to
 * compare: the run folder is the root, the command came from the gateCommand setting, the root has no gate, or both
 * are dotnet. A worktree whose gate is of another kind than the root's (a script dropped or added) differs.
 */
export function differsFromRoot(root: string, dir: string, detected: Detected | null): string | null {
  const top = projectRoots(root)[0]!
  if (detected === null || same(dir, top)) return null
  const theirs = detectGate(top)
  if (theirs === null) return null
  if (theirs.kind !== detected.kind) return detected.file ?? theirs.file
  if (detected.kind === 'dotnet') return null
  return sameContent(detected.content, theirs.content) ? null : detected.file
}
