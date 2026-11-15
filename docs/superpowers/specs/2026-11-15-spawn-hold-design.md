# The spawn hold: one agent of a type warms the cache, its siblings wait

Approved by Rob, 15 Nov 2026. Version 0.7.0.

## Why

From Rob's Claude Code logs. Subagents launched in the same message read the prompt cache on their first call 45 times out of 184. Launched after a sibling of the same agent type had already answered, 11 out of 11. After a sibling of a different type only, 2 out of 7: all 5 misses were custom agents launched after a general-purpose one. They read 0 and wrote about 59K tokens, against about 30K for a warm start. Subagents only get the 5-minute cache.

Anthropic's prompt caching docs say a cache entry can be read only once the first response that wrote it has started. Agents launched together can't read each other's writes, so every one pays the full write. The cache prefix runs tools, then system prompt, then messages, and a custom agent type's definition is its system prompt. So only agents of the same type (and model) share more than the tools.

This swarm's own log shows it. The two general-purpose agents the lead launched together on 15 Nov both spawned at 20:17:34, and each first call read 0 and wrote about 60.5K.

## The mechanism, as the engine allows it

Settled from `types/claude-code/index.d.ts` (the engine's own contract) and the plugin's code, not guessed.

1. **Where a spawn can wait.** `agent.spawn` fires inside the Agent tool's run, once per agent, before the agent starts. `next(e)` starts it. A hook that delays `next(e)` delays that one agent. It also carries the resolved `subagentType`, `model`, `fork`, `resume` and `isTeammate`. `tool.check` was ruled out: it decides permission and is the wrong place to wait.
2. **How long a hook may wait.** `HookBudget.ms` is 10 s of the hook's own time. The clock stops while `next(e)` or any `$` call is in flight, except a `$.clock` wait (`clock.sleep` says outright that its time is paid from the budget). A wait of up to 4 minutes therefore has to be spent inside a `$` call. The plugin's own MCP server answers async tools concurrently and honours cancellation (`src/mcp/protocol.ts`), and its configured timeout is 65 minutes (`plugin.json`). So the hook waits in short calls to a new internal tool, `omnis_wait`, which answers after at most 5 s.
3. **Seeing the first response.** `turn.step` is a streaming hook that fires per model request in a subagent's loop, with its `agentId`. The first chunk out of `next(e)` is the response starting. The recorder already proves a plugin's own `turn.step` hook hears its subagents' steps (`agent.usage` events in every log). The spawn's `agentId` comes back from `agent.spawn`'s `next(e)`, as the recorder already reads it.
4. **Are calls from one message run one after another?** No. In this swarm's log the two Agent calls' starts and ends interleave and both spawns land in the same second. A held spawn therefore doesn't hold up the first one's spawn. If the engine ever ran them one at a time instead, nothing breaks: the first one's spawn returns once it has started, and the next one waits for it as it would anyway.
5. **Ending a hold.** `turn.complete` fires when a subagent's run ends, for every reason (`TURN_ENDS`). A first agent that ends before any response is the failed case.

What it costs: the lead's message of Agent calls returns once the last held one has started, which is the first agent's time to its first token plus a second or so.

## What it does

Agents are grouped by subagent type and model (the Agent call's `model`, or none).

- **The first of a group goes at once** and becomes the group's leader.
- **Others of the same group are held** while the leader has not started answering. Different groups never hold each other.
- **They're let go when** the leader's first response starts (`answered`), or the leader's run ends before it answered (`failed`), or 4 minutes have passed since the first was held (`timeout`), so they still start inside the 5-minute window.
- **A leader whose spawn is refused or throws** hands over: the longest-held sibling becomes the leader and goes, the rest keep waiting on it.
- **After an answer** the group stays warm for 5 minutes from the latest step of any of its agents (a step reads or refreshes the cache). A spawn inside that window goes at once. After it, the next spawn is a new leader.
- **A leader that never reports back** (its spawn hook was cut off) is dropped after 4 minutes, and the next spawn leads.
- **Not held:** forks (they share the parent's context, not the type's), resumed agents and teammates.

### Failing open

Every way it can go wrong lets the agent start.

- The server isn't connected, or `omnis_wait` errors: the hold falls back to `$.clock.sleep` on the hook's own budget and lets go with 2.5 s of it left (about 7 s of holding).
- The person interrupts (`next.signal`): the hold stops waiting.
- The hook throws or overruns: its `.catch` runs `next(e)`.
- Nothing waits on the leader except through `answered`, `failed`, `timeout` or the stale-leader drop, so no hold can outlast 4 minutes, whatever happens to the first agent.

## Setting

`cacheHold`: `on` (the default) or `off`. On by default because every other guard ships on (`clashGuard`, `scopeFence`, `verifyGate` all default to `block`, `modelHints` to `on`), and this one never refuses anything. The worst it does is start an agent up to 4 minutes later. `off` registers no hooks.

## Events and display

One recorder event, swarm-level (no agent): `spawn.held` with `{ role, phase, count, ms, why? }`.

- `phase: 'start'` when the first sibling of a group is held (`count: 1`, `ms: 0`).
- `phase: 'end'` when the hold ends: `count` siblings held, `ms` from the first held to the release, `why` one of `answered`, `timeout`, `failed`.

The fold keeps the last 20 ends as `state.holds` (optional, like `lastReport`) and adds a feed line for each:

- start: `holding Explore agents until the first one answers`
- end: `held 3 Explore agents 41 s for the first to answer`, `held 3 Explore agents 240 s, let go at the 4 min limit`, `held 2 Explore agents 12 s, let go when the first stopped without answering`

The run report gets a `Cache holds` section, one line per end, in the same words.

## Not done

- Nothing measures whether a held agent then reads the cache. The report says what was held, not what it saved. Its usage events show the reads.
- Agents in different worktrees may have different environment text in their prompt. Rob's 11 of 11 says same-type siblings read the cache, but that wasn't split by worktree.
- Holding the lead's whole Agent message is how the engine works: the lead waits for the held spawns along with everything else in that message.
