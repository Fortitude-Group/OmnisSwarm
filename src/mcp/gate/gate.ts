/**
 * The verification gate on omnis_task_update(done) (spec section 2): where it runs, what it runs, what it records and
 * what the reply says. tools.ts writes the task.updated event only when this says the task closes.
 */
import { lstatSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { clip, makeEvent, type GateMode, type GateResult, type SwarmEvent } from '../../core/events.ts'
import type { SwarmState, TaskEntry } from '../../core/fold.ts'
import { isLink, logPaths } from '../../core/log.ts'
import type { CallContext } from '../protocol.ts'
import { redact } from '../redact.ts'
import { takeApproval } from './approvals.ts'
import { runGate, type RunOutcome } from './run.ts'
import { differsFromRoot, gateTarget } from './target.ts'

export const PROGRESS_MS = 30_000
/** The command as shown in a reply, and as stored on gate.ran. */
const SHOWN_COMMAND = 80
const STORED_COMMAND = 120
const MAX_ERROR = 200
/** How far past the expected log number the next free name is looked for. */
const MAX_LOG_STEPS = 1000

export type GateCall = {
  root: string
  swarm: string
  task: TaskEntry
  /** The resolved `worktree` argument of this call, if any. */
  worktree?: string
  /** The assignee after this call (its argument, else the task's). */
  assignee: string | null
  skip: boolean
  mode: GateMode
  /** The gate command setting; empty means detect. */
  command: string
  minutes: number
  limitMs: number
  progressMs: number
  emit: (event: SwarmEvent) => void
  now: () => Date
  /** The swarm's folded state as it is now (read again after the run for the test-gap note). */
  state: () => SwarmState
  ctx: CallContext
}
export type GateOutcome = { closes: boolean; text: string; isError?: true }

export const NO_CHECK_TEXT = "The gate needs OmnisSwarm's mod to check permission first, and no check arrived. Make sure mods are on, or mark the task done with skipGate and a note."
export const CHANGED_WHY = 'the gate changed after it was approved'
export const differsWhy = (file: string): string => `the gate script in this worktree differs from the project's (${file})`

/** Log names already handed to a running gate, so two runs of one task never share a file. */
const logsInUse = new Set<string>()

const TEST_FILE = [/(^|\/)(tests?|__tests__|spec|specs)\//i, /\.(test|spec)\.[a-z0-9]+$/i, /Tests?\.(cs|fs|vb)$/]
const SOURCE_EXT = new Set('ts tsx js jsx mjs cjs mts cts py cs fs vb go rs java kt swift rb php c cc cpp h hpp'.split(' '))
const isTest = (path: string): boolean => TEST_FILE.some(re => re.test(path))
const isSource = (path: string): boolean => {
  const dot = path.lastIndexOf('.')
  return dot > path.lastIndexOf('/') && SOURCE_EXT.has(path.slice(dot + 1).toLowerCase()) && !isTest(path)
}

/** Source files the named agent edited in this swarm when it edited no test file; 0 otherwise or when unknown. */
export function gapOf(state: SwarmState, assignee: string): number {
  const id = Object.hasOwn(state.byName, assignee) ? state.byName[assignee]! : null
  if (id === null) return 0
  let source = 0
  for (const [subject, list] of Object.entries(state.edits)) {
    if (!list.some(e => e.agent === id && e.blocked !== true)) continue
    const path = subject.replace(/\\/g, '/')
    if (isTest(path)) return 0
    if (isSource(path)) source++
  }
  return source
}

const seconds = (ms: number): number => Math.round(ms / 1000)
/** 0.5, 1, 1.5: the minutes so far, to one decimal. */
const minutesSoFar = (ms: number): string => String(Math.round(ms / 6000) / 10)

function why(out: RunOutcome, minutes: number): string {
  switch (out.result) {
    case 'timeout': return `timed out after ${minutes} min`
    case 'error': return `could not start: ${clip(redact(out.error ?? 'unknown error'), MAX_ERROR)}`
    case 'cancelled': return 'cancelled'
    default: return out.exit !== undefined ? `exit ${out.exit}` : `killed by ${out.signal ?? 'a signal'}`
  }
}

/** The run's log file, relative name and absolute path, under .omnis-swarm/gates. Refuses a link for either folder. */
function logFor(root: string, swarm: string, task: TaskEntry): { rel: string; file: string; name: string } {
  const top = logPaths(root).dir
  const dir = join(top, 'gates')
  if (isLink(top) || isLink(dir)) throw new Error('refusing a link for the gates folder')
  mkdirSync(dir, { recursive: true })
  // The next name that is neither taken on disk (a file, a folder or a link) nor held by a running gate. runGate
  // creates it with 'wx', so a name taken in between is an error, never a file written through.
  const taken = (name: string): boolean => logsInUse.has(name) || lstatSync(join(dir, name), { throwIfNoEntry: false }) !== undefined
  let n = (task.gate?.runs ?? 0) + 1
  for (let tries = 0; taken(`${swarm}-${task.id}-${n}.log`); tries++) {
    if (tries >= MAX_LOG_STEPS) throw new Error('too many gate logs with this name')
    n++
  }
  const name = `${swarm}-${task.id}-${n}.log`
  return { rel: `.omnis-swarm/gates/${name}`, file: join(dir, name), name }
}

/** Runs (or skips) the gate for a task being marked done. Throws an InputError when it is refused before running. */
export async function gateForDone(g: GateCall): Promise<GateOutcome> {
  const id = g.task.id
  const record = (data: Omit<Extract<SwarmEvent, { type: 'gate.ran' }>['data'], 'task' | 'mode'>): void =>
    g.emit(makeEvent({ type: 'gate.ran', swarm: g.swarm, src: 'mcp', now: g.now(), data: { task: id, ...data, mode: g.mode } }))

  if (g.skip) {
    record({ result: 'skipped', ms: 0 })
    return { closes: true, text: `Task ${id} is now done. Gate skipped.` }
  }
  const { dir, command, digest, detected } = gateTarget(g.root, g.task.worktree, g.worktree, g.command)
  if (command === null) {
    record({ result: 'none', ms: 0 })
    return { closes: true, text: `Task ${id} is now done. No gate found in ${dir}, so nothing was run.` }
  }
  // Nothing runs without the mod's permission check for this call, and only what that check saw.
  const approval = takeApproval(g.root, g.swarm, id, g.now().getTime())
  if (approval === null) return { closes: false, isError: true, text: NO_CHECK_TEXT }
  const shown = clip(redact(command), SHOWN_COMMAND)
  /** A gate refused before it ran: result error, nothing in the log. `always`: refused even when verifyGate is warn. */
  const refused = (whyText: string, always: boolean): GateOutcome => {
    record({ result: 'error', ms: 0, command: clip(redact(command), STORED_COMMAND) })
    if (g.mode === 'warn' && !always) {
      return { closes: true, text: `Task ${id} is now done, but its gate failed (${whyText}, 0 s): ${shown}. verifyGate is warn, so it closed anyway.` }
    }
    return { closes: false, isError: true, text: `Gate failed for ${id} (${whyText}, 0 s): ${shown}. The task stays ${g.task.state}.` }
  }
  if (approval.dir !== dir || approval.command !== command || approval.digest !== digest) return refused(CHANGED_WHY, true)
  const differs = differsFromRoot(g.root, dir, detected)
  if (differs !== null) return refused(differsWhy(differs), false)

  const log = logFor(g.root, g.swarm, g.task)
  const started = Date.now()
  const ticker = setInterval(() => g.ctx.progress(`gate running, ${minutesSoFar(Date.now() - started)} min`), g.progressMs)
  logsInUse.add(log.name)
  let out: RunOutcome
  try {
    out = await runGate({ command, cwd: dir, logFile: log.file, limitMs: g.limitMs, signal: g.ctx.signal })
  } finally {
    clearInterval(ticker)
    logsInUse.delete(log.name)
  }

  const result: GateResult = out.result === 'cancelled' ? 'failed' : out.result
  const gap = g.assignee === null ? 0 : gapOf(g.state(), g.assignee)
  record({
    result, ms: out.ms, command: clip(redact(command), STORED_COMMAND),
    ...(out.exit !== undefined && { exit: out.exit }), log: log.rel, ...(gap > 0 && { gap }),
  })
  const note = gap > 0 ? `\nNote: ${g.assignee} changed ${gap} source file(s) and no test files.` : ''
  const s = seconds(out.ms)
  if (out.result === 'passed') return { closes: true, text: `Task ${id} is now done. Gate passed in ${s} s (${shown}).${note}` }
  const detail = `\nLast lines:\n${out.tail}\nFull log: ${log.rel}${note}`
  if (g.mode === 'warn' && out.result !== 'cancelled') {
    return { closes: true, text: `Task ${id} is now done, but its gate failed (${why(out, g.minutes)}, ${s} s): ${shown}. verifyGate is warn, so it closed anyway.${detail}` }
  }
  return { closes: false, isError: true, text: `Gate failed for ${id} (${why(out, g.minutes)}, ${s} s): ${shown}. The task stays ${g.task.state}.${detail}` }
}
