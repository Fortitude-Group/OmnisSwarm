# OmnisSwarm — design

Date: 2026-10-21
Status: approved in brainstorming, awaiting spec review

## 1. Summary

OmnisSwarm is a cut-down replacement for RuFlo. It keeps only the agent-swarm parts and adds
a rich, read-only visual pane inside Claude Code that shows the running agents, the links
between them, the information moving along those links, and detailed stats for every agent.

Claude Code's own Agent tool runs the agents. OmnisSwarm records the swarm's structure
(topology, roles, shared memory, tasks), watches what the agents actually do through
Claude Code's hooks, and writes everything to an append-only event log. The pane draws
from that log. A full WebGL window can later read the same log.

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
 ├─ Agent tool / SendMessage / tool calls ──▶ Recorder (mod)          ─┐
 ├─ subagent + lead transcripts (.jsonl) ───▶ Transcript reader (mod) ─┤ append
 └─ Claude calls omnis_* tools ────────────▶ MCP server (stdio)       ─┤
                                                                       ▼
                                   .omnis-swarm/swarms/<swarmId>.jsonl
                                                                       │ follow
                                      ┌────────────────────────────────┤
                                      ▼                                ▼
                               Pane (mod, Raster)         (later) hub ─▶ WebGL window
```

Units, each with one job and a typed interface:

| Unit | Job | Depends on |
|---|---|---|
| `core` | Event types, append, follow, pure `fold(events) → SwarmState`, price table | nothing |
| `mcp` | `omnis_*` tools; writes swarm, memory and task events | core |
| `recorder` | Mod handlers; turns Claude Code events into log events | core, mod API |
| `transcripts` | Follows transcript files; writes `agent.usage` | core |
| `render` | Pure `render(state, view, nowMs, size) → Grid`; layout, glow, particles | core |
| `pane` | Mod pane: opens, follows the log, calls `render`, handles pin chips | core, render, mod API |

Repository layout (`Fortitude-Group/OmnisSwarm`, which is also its own plugin marketplace):

```
.claude-plugin/plugin.json        plugin manifest (MCP server, mod modules, user config)
.claude-plugin/marketplace.json   single-plugin marketplace
src/core/       events.ts  log.ts  fold.ts  stats.ts  prices.ts
src/mcp/        server.ts  tools/*.ts
src/mod/        register.ts  recorder.ts  transcripts.ts  pane.ts
src/render/     layout.ts  graph.ts  spotlight.ts  timeline.ts  feed.ts  fx.ts  grid.ts
tests/          mirrors src/, plus fixtures/ and e2e/
docs/           this spec, event-log reference, hub protocol
```

Runtime: TypeScript on Node 24 with no native dependencies. Mods are loaded by Claude Code
as `.ts` (as RuFlo's are). The MCP server runs with Node's built-in type stripping, so there is
no build step, if that holds up in practice (see section 15). No file over 500 lines.

## 5. Swarm model and MCP tools

All tools are prefixed `omnis_` so they never clash with RuFlo or anything else.

| Tool | Input | Effect |
|---|---|---|
| `omnis_swarm_init` | `name`, `topology` (`hierarchical` \| `mesh` \| `star`), `goal?` | `swarm.started`; becomes `current` |
| `omnis_swarm_end` | `outcome?` | `swarm.ended` |
| `omnis_swarm_status` | none | Returns folded state as compact text (agents, tasks, totals) |
| `omnis_memory_put` | `key`, `value` (≤ 4 KB), `agent?` | `memory.put` |
| `omnis_memory_get` | `key` | Returns value from folded state |
| `omnis_memory_list` | `prefix?` | Returns keys with writer and time |
| `omnis_task_create` | `title`, `assignee?`, `dependsOn?` | `task.created`, returns task id |
| `omnis_task_update` | `id`, `state` (`pending` \| `active` \| `done` \| `failed`), `assignee?`, `note?` | `task.updated` |

There is deliberately no message tool or agent-register tool. Agents message each other
with Claude Code's `SendMessage` and are spawned with the Agent tool. The recorder sees both.

Inputs are validated at the boundary: lengths capped, enums checked, keys limited to
`[A-Za-z0-9._/-]{1,128}`. Invalid input returns a tool error and writes nothing.

**Implicit session swarm.** If agents start with no current swarm, the recorder writes a
`swarm.started` with `topology: hierarchical`, `name: session-<first 8 of session id>`,
`implicit: true`. A later `omnis_swarm_init` in the same session renames and retypes that swarm
instead of starting a second one.

## 6. Recorder

Mod handlers, all observe-only. Each handler is wrapped so it always calls `next` and passes
the result through unchanged, even if the handler throws.

| Claude Code event | Log event |
|---|---|
| `session.start` | Remembers the session id and the transcript folder; no log write |
| `agent.spawn` (after `next`, with `result.agentId`) | `agent.started`: `name`, `role` (`subagentType`), `description` (≤ 120 chars), `parent` (spawning agent id, or `lead`) |
| `turn.complete` with `agentId` | `agent.finished`: `outcome` = `answer` \| `aborted` \| `failed`, plus reason (≤ 80 chars) |
| `tool.call` (before and after `next`) | `agent.tool`: `phase` `start`/`end`, `tool`, `kind` (read, edit, bash, search, web, agent, other), `subject` (path or command, ≤ 80 chars), `isError` |
| `tool.call` where `tool` is `SendMessage` | `message.sent`: `to`, `summary` (first 200 chars) |
| `ui.render` / `ui.close` / `command.run` | Pane only, see section 10 |

The lead (main session) is agent id `lead`. Tool calls with no `agentId` belong to the lead.

`SendMessage` addresses agents by name, but the graph is keyed by agent id. The recorder logs
`to` exactly as given. `fold` resolves it to the most recently started agent with that name in
the swarm (or `lead`). A name it can't resolve becomes a placeholder node marked "unknown",
so the message still shows rather than being dropped.

## 7. Transcript reader

Subagent transcripts are at
`~/.claude/projects/<project>/<sessionId>/subagents/agent-<agentId>.jsonl` (checked on this
machine). Each assistant line carries `message.model`, `message.usage` and `timestamp`.

The reader follows the lead's transcript and the transcript of every agent the recorder has
seen start. For each new assistant line it appends:

```json
{"type":"agent.usage","agent":"a050fac0e3c57d55a","data":{"model":"claude-opus-4-8",
 "input":2,"output":9,"cacheRead":0,"cacheWrite5m":59077,"cacheWrite1h":0}}
```

It keeps a byte offset per file, so each line is read once. It polls only while a swarm is
active, and stops following an agent 30 s after `agent.finished`.

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
| `src` | `recorder` \| `transcripts` \| `mcp` | Writer |
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

Rules:

- One event is one `appendFile` of one line ending in `\n`. Lines stay under 2 KB.
- Readers buffer a trailing partial line until its newline arrives.
- A line that fails to parse is skipped and counted (`state.gaps`).
- Events with `v` greater than the reader's version are ignored.
- Order is `ts`, then `src`, then file position. Writers never coordinate.
- Stored: names, models, numbers, paths, command lines up to 80 chars, message summaries up to
  200 chars, memory previews up to 80 chars. **Never** full prompts, tool output or file contents.
- Memory values themselves live in `.omnis-swarm/memory/<swarmId>.json`, written by the MCP
  server, so the log stays small.

A full field-by-field reference goes in `docs/event-log.md`, which the hub and WebGL window build against.

## 9. State and stats

`fold` is pure and incremental: `fold(state, event) → state`. A snapshot is saved every 500
events; opening the pane loads the latest snapshot and replays only what follows.

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
and task counts by state.

Every ≈ figure is labelled ≈ in the pane. `prices.ts` is one table (model, rates per token
class, context window), so it's easy to update.

## 10. Pane

Opened with `/omnis pane` (alias `/omnis-swarm:watch`). User config `panel`: `command`
(default), `auto` (open when a swarm starts), `off`.

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

Rendering: `render` draws into a cell grid (glyph plus 24-bit foreground and background per
cell). It uses half-block glyphs for two true-colour pixels per cell, and braille for fine
lines and particles. Fades are done by blending each colour toward the background. The frame
loop runs only while something is animating, lowers its rate if a frame takes too long, and
stops when nothing moves. On a surface that offers `Svg` instead of `Raster` (the desktop app),
the same grid is converted to a static SVG redrawn on each render.

The chips are the only interactive element. They change what the pane shows and nothing else.

## 11. Error handling

The rule: OmnisSwarm never breaks or slows the session. Failures make it show less, never act differently.

| Failure | Behaviour |
|---|---|
| Function hooks off | MCP tools still work; one notice names the setting to turn on |
| Recorder handler throws | Caught; event dropped; `next` result passed through unchanged |
| Log write fails | Retried once, then dropped; pane shows a "log gaps" marker |
| Torn or corrupt line | Skipped and counted; folding continues |
| Newer `v` | Event ignored |
| Transcript missing or unreadable | That agent's tokens and cost show "–" |
| Unknown model | Tokens shown; cost and context fill show "–" |
| Pane too small | Size steps from section 10 |
| Slow frames | Frame rate drops; animation stops when idle |
| Large log | Snapshot plus replay of the tail |
| MCP bad input | Tool error returned; nothing written |

## 12. Testing

Coverage target: everything in `core` and `render` fully unit-tested; every other unit tested
through its public interface. Mock-first for the mod API and file system.

- **core:** `fold` against recorded fixtures; torn and corrupt lines; ordering across writers;
  version skipping; snapshot plus replay equals a full replay; stats formulas against hand-worked numbers.
- **render:** golden grid snapshots per size step at fixed times; fade and particle maths at known frames.
- **mcp:** each tool through the MCP protocol in-process; checks appended events and input validation.
- **recorder:** fake `agent.spawn`, `tool.call`, `turn.complete`; `next` always called and its
  result unchanged, including when the handler throws.
- **transcripts:** anonymised fixtures from real subagent transcripts, including cache fields and partial lines.
- **e2e:** a scripted 5-agent swarm log rendered headless through the pane; checks the expected nodes, links and totals.

## 13. Later: hub server and WebGL window

Not built in v1. Documented here so it's a straight build later.

**Hub** (`src/hub/`, run with `/omnis hub` or `npx omnis-swarm hub`):

- Binds `127.0.0.1` only, default port 7717, with the port written to `.omnis-swarm/hub.json`.
- Requires a random token generated at start, written to `hub.json`, and passed as
  `?token=` on connect. Other origins are rejected.
- Follows the current swarm's log with `core/log.ts` (the same code the pane uses).
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
2. **Recorder and transcripts:** mod handlers and transcript reader, with tests.
3. **Pane:** render units and pane wiring, golden tests, e2e.
4. **Packaging:** plugin manifest, marketplace repo under `Fortitude-Group`, install check in a
   fresh project, and wiring OmnisSwarm into `init-project.ps1` and `setup.ps1`.
5. **RuFlo removal** (only after OmnisSwarm has run a real multi-agent session correctly):
   remove RuFlo from `init-project.ps1` and `setup.ps1`; rewrite the swarm and fan-out rules in
   `~/.claude/CLAUDE.md` and the project template CLAUDE.md to name OmnisSwarm; add an
   `init-project.ps1 -RemoveRuFlo` step that deletes `.claude-flow/`, `.swarm/` and RuFlo's
   hooks, plugins and MCP entry from a project, after showing what it will remove.

Phases 2 and 3 both depend only on phase 1 and can run in parallel; `render` can start as soon
as `SwarmState` is fixed.

## 15. Assumptions to check early

These come from reading RuFlo's working source, not from official Claude Code docs. Each gets a
spike at the start of the phase that needs it.

- `agent.spawn`'s `result.agentId` matches the `agent-<id>.jsonl` transcript name (phase 2).
- `tool.call` exposes `SendMessage`'s `to` and `message` arguments (phase 2).
- `turn.complete` fires once per subagent with its `agentId` and a reason (phase 2).
- `Raster` size limits and how fast frames can be pushed (phase 3).
- Plugin MCP servers can run `.ts` with Node's type stripping and no build (phase 1). If not,
  ship compiled JS from a small build script.
- Function hooks need `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` and are early access; the plugin
  depends on them for the pane and recorder.
