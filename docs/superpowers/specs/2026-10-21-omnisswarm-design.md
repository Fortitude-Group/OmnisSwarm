# OmnisSwarm — design

Date: 2026-10-21
Status: approved in brainstorming, then re-approved on 2026-10-21 after the mod API spike
([docs/spikes/2026-10-21-mod-api.md](../../spikes/2026-10-21-mod-api.md)) changed the architecture in
sections 4 to 10 (mods have no Node, so the MCP server is the only writer and the pane reads through it).

## 1. Summary

OmnisSwarm is a cut-down replacement for RuFlo. It keeps only the agent-swarm parts and adds
a rich, read-only visual pane inside Claude Code that shows the running agents, the links
between them, the information moving along those links, and detailed stats for every agent.

Claude Code's own Agent tool runs the agents. OmnisSwarm records the swarm's structure
(topology, roles, shared memory, tasks), watches what the agents actually do through
Claude Code's hooks, and hands everything to its own MCP server, which writes an append-only
event log. The pane draws from the state the server folds from that log. A full WebGL window can
later read the same log.

Once it works in a real session, OmnisSwarm replaces RuFlo completely in Rob's setup.

## 2. Goals and non-goals

Goals

- Show a live, accurate picture of a swarm: agents, status, links, messages, memory, tasks.
- Per-agent stats: tokens, ≈cost, model, context fill, cache hit rate, ≈speed, tool activity,
  files touched, messages, lifetime, errors.
- A pane that looks slick: true-colour pixels, glow, particles, fades, motion.
- Informational only: nothing in the pane sends a prompt or changes the swarm.
- Never break or slow a Claude Code session.
- A documented event stream so a separate WebGL visualiser can be added without rework.
- Packaged as a proper Claude Code plugin; installs cleanly with no native dependencies.

Non-goals (v1)

- Running agents itself (no headless `claude -p`, no direct API calls).
- Long-term cross-session memory (Claude Code's built-in project memory covers it).
- Prompt routing, consensus/hive-mind, neural learning, vector search, background daemons,
  policy or witness ledgers.
- Guessed metrics: quality scores, predicted cost to finish, routing confidence.
- The hub server and WebGL window (designed in section 13, built later).
- A fallback recorder for sessions without function hooks.
- Public launch, docs site or landing page.

## 3. Decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Scope | Thin swarm coordinator plus viewer |
| 2 | Who runs agents | Claude Code's Agent tool; OmnisSwarm records and observes |
| 3 | Pane graphics | True-colour animated `Raster` in the terminal pane (cell pixels) |
| 4 | Future visuals | Separate WebGL window over the same event stream |
| 5 | Swarm features | Topology, agent registry, messages, shared memory, task board |
| 6 | RuFlo | Removed completely, after OmnisSwarm is proven (phase 5) |
| 7 | Memory | No long-term memory of its own; Claude Code's project memory |
| 8 | Audience | Rob's toolkit, plugin in a `Fortitude-Group` marketplace, publishable later |
| 9 | Shared state | Append-only JSONL event log (hub server documented for later) |
| 10 | Spotlight | Follows the busiest agent; view-only chips pin one |

## 4. Architecture

```
 Claude Code session
 ├─ Agent tool / SendMessage / tool calls / model steps ─▶ Recorder (mod) ─┐ $.mcp.call
 └─ Claude calls omnis_* tools ──────────────────────────────────────────┐ │
                                                                         ▼ ▼
                                                      MCP server (stdio, the only writer)
                                                                         │ append
                                                                         ▼
                                                   .omnis-swarm/swarms/<swarmId>.jsonl
                                                                         │ follow
                                      ┌──────────────────────────────────┤
                                      ▼ (via the MCP server)             ▼
                               Pane (mod, Raster)           (later) hub ─▶ WebGL window
```

A hooks module runs with no Node: it imports only its own files and `claude-code`, and reaches files
through `$.fs`, which can't append or read from an offset (spike Q5). So the mod never touches the log
file. It hands each event to the plugin's own MCP server with `$.mcp.call`, and the server appends it.
That channel was run end to end in the spike (round 2): sequential calls arrive in hook order (only one
was ever in flight, so overlapping calls are untested, and readers order by the mod's `ts` anyway), an awaited call
takes 33-88 ms, a slow call doesn't hold up the session, and a killed server is restarted by Claude
Code on the next call (spike A1).

The server learns the project root from its manifest entry,
`"env": { "OMNIS_PROJECT_DIR": "${CLAUDE_PROJECT_DIR}" }`, and uses that rather than `cwd` or an
inherited `CLAUDE_PROJECT_DIR` (spike Q7).

The server's internal tools (`omnis_record` for the recorder, `omnis_feed` for the pane) are not for
the model, but they can't be hidden: `$.mcp.call` reaches only tools the server lists, and a listed
tool can at most be deferred behind ToolSearch. `$.mcp.call` also reaches every connected MCP server,
not only ours, so any installed mod can call these tools too. Both are guarded, see section 6.

Units, each with one job and a typed interface:

| Unit | Job | Depends on |
|---|---|---|
| `core` | Event types, append, follow, pure `fold(events) → SwarmState`, price table | nothing |
| `mcp` | The only writer. `omnis_*` tools; writes swarm, memory and task events; appends the events the recorder sends (`omnis_record`); keeps the folded state and snapshots; answers the pane (`omnis_feed`) | core |
| `recorder` | Mod handlers; turns Claude Code events (including `turn.step` usage) into log events and sends them to `mcp` | core (Node-free parts), mod API |
| `render` | Pure `render(state, view, nowMs, size) → Frame` (two grids, one per `Raster`, plus the pin chips); layout, glow, particles | core |
| `pane` | Mod pane: opens, gets swarm state through `mcp` (not by reading the log file), calls `render`, handles pin chips | core (Node-free parts), render, mod API |

Repository layout (`Fortitude-Group/OmnisSwarm`, which is also its own plugin marketplace):

```
.claude-plugin/plugin.json        plugin manifest (MCP server, mod modules, user config)
.claude-plugin/marketplace.json   single-plugin marketplace
src/core/       events.ts  log.ts  fold.ts  stats.ts  prices.ts
src/mcp/        server.ts  registry.ts  session.ts  protocol.ts  validate.ts  memory-store.ts  tools.ts  (one more file per later tool)
src/mod/        register.ts  recorder.ts  pane.ts
src/render/     layout.ts  graph.ts  spotlight.ts  timeline.ts  feed.ts  fx.ts  grid.ts
tests/          mirrors src/, plus fixtures/ and e2e/
docs/           this spec, event-log reference, hub protocol
```

Runtime: TypeScript on Node 24 with no native dependencies. Mods are loaded by Claude Code
as `.ts` (as RuFlo's are) in an environment with no Node. Every file under `src/mod/` and
`src/render/`, and every `src/core/` file they import (`events.ts`, `fold.ts`, `stats.ts`,
`prices.ts`), must import nothing from `node:*` and use no Node globals: `Buffer`, `process`,
`require`, `module`, `fetch` and `queueMicrotask` are all undefined there. Web APIs only:
`TextEncoder`/`TextDecoder`, `structuredClone`, `crypto`, `URL`, `atob`/`btoa`, `performance`,
`setTimeout`, `Uint8Array.prototype.toBase64` and `Date.now()` all exist (checked at run time, spike
round 2). Byte lengths use `new TextEncoder().encode(s).length`, network goes through `$.http`, timers
that outlive a hook through `$.clock`. Only `core/log.ts`, `core/snapshot.ts`, `core/swarm.ts` and `src/mcp/` use Node (`core/state-check.ts` is Node-free). A mod may import
from parent folders inside the plugin (`../core/fold.ts`, verified) and may pass `$` only to functions
declared at the top of a file or imported from its own files.
The MCP server runs with Node's built-in type stripping, so there is no build step (verified,
see section 15). No file over 500 lines.

## 5. Swarm model and MCP tools

All tools are prefixed `omnis_` so they never clash with RuFlo or anything else.

| Tool | Input | Effect |
|---|---|---|
| `omnis_swarm_init` | `name`, `topology` (`hierarchical` \| `mesh` \| `star`), `goal?` | `swarm.started`; becomes `current` |
| `omnis_swarm_end` | `outcome?` | `swarm.ended` |
| `omnis_swarm_status` | none | Returns folded state as compact text (agents, tasks, totals) |
| `omnis_memory_put` | `key`, `value` (≤ 4 KB), `agent?` | `memory.put` |
| `omnis_memory_get` | `key` | Returns the stored value (from the memory value file, section 8) |
| `omnis_memory_list` | `prefix?` | Returns keys with writer and time |
| `omnis_task_create` | `title`, `assignee?`, `dependsOn?` | `task.created`, returns task id |
| `omnis_task_update` | `id`, `state` (`pending` \| `active` \| `done` \| `failed`), `assignee?`, `note?` | `task.updated` |

There is deliberately no message tool or agent-register tool. Agents message each other
with Claude Code's `SendMessage` and are spawned with the Agent tool. The recorder sees both.

Inputs are validated at the boundary: lengths capped, enums checked, keys limited to
`[A-Za-z0-9._/-]{1,128}`. Invalid input returns a tool error and writes nothing.

**Implicit session swarm.** The MCP server is the only writer, so it alone decides the swarm.
Every recorder call carries the session id and a `ts` the mod stamped at hook time (`Date.now()`,
as an ISO string). The server stamps `v`, `swarm` and `src` itself. When an event arrives and there
is no current swarm, the server first writes a `swarm.started` with `topology: hierarchical`,
`name: session-<first 8 of the sessionKey>`, `implicit: true`, and sets `current`. The sessionKey is
the first 16 hex characters of sha256(session id) (`src/mcp/session.ts`), so the raw id never reaches the log. An `omnis_*` tool
call that needs a swarm before any recorder event has arrived does the same (the server reads the
session id from its own first recorder call, or names the swarm `session-<yyyymmdd-hhmmss>` if
none has come). A later `omnis_swarm_init` in the same session renames and retypes the implicit
swarm instead of starting a second one. Calling `omnis_swarm_init` while an explicit swarm is
still running ends that one (`outcome: "replaced"`) and starts the new one. The server keeps no
state it can't rebuild from `.omnis-swarm/`: Claude Code restarts a dead server on the next call,
with a fresh process.

A session with a known id only ever uses its own swarm, found from the `session` (sessionKey) on the
log's `swarm.started`. It never adopts `current` when `current` is another session's swarm, and if
another session's live swarm holds `current` it starts its own implicit swarm and leaves `current`
alone. Only a session with no known id (no recorder) may adopt `current`. After `/clear` or a resume,
when a second session id arrives in the same process, the session still never adopts a foreign swarm.

## 6. Recorder

Mod handlers, all observe-only. Each handler is wrapped so it always calls `next` and passes
the result through unchanged, even if the handler throws.

| Claude Code event | Log event |
|---|---|
| `session.start` | Remembers the session id (`$.session.id()`; the payload carries none); no log write |
| `agent.spawn` (after `next`, with `result.agentId`) | `agent.started`: `name`, `role` (`subagentType`), `description` (≤ 120 chars), `parent` (`parentAgentId`, or `lead` when absent) |
| `turn.complete` with `agentId` | `agent.finished`: `outcome` = `answer` (reason `answer`) \| `aborted` (`aborted`) \| `failed` (`refusal` or `error`), plus the raw reason (≤ 80 chars) |
| `turn.step` with `agentId` (after `next`, when `usage` is not null), or without it for the lead | `agent.usage` from the step's `usage`, see section 7 |
| `tool.call` (before and after `next`) | `agent.tool`: `phase` `start`/`end`, `tool`, `kind` (read, edit, bash, search, web, agent, other), `subject` (path or command, ≤ 80 chars), `isError` |
| `session.send` with `origin.kind === 'model'` (after `next`, when `isDelivered`) | `message.sent`: `to`, `summary` (first 200 chars of `text`). Sends by plugins (`origin.kind === 'plugin'`) are not recorded |
| `tool.call` where `tool` is `SendMessage` and `message` is an object (after `next`, when the result has no `isError`) | `message.sent`: `to`, `summary` = `[<message.type>]` plus `approve: yes/no` where the payload has it (never `reason` or `feedback` text) |
| `session.measure` when `changed` has `context` or `cost` | `session.measure`, see section 9 |
| `ui.render` / `ui.close` / `command.run` | Pane only, see section 10 |

**Sending.** Each handler builds the event and sends it with
`$.mcp.call(server, 'omnis_record', { sessionId, ts, type, agent, data })`, where `server` is what
`$.mcp.connect('<our server key>')` answered at `session.start` (`plugin:<plugin>:<key>`). The call
is fire and forget: never awaited before `next`, its rejection or `isError` result caught, counted
and dropped. The arguments must be plain, cloneable data (a Promise in them is refused with
`arguments are not plain data`). At most 64 calls are in flight; past that an event is dropped and
counted, and the count is sent with the next event that gets through so the pane can show a gap.
`$.mcp.call` raises `tool.call` and `tool.check` like any tool call (only the hook that made the call
is skipped), so the recorder's `tool.call` handler ignores the internal tools `omnis_record` and `omnis_feed`
(by their full names, `mcp__plugin_<plugin>_<server>__omnis_record` and `__omnis_feed`) rather than
recording its own traffic. The model's calls to the public `omnis_*` tools (`omnis_swarm_init`,
`omnis_memory_put` and the rest) are still recorded as `agent.tool` like any other tool. Every recorder
event and every pane pull runs every installed mod's `tool.call` and `tool.check` hooks, ours
included. `$.mcp.call` also raises classic `PreToolUse` command hooks, once per call (verified in
phase 2, [docs/spikes/2026-10-21-recorder-live.md](../../spikes/2026-10-21-recorder-live.md) item 3),
so anyone with a catch-all `PreToolUse` hook starts a process per recorded event and per pane pull. Phase 4's README says
so and gives a matcher that excludes us. A killed server answers in-flight calls with `isError` ("Connection
closed"), and Claude Code restarts it on the next call. That call's event and any in flight are lost.

**Guard (security).** The internal tools are listed by the server, so the model can find them with
ToolSearch. The mod therefore:

- answers `tool.describe` for them with `isDeferred: true` and a description saying they are internal;
- registers a `tool.check` hook that allows a call only when `next.origin.plugin === $.plugin.name`
  and answers `{ decision: 'deny', reason }` otherwise. `next.origin` is set by the host and can't be
  forged: the model's call reads `{ plugin: 'engine', tier: 'core' }`, ours `{ plugin: '<name>',
  tier: 'user' }` (verified, spike A1). The registration carries
  `.catch(($, e, next) => isInternal(e.tool) ? { decision: 'deny' } : next(e))`, so a failing guard
  fails closed for our tools and open for everything else.

The origin check was verified only with `--plugin-dir`, where `$.plugin.name` and `next.origin.plugin`
both read the bare name (`omnis-probe`, while `tool.describe`'s `provider` read `omnis-probe@inline`).
Phase 4 re-checks it after a marketplace install, where the id becomes `<name>@<marketplace>`.

**When mods don't load** (`disableAllHooks`, `allowManagedHooksOnly`, `allowManagedModsOnly`), the
MCP server still connects but nothing guards `omnis_record` and `omnis_feed`: the model can call
them and could forge `agent.*` events. That is accepted, because the log is a display record and not
a trust boundary (section 8); the server's own type and `LIMITS` checks still apply.

The server does its own checks too, since the mod is not a trust boundary: `omnis_record` accepts
only the recorder's event types (`agent.started`, `agent.finished`, `agent.usage`, `agent.tool`,
`message.sent`, `session.measure`), enforces the event `LIMITS` (lengths and line size), stamps
`src: recorder` itself, and returns a tool error for anything else, writing nothing.

**Reloads.** A hot reload runs `register` and `session.start` again and drops module variables.
The recorder keeps what it must not lose (the set of agent ids it has seen started, the in-flight
and dropped counters) in `$.state`, and re-reads `$.agent.list()` at `session.start` to recover
agents started before the reload. Recording is idempotent: a second `session.start` writes nothing,
and an `agent.started` is sent only for an id not already in that set.

The lead (main session) is agent id `lead`. Tool calls, steps and turns with no `agentId` belong to
the lead. An `agentId` the recorder never saw in an `agent.spawn` (an engine fork for compaction or
memory) is ignored. A subagent resumed by `SendMessage` raises no `agent.spawn`, and a resumed agent
or a teammate raises `turn.complete` once per run, so `fold` lets a `done` agent go back to `running`
when new activity arrives.

`SendMessage` addresses agents by name, but the graph is keyed by agent id. The recorder logs
`to` exactly as given. `fold` resolves it in this order: strip a trailing ` [ref]` (the
disambiguation suffix ListAgents shows); `main`, or the lead's name in an agent team (`team-lead` in the teams seen so far), is `lead`;
a string equal to a known agent id is that agent; otherwise the most recently started agent with
that name in the swarm (a teammate name with a `-2` style suffix matches exactly, not by prefix).
A name it can't resolve becomes a placeholder node marked "unknown", so the message still shows
rather than being dropped.

**Protocol messages.** `session.send` carries plain-text messages only. SendMessage's protocol
payloads (`message` an object: `shutdown_request`, `shutdown_response`, `plan_approval_response`)
raise no `session.send`, so the recorder takes them from the `SendMessage` `tool.call` instead,
after `next`, and records them as `message.sent` with the summary `[shutdown_request]` (or
`[plan_approval_response] approve: no`, and so on). A plain-text SendMessage is never recorded from
`tool.call`, only from `session.send`, so nothing is counted twice. The `tool.call` path can't tell
whether a protocol message was delivered: a failed SendMessage comes back without `isError` (spike
Q2), so these are recorded when sent, not when delivered. That difference is accepted: they are rare
and the pane shows them as control messages, not chat.

## 7. Token usage

Changed by the mod API spike: there is no transcript reader. A mod can't read a file from an
offset, and `$.fs.read` stops at 4 MiB (a trivial subagent's transcript was already 450 KB). The
`turn.step` event gives the same figures live instead: every model request, the lead's or a
subagent's (`agentId`), resolves to a result whose `usage` is `{ input_tokens, output_tokens,
cache_read_input_tokens, cache_creation_input_tokens, model }`. For each step with a non-null
`usage` the recorder sends:

```json
{"type":"agent.usage","agent":"a8c5eb3dd61a2b303","data":{"model":"claude-opus-5-5",
 "input":2,"output":210,"cacheRead":0,"cacheWrite5m":42374,"cacheWrite1h":0}}
```

`turn.step` does not split cache writes into 5-minute and 1-hour, so all of
`cache_creation_input_tokens` goes into `cacheWrite5m` and cost stays labelled ≈. A 1-hour write
costs 2x the input price against 1.25x for 5 minutes, so where 1-hour caching is used the cache-write
part of the cost can be up to 37.5% low ((2 - 1.25) / 2). In the spike session every write was
priced as 5-minute (section 9's arithmetic). If the split turns
out to matter, the MCP server (which has Node) can read it from the transcripts at
`~/.claude/projects/<project>/<sessionId>/subagents/agent-<agentId>.jsonl`, deduplicating by
message id, since a transcript writes several lines per response.

## 8. Event log

Location: `.omnis-swarm/` in the project root, added to `.gitignore` on first write.

```
.omnis-swarm/current               id of the active swarm
.omnis-swarm/swarms/<swarmId>.jsonl
.omnis-swarm/swarms/<swarmId>.snap.json   periodic fold snapshot
```

Envelope (every line):

| Field | Type | Notes |
|---|---|---|
| `v` | int | Schema version, starts at 1 |
| `ts` | ISO-8601 string | Writer's clock, millisecond precision |
| `swarm` | string | Swarm id |
| `src` | `recorder` \| `transcripts` \| `mcp` | Who produced it. The MCP server appends the recorder's events with `src: recorder`. `transcripts` is reserved for a server-side transcript reader (section 7) and has no writer yet |
| `type` | string | One of the types below |
| `agent` | string? | Agent id the event is about |
| `data` | object | Type-specific, below |

Event types (v1):

| Type | `data` |
|---|---|
| `swarm.started` | `name`, `topology`, `goal?`, `implicit` |
| `swarm.ended` | `outcome?` |
| `agent.started` | `name`, `role`, `description`, `parent` |
| `agent.finished` | `outcome`, `reason?` |
| `agent.usage` | `model`, `input`, `output`, `cacheRead`, `cacheWrite5m`, `cacheWrite1h` |
| `agent.tool` | `phase`, `tool`, `kind`, `subject`, `isError` |
| `message.sent` | `to`, `summary` |
| `memory.put` | `key`, `bytes`, `preview` (first 80 chars) |
| `task.created` | `id`, `title`, `assignee?`, `dependsOn?` |
| `task.updated` | `id`, `state`, `assignee?`, `note?` |
| `session.measure` | `contextTokens?`, `contextWindow`, `contextPercent?`, `costUsd?` (added by the mod API spike, for phase 2) |

Rules:

- One event is one `appendFile` of one line ending in `\n`. Lines stay under 2 KB.
- Readers buffer a trailing partial line until its newline arrives.
- A line that fails to parse is skipped and counted (`state.gaps`).
- Events with `v` greater than the reader's version are ignored.
- Order is `ts`, then `src`, then file position. Writers never coordinate. Events are sorted per read batch, so clock skew between sessions can reorder events slightly; accepted. (Within one session the
  MCP server is now the only process that appends, but two sessions in one project can still both write.)
- Stored: names, models, numbers, paths, command lines up to 80 chars, message summaries up to
  200 chars, memory previews up to 80 chars. **Never** full prompts, tool output or file contents.
- Memory values themselves live in `.omnis-swarm/memory/<swarmId>.json`, written by the MCP
  server, so the log stays small.
- The log is a display record, not a trust boundary. Any process that can write the project folder
  can write lines, and any installed mod can try to call the server (the guard refuses unless a hook
  in a tier above ours overrides it). Nothing reads the log to decide what
  to run or allow. Readers treat every field as untrusted text when drawing it (length caps, no
  control characters).

A full field-by-field reference goes in `docs/event-log.md`, which the hub and WebGL window build against.

## 9. State and stats

`fold` is pure and incremental: `fold(state, event) → state`. The MCP server owns the folded
state: it folds each event as it appends it (and any lines another session appended, by following
the file), saves a snapshot every 500 events, and on start loads the latest snapshot and replays
only what follows. The pane never folds the log itself; it asks the server (section 10).

`SwarmState` holds the swarm (name, topology, start/end), agents by id, links keyed by
`from→to` (message count, last message time, recent summaries), memory keys, tasks, the feed
(the last 200 notable events), file touches by path, and `gaps`.

Per-agent stats and how each is worked out:

| Stat | Definition |
|---|---|
| Tokens | Sums of `input`, `output`, `cacheRead`, `cacheWrite5m + cacheWrite1h` |
| Cost ≈ | Each token class × `prices.ts` rate for the model; unknown model gives `null` |
| Model | Model of the latest `agent.usage` |
| Context fill | Latest call's `input + cacheRead + cacheWrite` ÷ the model's context window from `prices.ts` |
| Cache hit rate | `cacheRead ÷ (input + cacheRead + cacheWrite)` |
| Speed ≈ | Each call's `output` ÷ seconds since the agent's previous event; shown as a sparkline and a 30 s moving average |
| Activity | Count of `agent.tool` starts by `kind` |
| Files touched | Distinct `subject` paths for edit and read kinds |
| File clash | A path edited by two or more agents within 10 minutes |
| Messages | `message.sent` counts in and out |
| Status | `running` (tool or usage in the last 5 s), `waiting` (started, quiet), `done`, `failed` |
| Lifetime | `agent.started` to `agent.finished` or now |
| Stuck | Three `agent.tool` ends with `isError` in a row |

Swarm totals: tokens, cost ≈, burn rate ($/min over the last 5 minutes), session context %
(from Claude Code's `session.measure`, the official figure), busiest link, most expensive agent,
and task counts by state. Session context % is recorded by the recorder in phase 2 as a
`session.measure` event. Claude Code's `session.measure` carries `context: { tokens?, window,
percent? }` (percent a whole number, 0 to 100), `cost?: { usd }` (the session total as `/cost` has
it), `rateLimits` and `changed`. It fires after each main-loop turn, not after subagent turns, so the
figure refreshes when the lead finishes a turn. `cost.usd` includes subagent spend: in the spike
session each of its three steps equals the lead's and the subagent's `turn.step` usage in that
interval, priced at Opus 5.5 rates ($4 input, $20 output, $0.20 cache read, $5 cache write per MTok),
to within $0.0000003 (0.5080 / 0.0870 / 0.0396). The header may show Claude Code's session cost beside
OmnisSwarm's ≈ total, and the two should agree when prices are right.

Every ≈ figure is labelled ≈ in the pane. `prices.ts` is one table (model, rates per token
class, context window), so it's easy to update.

## 10. Pane

Opened with `/omnis pane` (alias `/omnis-swarm:watch`). User config `panel`: `command`
(default), `auto` (open when `omnis_swarm_init` is called or on any Agent tool call, fired in the
background so the tool call never waits), `off`. The pane's `session.start` handler matches only
`{ isInteractive: true }`, so it does nothing in a headless session.

The pane shows only the session's own swarm: the server answers with the session's swarm (section 5),
then its own hinted swarm, then `current` only when no session id is known. The look, motion, colours
and frame budget are set in [docs/design/pane.md](../../design/pane.md), which this section defers to.

Layout, top to bottom:

1. **Header:** swarm name, topology, agent count, cost ≈, tokens, burn rate, context %.
2. **Graph** (about 55% of the height):
   - Laid out by topology: tree for hierarchical, ring for mesh, hub-and-spokes for star.
   - Node size grows with tokens; colour by model; outer ring shows context fill
     (amber from 70%, red from 90%).
   - Nodes fade in on start, glow while running, dim to a ghost when done; failed nodes stay red.
   - A message fires a comet of particles along its link with a fading trail; link thickness
     grows with message count.
   - Tool calls flicker the node in a colour per kind; errors pulse red; a file clash flashes
     both nodes with a dashed line between them.
   - A row of agent chips under the graph: the view-only pin control.
3. **Spotlight card:** every per-agent stat for one agent, with sparklines for speed and tokens.
   It follows the busiest agent (holding each for at least 5 s) until a chip pins one; pressing
   the pinned chip again unpins.
4. **Timeline:** one row per agent showing its lifetime; running rows extend live.
5. **Flow feed:** messages, memory writes and task changes, newest first.

Size steps, as the pane shrinks: drop the timeline, then reduce the spotlight to one line, then
replace the graph with an indented tree, and finally show a one-line summary.

Rendering: `render` returns a `Frame`: two cell grids (glyph plus 24-bit foreground and background
per cell), each painted as its own `Raster`, plus the pin chips. It uses half-block glyphs for two true-colour pixels per cell, and braille for fine
lines and particles. Fades are done by blending each colour toward the background. The terminal's
`Raster` paints at most 1024 distinct foreground/background pairs at once (the rest snap to the
nearest), so glow and fade ramps are quantised to a fixed palette that keeps a frame under that.
A `Raster` is at most 512 columns by 256 rows. The frame loop is a `$.clock.every` timer calling
`$.ui.blit` (up to 120 blits a second taken, about 60 shown); a full redraw
(`$.ui.invalidate('ui.render')`, at most 30 a second for a shown pane) happens only on a resize or
a layout change. Values the drawing reads live in `$.state`, since a hot reload drops module
variables. The pane gets swarm state from the MCP server, not by reading the log file: `$.fs.read`
stops at 4 MiB and can't read from an offset. It pulls with the internal tool
`omnis_feed({ since })`: `since: 0` answers the folded `SwarmState` plus the offset it reflects;
`since: N` answers the events appended after offset N (at most 500) with the new offset. Past 500
events, or when N is too old, it answers a fresh `state` instead, with no "more waiting" flag.
Claude Code caps MCP tool output near 50,000 characters, so every reply is kept under 40,000 bytes
(`src/core/feed-reply.ts`, `src/mcp/tools/feed.ts`): event replies are paged under that cap, and a
state reply is trimmed in a fixed order (oldest feed items, then per-agent detail, then finished
agents past the 20 most recent, which the pane hides and counts as "+N finished"). Running and
waiting agents are never left out, so the ceiling is about 60 running agents. Past that the server
answers `too-large` and the pane says the swarm is too large to draw.

Pulls run on a `$.clock.every` timer at most 4 times a second (every 250 ms), only while the pane is
placed and shown (`$.ui.open` answered `isPlaced` and no `ui.close` since), and stop when it closes.
After 8 empty replies they slow to every 1.5 s, and return to 250 ms on news, a resize, a re-render
or a pin press. While replies are unreadable they back off, doubling up to 5 s. One pull is in flight at a time
(an awaited call measured 33-88 ms, spike A1). `omnis_feed` is guarded like `omnis_record`
(section 6). The frame loop doesn't stop when nothing moves: while the pane is shown it drops to
`FPS.tick` (1 fps) so clock-driven text (ages, live timeline bars) keeps updating, and it stops only
when the pane is hidden or closed. The rates and the budget (at most 10% of the main thread) are in
[pane.md](../../design/pane.md) sections 6 and 11.

What is verified about `Raster`: the 512 x 256 bounds (the engine refuses 513 columns and 257
rows) and the cell encoding. From the docs only: the 1024-pair palette, the blit rates and how it
looks in a real terminal. Phase 3 checks those in an interactive session first. On a surface that offers `Svg` instead of `Raster` (the desktop app),
the same frame is converted to a static SVG redrawn on each render (the `Svg` path is used only off
the terminal).

The chips are the only interactive element. They change what the pane shows and nothing else.

## 11. Error handling

The rule: OmnisSwarm never breaks or slows the session. Failures make it show less, never act differently.

| Failure | Behaviour |
|---|---|
| Function hooks off (policy: `disableAllHooks`, `allowManagedHooksOnly`, `allowManagedModsOnly`) | MCP tools still work, including the internal `omnis_record` and `omnis_feed`, which are then unguarded (accepted: the log is a display record, section 8); no recorder or pane. Claude Code 2.1.306 needs no environment variable to load mods |
| MCP server unreachable from the mod | `$.mcp.call` fails; the event is dropped and counted; the session is untouched |
| MCP server killed or crashed | In-flight calls resolve `isError` ("Connection closed"); Claude Code starts a new server on the next call (verified); those events are lost and counted; the new server rebuilds from `.omnis-swarm/` |
| MCP server slow | Recorder calls are not awaited, so hooks return at once (a 2 s call was measured with no delay to the session); past 64 in flight, events are dropped and counted |
| Model calls an internal tool (`omnis_record`, `omnis_feed`) | Denied at `tool.check` by origin; the model reads the reason; nothing written |
| Recorder handler throws | Caught; event dropped; `next` result passed through unchanged |
| Log write fails | Retried once, then dropped; pane shows a "log gaps" marker |
| Torn or corrupt line | Skipped and counted; folding continues |
| Newer `v` | Event ignored |
| No usage for an agent yet (no `turn.step` with usage) | That agent's tokens and cost show "–" |
| Unknown model | Tokens shown; cost and context fill show "–" |
| Pane too small | Size steps from section 10 |
| Slow frames | Frame rate drops to stay within the 10% main-thread budget; when idle it runs at `FPS.tick` (1 fps) while shown, and stops when hidden or closed |
| Swarm too large for one `omnis_feed` reply (about 60 running agents) | Server answers `too-large`; the pane keeps the last good state and shows "⚠ Swarm too large to draw (n agents)" |
| `omnis_feed` reply unreadable (fails to parse, or Claude Code saved it to a file) | Pane keeps the last good state, shows "⚠ Waiting for the swarm…", and pulls back off to every 5 s |
| Large log | Snapshot plus replay of the tail |
| MCP bad input | Tool error returned; nothing written |

## 12. Testing

Coverage target: everything in `core` and `render` fully unit-tested; every other unit tested
through its public interface. Mock-first for the mod API and file system.

- **core:** `fold` against recorded fixtures; torn and corrupt lines; ordering across writers;
  version skipping; snapshot plus replay equals a full replay; stats formulas against hand-worked numbers.
- **render:** golden grid snapshots per size step at fixed times; fade and particle maths at known frames.
- **mcp:** each tool through the MCP protocol in-process; checks appended events and input validation.
- **recorder:** fake `agent.spawn`, `tool.call`, `turn.step`, `turn.complete`, `session.send`,
  `session.measure` (shapes as recorded in the mod API spike); `next` always called and its result
  unchanged, including when the handler throws or `$.mcp.call` rejects; the guard allows our own
  origin and denies `engine`/other plugins.

How the suites run: `node --test` covers `core`, `render` and `mcp` (as `npm test` does now). Mod
tests are `*.test.ts` files beside the mod code, run by `claude plugin test .` against the engine
itself, so they need the `claude` CLI. `npm run check` becomes typecheck, then `npm test`, then
`npm run test:mod` (`claude plugin test .`), plus `claude plugin validate .` so a mod that imports
Node or passes `$` where the engine can't follow it fails the check. Where `claude` isn't on PATH,
`test:mod` prints that it was skipped and exits non-zero only under `CI=1`. Mod test files must
not sit under `tests/`, or `node --test` would pick them up without the engine. The mod side gets its
own `tsconfig.mod.json` (covering `src/mod/`, `src/render/` and the core files they import) with
`"types": []` (no `@types/node`), `"lib": ["ES2024"]`, the engine's `claude-code` declarations, and a small
ambient file declaring only the web globals a mod has (`TextEncoder`, `structuredClone`, `setTimeout` and the
like, per the spike's run-time list). So `Buffer`, `process` or `require` in a mod file fails the
typecheck; `npm run typecheck` runs both configs.
- **e2e:** a scripted 5-agent swarm log rendered headless through the pane; checks the expected nodes, links and totals.

## 13. Later: hub server and WebGL window

Not built in v1. Documented here so it's a straight build later.

**Hub** (`src/hub/`, run with `/omnis hub` or `npx omnis-swarm hub`):

- Binds `127.0.0.1` only, default port 7717, with the port written to `.omnis-swarm/hub.json`.
- Requires a random token generated at start, written to `hub.json`, and passed as
  `?token=` on connect. Other origins are rejected.
- Follows the current swarm's log with `core/log.ts` (the same code the MCP server uses; the pane can't, as mods have no Node).
- WebSocket at `/stream`. On connect it sends
  `{"kind":"snapshot","state":<SwarmState>}`, then each new log line unchanged as
  `{"kind":"event","event":<envelope>}`. When the current swarm changes it sends
  `{"kind":"swarm","id":"…"}` followed by a new snapshot.
- Serves the WebGL app's static files at `/`.
- Exits when the session ends or after 10 minutes with no clients.

**WebGL window:** a static web app using `core/fold.ts` and `core/stats.ts` unchanged
(they're pure and have no Node dependencies, which is the reason for keeping them that way).
It draws the same encodings as the pane with real alpha, blur, glow and particles. The hub's
messages are the only interface between the two.

## 14. Phases

1. **Core and MCP:** events, log, fold, stats, prices, the MCP server and tools, with tests.
2. **Recorder:** mod handlers (including `turn.step` usage) and the MCP server's recording tool, with tests.
3. **Pane:** render units and pane wiring, golden tests, e2e.
4. **Packaging:** plugin manifest, marketplace repo under `Fortitude-Group`, install check in a
   fresh project, and wiring OmnisSwarm into `init-project.ps1` and `setup.ps1`.
5. **RuFlo removal** (only after OmnisSwarm has run a real multi-agent session correctly):
   remove RuFlo from `init-project.ps1` and `setup.ps1`; rewrite the swarm and fan-out rules in
   `~/.claude/CLAUDE.md` and the project template CLAUDE.md to name OmnisSwarm; add an
   `init-project.ps1 -RemoveRuFlo` step that deletes `.claude-flow/`, `.swarm/` and RuFlo's
   hooks, plugins and MCP entry from a project, after showing what it will remove.

Phases 2 and 3 both depend only on phase 1 and can run in parallel; `render` can start as soon
as `SwarmState` is fixed. Both now add an MCP tool (phase 2 `omnis_record`, phase 3 `omnis_feed`),
so to keep them from colliding, the server is laid out as follows. `tools.ts` holds the phase 1
`omnis_*` tools. `session.ts` holds the per-session swarm state and the held folded state, and every
tool factory receives it in its `ToolContext`. `registry.ts` lists the tool factories. Each later
tool is one new file in `src/mcp/` plus one line in `registry.ts`: neither phase edits `tools.ts`,
`session.ts` or `server.ts`. The integrator owns `registry.ts` and the plugin manifest, and adds each
phase's line when that phase merges.

## 15. Assumptions to check early

These came from reading RuFlo's working source. The mod API spike
([docs/spikes/2026-10-21-mod-api.md](../../spikes/2026-10-21-mod-api.md), Claude Code 2.1.306) checked
each one against the engine's own type declarations and a probe session.

- ✅ `agent.spawn`'s `result.agentId` matches the `agent-<id>.jsonl` transcript name exactly (spike Q1).
- ✏️ `tool.call` exposes `SendMessage`'s `to`, `message` and `summary`, but `session.send` is the better
  source: it says whether the message was delivered. The lead's address is `main` or its team name
  (`team-lead`), with a trailing ` [ref]` stripped, as in section 6 (spike Q2).
- ✅ `turn.complete` fires once per subagent run with its `agentId`. Reasons are `answer`, `aborted`,
  `refusal` and `error`. A resumed agent or a teammate finishes once per run (spike Q3).
- ✏️ `Raster`, partly verified: the 512 x 256 bounds and the cell encoding were checked against the
  engine. The blit rate (up to 120 a second, about 60 shown) and the 1024-colour-pair palette are from the
  docs only (spike Q6).
- ✅ Plugin MCP servers run `.ts` with Node's type stripping and no build. They start in the project
  directory, and `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PROJECT_DIR}` expand in `args` and `env` (spike Q7).
- ✏️ Function hooks are early access, but 2.1.306 loaded the mod without
  `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS`. What turns them off is policy (`disableAllHooks`,
  `allowManagedHooksOnly`, `allowManagedModsOnly`).
- ✏️ New, from the spike: a hooks module has no Node. It imports only its own files and `claude-code`,
  has no Node globals (`Buffer`, `process`, `require`), and `$.fs` has no append, no offset reads and a
  4 MiB cap. Sections 4, 6, 7 and 10 changed to match (spike Q5, round 2).
- ✅ New, from the spike: mod → `$.mcp.call` → our own MCP server works. Calls arrive in hook order,
  an awaited call takes 33-88 ms, a 2 s call doesn't delay the session, and a killed server is
  restarted on the next call (spike A1).
- ✏️ New, from the spike: a server tool can't be hidden from the model. `$.mcp.call` reaches only
  listed tools, `tool.describe` can only defer one. Internal tools are guarded by origin at
  `tool.check` instead, which was verified to deny the model and allow the mod (spike A1).
- ✅ A mod can import from parent folders inside the plugin (`../lib/x.ts`), in validation and at
  load (spike A2).
