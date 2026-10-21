/** Checks that a parsed snapshot really has the shape of SwarmState, so a planted file cannot crash the fold or reach a terminal. */
import { AGENT_OUTCOMES, TASK_STATES, TOOL_KINDS, TOPOLOGIES, isOneOf, isSafeKey } from './events.ts'
import { MAX_EDITS, MAX_FEED, MAX_FILES, MAX_RECENT, MAX_SAMPLES, type SwarmState } from './fold.ts'

const MAX_DEPENDS = 20
const MAX_SPEND = 200_000
const MAX_KEY = 256
const CONTROL = /[\p{Cc}\p{Cf}]/u
const FEED_KINDS = ['agent', 'message', 'memory', 'task'] as const

type Rec = Record<string, unknown>

const isPlain = (x: unknown): x is Rec => {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false
  const proto = Object.getPrototypeOf(x)
  return proto === Object.prototype || proto === null
}

/** A plain object with exactly these keys. */
const exact = (x: unknown, keys: readonly string[]): x is Rec => {
  if (!isPlain(x)) return false
  const own = Object.keys(x)
  return own.length === keys.length && keys.every(k => Object.hasOwn(x, k))
}

/** A string with no control or format characters, at most `max` code points. */
const str = (x: unknown, max: number): x is string =>
  typeof x === 'string' && !CONTROL.test(x) && (x.length <= max || Array.from(x).length <= max)

const nstr = (x: unknown, max: number): boolean => x === null || str(x, max)
const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0
const nnum = (x: unknown): boolean => x === null || num(x)
const list = (x: unknown, max: number, ok: (item: unknown) => boolean): boolean =>
  Array.isArray(x) && x.length <= max && x.every(ok)
const record = (x: unknown, ok: (item: unknown, key: string) => boolean): boolean =>
  isPlain(x) && Object.keys(x).every(k => isSafeKey(k) && str(k, MAX_KEY) && ok(x[k], k))

const usage = (x: unknown): boolean =>
  exact(x, ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h']) && Object.values(x).every(num)

const agent = (x: unknown): boolean =>
  exact(x, [
    'id', 'name', 'role', 'description', 'parent', 'placeholder', 'startedAt', 'finishedAt', 'runs', 'activeMs', 'outcome', 'reason', 'model',
    'tokens', 'costUsd', 'costKnown', 'calls', 'lastPrompt', 'samples', 'tools', 'openTools', 'errors', 'errorsInRow',
    'files', 'messagesIn', 'messagesOut', 'lastActivity',
  ]) &&
  str(x.id, 130) && str(x.name, 64) && str(x.role, 64) && str(x.description, 120) && str(x.parent, 64) &&
  typeof x.placeholder === 'boolean' && num(x.startedAt) && nnum(x.finishedAt) && num(x.runs) && x.runs >= 1 && num(x.activeMs) &&
  (x.outcome === null || isOneOf(AGENT_OUTCOMES, x.outcome)) && nstr(x.reason, 80) && nstr(x.model, 80) &&
  usage(x.tokens) && num(x.costUsd) && typeof x.costKnown === 'boolean' && num(x.calls) && num(x.lastPrompt) &&
  list(x.samples, MAX_SAMPLES, s => exact(s, ['at', 'output', 'gapMs']) && Object.values(s).every(num)) &&
  exact(x.tools, TOOL_KINDS) && Object.values(x.tools).every(num) &&
  num(x.openTools) && num(x.errors) && num(x.errorsInRow) &&
  list(x.files, MAX_FILES, f => str(f, 80)) && num(x.messagesIn) && num(x.messagesOut) && num(x.lastActivity)

const session = (x: unknown): x is Rec =>
  exact(x, ['contextTokens', 'contextWindow', 'contextPercent', 'costUsd', 'at']) && Object.values(x).every(nnum) &&
  (x.contextPercent === null || (x.contextPercent as number) <= 100)

const link = (x: unknown): boolean =>
  exact(x, ['from', 'to', 'count', 'lastAt', 'recent']) && str(x.from, 130) && str(x.to, 130) &&
  num(x.count) && num(x.lastAt) && list(x.recent, MAX_RECENT, r => str(r, 200))

const memory = (x: unknown): boolean =>
  exact(x, ['writer', 'at', 'bytes', 'preview']) && str(x.writer, 130) && num(x.at) && num(x.bytes) && str(x.preview, 80)

const task = (x: unknown): boolean =>
  exact(x, ['id', 'title', 'state', 'assignee', 'dependsOn', 'createdAt', 'updatedAt', 'note']) &&
  str(x.id, 32) && str(x.title, 120) && isOneOf(TASK_STATES, x.state) && nstr(x.assignee, 64) &&
  list(x.dependsOn, MAX_DEPENDS, d => str(d, 80)) && num(x.createdAt) && num(x.updatedAt) && nstr(x.note, 200)

const feedItem = (x: unknown): boolean => {
  if (!isPlain(x)) return false
  const keys = Object.hasOwn(x, 'to') ? ['at', 'kind', 'agent', 'text', 'to'] : ['at', 'kind', 'agent', 'text']
  return exact(x, keys) && num(x.at) && isOneOf(FEED_KINDS, x.kind) && str(x.agent, 130) && str(x.text, 300) &&
    (!Object.hasOwn(x, 'to') || str(x.to, 130))
}

const info = (x: unknown, id: string): boolean =>
  exact(x, ['id', 'name', 'topology', 'goal', 'implicit', 'startedAt', 'endedAt', 'outcome']) &&
  x.id === id && str(x.name, 64) && isOneOf(TOPOLOGIES, x.topology) && nstr(x.goal, 200) &&
  typeof x.implicit === 'boolean' && nnum(x.startedAt) && nnum(x.endedAt) && nstr(x.outcome, 200)

export function isSwarmState(x: unknown, id: string): x is SwarmState {
  return exact(x, ['swarm', 'session', 'agents', 'byName', 'links', 'memory', 'tasks', 'feed', 'edits', 'spend', 'events', 'lastAt', 'gaps']) &&
    info(x.swarm, id) &&
    session(x.session) &&
    record(x.agents, agent) &&
    record(x.byName, v => str(v, 130)) &&
    record(x.links, link) &&
    record(x.memory, memory) &&
    record(x.tasks, task) &&
    list(x.feed, MAX_FEED, feedItem) &&
    record(x.edits, v => list(v, MAX_EDITS, e => exact(e, ['agent', 'at']) && str(e.agent, 130) && num(e.at))) &&
    list(x.spend, MAX_SPEND, s => exact(s, ['at', 'usd']) && num(s.at) && num(s.usd)) &&
    num(x.events) && num(x.lastAt) && num(x.gaps)
}
