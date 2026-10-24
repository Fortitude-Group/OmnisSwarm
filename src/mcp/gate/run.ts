/**
 * Runs one gate command (spec section 2.4): the server's only child process. It starts through the shell with no
 * stdin, writes stdout and stderr to a capped log, and is stopped by its time limit, by the call's abort signal or by
 * the server exiting. Stopping kills the tree of the process it started, by PID, and nothing else.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { closeSync, openSync, writeSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { redact } from '../redact.ts'
import { InputError } from '../validate.ts'

export const LOG_CAP = 2 * 1024 * 1024
/** The log keeps its first HEAD bytes and its last TAIL_KEEP; the rest of the cap is room for the marker line. */
const HEAD = LOG_CAP / 2
const TAIL_KEEP = LOG_CAP / 2 - 256
export const TAIL_LINES = 40
export const TAIL_CHARS = 4000
/** How much of the end of the output the reply's tail is cut from. */
const TAIL_WINDOW = 64 * 1024
export const MAX_GATES = 3
/** After the command exits (or is killed), how long to wait for its output to close before carrying on without it. */
const CLOSE_GRACE_MS = 2000

export type RunResult = 'passed' | 'failed' | 'timeout' | 'error' | 'cancelled'
export type RunOutcome = {
  result: RunResult
  /** The exit code, when the command exited by itself. */
  exit?: number
  /** The signal that ended it, when it was ended by one we didn't send. */
  signal?: string
  /** Why it could not start (result `error`). */
  error?: string
  ms: number
  /** The last 40 lines of output, at most 4,000 characters, token-shaped runs blanked. */
  tail: string
}
export type RunOptions = { command: string; cwd: string; logFile: string; limitMs: number; signal?: AbortSignal }

const WINDOWS = process.platform === 'win32'
const busy = new Set<string>()
const live = new Set<ChildProcess>()
const dirKey = (dir: string): string => (WINDOWS ? resolve(dir).toLowerCase() : resolve(dir))
/** The gate's own settings: a gate command that starts this server (or its tests) must not start the gate again. */
const GATE_KEYS = new Set(['OMNIS_VERIFY_GATE', 'OMNIS_GATE_COMMAND', 'OMNIS_GATE_MINUTES'])
/** The server's environment without the gate settings. Names compare without case, as Windows does. */
export const childEnv = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([k]) => !GATE_KEYS.has(k.toUpperCase())))
const taskkill = (): string => join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')

/** Kills the tree of `child` by its PID: taskkill /T on Windows, the process group elsewhere. */
function killTree(child: ChildProcess): Promise<void> {
  const pid = child.pid
  if (pid === undefined) return Promise.resolve()
  if (!WINDOWS) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
    return Promise.resolve()
  }
  return new Promise(done => {
    const k = spawn(taskkill(), ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    k.once('error', () => done())
    k.once('exit', () => done())
  })
}

let exitHooked = false
/** When the server exits, every gate still running goes with it. Only synchronous work is possible here. */
function hookExit(): void {
  if (exitHooked) return
  exitHooked = true
  process.on('exit', () => {
    for (const child of live) {
      const pid = child.pid
      if (pid === undefined) continue
      try {
        if (WINDOWS) spawnSync(taskkill(), ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 })
        else process.kill(-pid, 'SIGKILL')
      } catch {
        // Best effort on the way out.
      }
    }
  })
}

/** Takes a slot for `dir`, or refuses with the spec's text. */
function claim(dir: string): () => void {
  const key = dirKey(dir)
  if (busy.has(key)) throw new InputError(`A gate is already running in ${dir}. Wait for it, then try again.`)
  if (busy.size >= MAX_GATES) throw new InputError('Three gates are already running.')
  busy.add(key)
  let released = false
  return () => {
    if (!released) busy.delete(key)
    released = true
  }
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g

/** The last TAIL_LINES lines of `end`, redacted before it is cut so a cut can't expose part of a token. */
function tailOf(end: Buffer, truncated: boolean): string {
  let text = end.toString('utf8').replace(ANSI, '')
  if (truncated) text = text.slice(text.indexOf('\n') + 1) // the first line may be partial
  const lines = redact(text).split(/\r?\n/)
  while (lines.length > 0 && lines.at(-1)!.trim() === '') lines.pop()
  const tail = lines.slice(-TAIL_LINES).join('\n')
  return tail.length > TAIL_CHARS ? tail.slice(-TAIL_CHARS) : tail
}

/**
 * Runs the gate. Throws an InputError at once (nothing started) when the directory already has a gate or three run.
 * Otherwise always resolves, never rejects.
 */
export function runGate(opts: RunOptions): Promise<RunOutcome> {
  const release = claim(opts.cwd)
  const started = Date.now()
  const elapsed = () => Date.now() - started
  if (opts.signal?.aborted === true) {
    release()
    return Promise.resolve({ result: 'cancelled', ms: 0, tail: '' })
  }
  let fd: number
  try {
    fd = openSync(opts.logFile, 'w')
  } catch (err) {
    release()
    return Promise.resolve({ result: 'error', error: `could not write the log (${(err as NodeJS.ErrnoException).code ?? 'error'})`, ms: elapsed(), tail: '' })
  }

  return new Promise(resolveRun => {
    let written = 0
    let total = 0
    const recent: Buffer[] = []
    let recentLen = 0
    let stopped: 'timeout' | 'cancelled' | null = null
    let exit: number | null = null
    let signal: NodeJS.Signals | null = null
    let error: string | null = null
    let settled = false
    let grace: NodeJS.Timeout | undefined
    let child: ChildProcess | undefined

    const take = (chunk: Buffer) => {
      total += chunk.length
      if (written < HEAD) {
        const part = chunk.subarray(0, HEAD - written)
        try {
          writeSync(fd, part)
        } catch {
          // A full disk loses log lines, not the gate.
        }
        written += part.length
      }
      recent.push(chunk)
      recentLen += chunk.length
      while (recent.length > 1 && recentLen - recent[0]!.length >= TAIL_KEEP) recentLen -= recent.shift()!.length
    }

    const settle = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(grace)
      opts.signal?.removeEventListener('abort', onAbort)
      if (child !== undefined) live.delete(child)
      const end = Buffer.concat(recent)
      const kept = end.subarray(Math.max(0, end.length - TAIL_KEEP))
      const after = total - written
      try {
        if (after > TAIL_KEEP) writeSync(fd, `\n[omnis: ${after - TAIL_KEEP} bytes dropped from the middle of this log]\n`)
        if (after > 0) writeSync(fd, kept.subarray(Math.max(0, kept.length - after)))
      } catch {
        // As above.
      }
      try {
        closeSync(fd)
      } catch {
        // Nothing more to do with it.
      }
      release()
      const window = end.subarray(Math.max(0, end.length - TAIL_WINDOW))
      const tail = tailOf(window, total > window.length)
      const ms = elapsed()
      if (error !== null) return resolveRun({ result: 'error', error, ms, tail })
      if (stopped !== null) return resolveRun({ result: stopped, ms, tail })
      if (exit === 0) return resolveRun({ result: 'passed', exit, ms, tail })
      if (exit !== null) return resolveRun({ result: 'failed', exit, ms, tail })
      return resolveRun({ result: 'failed', ...(signal !== null && { signal }), ms, tail })
    }
    /** Output still open after the exit or the kill: something outside the tree holds it. Carry on without it. */
    const waitForClose = () => {
      clearTimeout(grace)
      grace = setTimeout(() => {
        if (child !== undefined) void killTree(child)
        child?.stdout?.destroy()
        child?.stderr?.destroy()
        settle()
      }, CLOSE_GRACE_MS)
    }
    const stop = (why: 'timeout' | 'cancelled') => {
      if (settled || stopped !== null || exit !== null || signal !== null) return
      stopped = why
      if (child !== undefined) void killTree(child).then(waitForClose)
      else settle()
    }
    const onAbort = () => stop('cancelled')
    const timer = setTimeout(() => stop('timeout'), opts.limitMs)

    try {
      child = spawn(opts.command, {
        cwd: opts.cwd,
        shell: true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Its own process group elsewhere, so the whole group can be killed; on Windows taskkill /T walks the tree.
        detached: !WINDOWS,
        env: childEnv(),
      })
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
      settle()
      return
    }
    live.add(child)
    hookExit()
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout?.on('data', take)
    child.stderr?.on('data', take)
    child.stdout?.on('error', () => {})
    child.stderr?.on('error', () => {})
    child.once('error', err => {
      error = err.message
      settle()
    })
    child.once('exit', (code, sig) => {
      exit = code
      signal = sig
      waitForClose()
    })
    child.once('close', () => settle())
  })
}
