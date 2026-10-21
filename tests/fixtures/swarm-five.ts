/**
 * A scripted five-agent swarm (plus the lead and one unknown name) for the render goldens and the pane e2e tests.
 * Mod-safe: it imports only core/events.ts. Times are seconds after FIVE_T0.
 */
import { makeEvent, type EventData, type EventType, type SwarmEvent, type ToolKind, type Topology } from '../../src/core/events.ts'

export const FIVE_T0 = Date.parse('2026-10-21T10:00:00.000Z')
export const FIVE_SWARM = 'auth-refactor'
/** mid: comets in flight and a tool flicker; idle: most has settled, but a-arch, a-cod1 and a-test still have a tool or run open, so they glow. */
export const FIVE_AT = { mid: FIVE_T0 + 30_000, idle: FIVE_T0 + 400_000 } as const

const MCP_TYPES: readonly string[] = ['swarm.started', 'memory.put', 'task.created', 'task.updated']

function e<K extends EventType>(sec: number, type: K, data: EventData[K], agent?: string): SwarmEvent<K> {
  return makeEvent({
    type, data, swarm: FIVE_SWARM, src: MCP_TYPES.includes(type) ? 'mcp' : 'recorder',
    ...(agent !== undefined && { agent }), now: new Date(FIVE_T0 + Math.round(sec * 1000)),
  })
}
const use = (sec: number, agent: string | undefined, model: string, input: number, output: number, cacheRead = 0, cacheWrite5m = 0) =>
  e(sec, 'agent.usage', { model, input, output, cacheRead, cacheWrite5m, cacheWrite1h: 0 }, agent)
const tool = (sec: number, agent: string, phase: 'start' | 'end', kind: ToolKind, name: string, subject: string, isError = false) =>
  e(sec, 'agent.tool', { phase, tool: name, kind, subject, isError }, agent)
const start = (sec: number, agent: string, name: string, role: string, parent: string, description: string) =>
  e(sec, 'agent.started', { name, role, description, parent }, agent)
const say = (sec: number, from: string | undefined, to: string, summary: string) => e(sec, 'message.sent', { to, summary }, from)

const OPUS = 'claude-opus-5-5'
const SONNET = 'claude-sonnet-5-5'
const HAIKU = 'claude-haiku-5-5'

export function fiveAgentEvents(topology: Topology = 'hierarchical'): SwarmEvent[] {
  return [
    e(0, 'swarm.started', { name: 'auth refactor', topology, goal: 'move sessions to signed tokens', implicit: false }),
    use(0.5, undefined, OPUS, 2000, 400, 0, 30_000),
    start(1, 'a-arch', 'architect', 'system-architect', 'lead', 'Design the token flow'),
    say(1.2, undefined, 'architect', 'design the token flow'),
    use(2, 'a-arch', OPUS, 4000, 900, 0, 42_000),
    tool(3, 'a-arch', 'start', 'read', 'Read', 'src/auth/session.ts'),
    tool(3.4, 'a-arch', 'end', 'read', 'Read', 'src/auth/session.ts'),
    start(5, 'a-cod1', 'coder-1', 'coder', 'a-arch', 'Implement the token issuer'),
    start(5.2, 'a-cod2', 'coder-2', 'coder', 'a-arch', 'Implement the token verifier'),
    say(6, 'a-arch', 'coder-1', 'implement the issuer'),
    say(6.3, 'a-arch', 'coder-2', 'implement the verifier'),
    use(7, 'a-cod1', SONNET, 3000, 1500, 20_000, 8000),
    use(7.5, 'a-cod2', SONNET, 2500, 1200, 20_000, 6000),
    tool(8, 'a-cod1', 'start', 'edit', 'Edit', 'src/auth/token.ts'),
    tool(8.5, 'a-cod1', 'end', 'edit', 'Edit', 'src/auth/token.ts'),
    tool(9, 'a-cod2', 'start', 'edit', 'Edit', 'src/auth/token.ts'),
    tool(9.4, 'a-cod2', 'end', 'edit', 'Edit', 'src/auth/token.ts'),
    start(10, 'a-test', 'tester', 'tester', 'lead', 'Write and run the auth tests'),
    use(10.5, 'a-test', HAIKU, 1500, 600, 0, 4000),
    start(11, 'a-rev', 'reviewer', 'reviewer', 'lead', 'Review the change'),
    use(11.5, 'a-rev', 'claude-mystery-1', 1000, 300),
    tool(12, 'a-test', 'start', 'bash', 'Bash', 'npm test'),
    tool(12.3, 'a-test', 'end', 'bash', 'Bash', 'npm test', true),
    tool(13, 'a-test', 'start', 'bash', 'Bash', 'npm test'),
    tool(13.3, 'a-test', 'end', 'bash', 'Bash', 'npm test', true),
    tool(14, 'a-test', 'start', 'bash', 'Bash', 'npm test'),
    tool(14.3, 'a-test', 'end', 'bash', 'Bash', 'npm test', true),
    e(15, 'memory.put', { key: 'design/auth', bytes: 512, preview: 'tokens signed with ed25519' }, 'architect'),
    e(16, 'task.created', { id: 't1', title: 'Issue tokens', assignee: 'coder-1' }),
    e(16.1, 'task.created', { id: 't2', title: 'Verify tokens', assignee: 'coder-2' }),
    e(17, 'task.updated', { id: 't1', state: 'active' }),
    use(20, 'a-cod2', SONNET, 1000, 800, 30_000, 0),
    say(21, 'a-cod2', 'architect', 'verifier done'),
    e(22, 'agent.finished', { outcome: 'answer', reason: 'answer' }, 'a-cod2'),
    e(23, 'agent.finished', { outcome: 'failed', reason: 'error' }, 'a-rev'),
    say(24, 'a-cod1', 'tester', 'issuer ready for tests'),
    e(25, 'session.measure', { contextTokens: 340_000, contextWindow: 1_000_000, contextPercent: 34, costUsd: 1.2 }),
    say(26, 'a-test', 'main', 'tests are flaky on CI'),
    use(27, 'a-arch', OPUS, 3000, 700, 42_000, 0),
    tool(28, 'a-cod1', 'start', 'edit', 'Edit', 'src/auth/issuer.ts'),
    use(28.5, 'a-cod1', SONNET, 2000, 2200, 28_000, 0),
    say(29.4, 'a-arch', 'coder-1', 'use ed25519 keys'),
    say(29.6, undefined, 'tester', 'rerun with a fixed seed'),
    tool(29.8, 'a-test', 'start', 'read', 'Read', 'tests/auth.test.ts'),
    say(29.9, 'a-arch', 'ghost', 'are you there'),
    e(30, 'task.updated', { id: 't2', state: 'done' }),
  ]
}

/** A small swarm whose last event is at 3.4 s: by FIVE_AT.idle nothing in it moves. */
export const quietEvents = (): SwarmEvent[] => fiveAgentEvents().slice(0, 7)
