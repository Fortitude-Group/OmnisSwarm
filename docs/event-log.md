# OmnisSwarm event log (v1)

Everything OmnisSwarm knows about a swarm is in one append-only file. Readers, including the
pane, the future hub and any WebGL window, rebuild state by folding these lines in order.
`src/core/events.ts` is the source of truth. This page explains it.

## Files

```
.omnis-swarm/current                      id of the active swarm (one line)
.omnis-swarm/swarms/<swarmId>.jsonl       the log
.omnis-swarm/swarms/<swarmId>.snap.json   fold snapshot: {"v":1,"offset":<bytes>,"state":<SwarmState>}
.omnis-swarm/memory/<swarmId>.json        memory values: {"<key>":{"value","writer","at"}}
```

Swarm ids are lowercase and match `^[a-z0-9][a-z0-9._-]{0,63}$`. They never contain `..`, never end
in `.`, and are never a Windows device name (`con`, `prn`, `aux`, `nul`, `com0`-`com9`, `lpt0`-`lpt9`),
with or without an extension, because ids become file names. `src/core/events.ts` (`isValidSwarmId`)
is the rule.

## Envelope

Each line is one JSON object, then `\n`, at most 2048 bytes. Within one session the server is the
only writer to the file: it stamps `v`, `swarm` and `src`. The recorder mod can't write files (a mod
has no Node), so it hands each event to the server's internal `omnis_record` tool, which checks it
and appends it with `src: "recorder"`.

The server can't tell whether the recorder mod is installed, so it always offers `omnis_record`. When
mods are off the internal tools are unguarded. That is accepted: the log is a display record, and the
same user could edit `.omnis-swarm` directly.

| Field | Type | Notes |
|---|---|---|
| `v` | int | Schema version, stamped by the server. Readers skip lines with a higher `v` than they know |
| `ts` | string | ISO-8601 UTC, millisecond precision, stamped by the mod for recorder events, by the server for mcp events |
| `swarm` | string | Swarm id, stamped by the server |
| `src` | `"mcp"` \| `"recorder"` \| `"transcripts"` | Which source, stamped by the server. `transcripts` is reserved: nothing writes it now, but it stays valid so old logs parse |
| `type` | string | Event type, below |
| `agent` | string, optional | Agent id the event is about. Absent means the lead (`"lead"`) |
| `data` | object | Per type, below |

## Event types

| Type | Writer | `data` |
|---|---|---|
| `swarm.started` | mcp | `name`, `topology` (`hierarchical`\|`mesh`\|`star`), `goal?`, `implicit` (bool), `session?` (the sessionKey of the session that started it: the first 16 hex characters of sha256 of the Claude Code session id, never the raw id). A second one for the same swarm renames it. The first one's `session` says which session owns the swarm, so a restarted server can tell its own swarm from another session's |
| `swarm.ended` | mcp | `outcome?` |
| `agent.started` | recorder | `name`, `role`, `description` (≤120), `parent` (agent id or `lead`) |
| `agent.finished` | recorder | `outcome` (`answer`\|`aborted`\|`failed`), `reason?` (≤80) |
| `agent.usage` | recorder (written through the server) | `model`, `input`, `output`, `cacheRead`, `cacheWrite5m`, `cacheWrite1h` (token counts for one API call), `requested?` (≤80: the model the request named, present only when a gateway such as OmnisRouter answered with another; ids that differ only by case, a `[1m]`-style suffix or a `-YYYYMMDD` date count as the same) |
| `agent.tool` | recorder | `phase` (`start`\|`end`), `tool`, `kind` (`read`\|`edit`\|`bash`\|`search`\|`web`\|`agent`\|`other`), `subject` (path or command, ≤80), `isError` |
| `message.sent` | recorder | `to` (agent **name** as given to SendMessage), `summary` (≤200) |
| `memory.put` | mcp | `key`, `bytes`, `preview` (≤80). The envelope `agent` is the writer's name as given to the tool (default `lead`), not an agent id |
| `task.created` | mcp | `id` (`t1`, `t2`…), `title` (≤120), `assignee?`, `dependsOn?`. Two sessions sharing a swarm can both create the same id; the last write wins (accepted) |
| `task.updated` | mcp | `id`, `state` (`pending`\|`active`\|`done`\|`failed`), `assignee?`, `note?` (≤200) |
| `session.measure` | recorder | `contextWindow`, `contextTokens?`, `contextPercent?` (0-100), `costUsd?`. Lead-level, no `agent`. Merged into the session figures: a field left out keeps its previous value. Percent is clamped to 0-100 |
| `budget.set` | mcp (`omnis_swarm_init` with a `budget`) or recorder (`/omnis budget`) | `agentMinutes?`, `agentUsd?`, `swarmUsd?`: at least one, each above 0 and at most 1440 minutes, $1000 and $1000. Swarm-level, no `agent`. Overrides the configured limits for the rest of the swarm; a key left out keeps its previous value |
| `guard.warned` | recorder | `limit` (`time`\|`agentCost`\|`swarmCost`), `value`, `threshold` (minutes for `time`, USD otherwise, both at most 1,000,000). `agent` is required for `time` and `agentCost` and absent for `swarmCost` |
| `guard.nudged` | recorder | `limit` (`time`\|`agentCost`), `value`, `threshold`, `delivered` (bool: whether the wrap-up message reached the agent), `reason?` (≤80, why it was not delivered). `agent` is required |
| `guard.blocked` | recorder | `value`, `threshold` (USD): the swarm reached its budget and the lead's new agents are refused until it is raised or the swarm ends. Swarm-level, no `agent` |

`omnis_record` answers `ok <swarm>`, naming the swarm the event landed in, so the mod's budget guard
knows which swarm it is folding. `omnis_replay` and `omnis_export` are internal tools like
`omnis_record` and `omnis_feed`: the mod refuses them when the model calls them.

## Reading rules

1. Read from your last byte offset to the last `\n`. Keep any trailing partial line for next time.
2. If the file is now shorter than your offset, it was replaced: start again from 0 with empty state.
3. A line that doesn't parse or has the wrong shape is skipped and counted as a gap. A line with a newer `v` is skipped too, but is not a gap.
4. Order events by `ts`, then `src` (`mcp` < `recorder` < `transcripts`), then file position.
5. `message.sent.to` is a name. A trailing ` [ref]` (a space and a bracketed token, such as
   `coder [3fa9c1]`) is stripped first. Then resolve it in this order: a known agent id; the lead
   aliases `main`, `lead` and `team-lead`; the most recently started agent with that name; otherwise
   a placeholder node `?<name>`.
6. Snapshots are an optimisation. Loading a snapshot then replaying from its `offset` must give
   the same state as replaying the whole file.
7. An agent that has finished runs again on a later `agent.started` or `agent.tool` with phase
   `start`. Its outcome clears and its run count goes up. A later `agent.usage` adds its tokens and
   cost but leaves it finished.
8. A `recorder` event may carry `data.dropped`: how many events the recorder dropped since its last
   call that reached the server (too many in flight, or the server was restarting). Add it to the gap
   count. It is not part of the event's own data.

## What is never in the log

Full prompts, tool output, file contents and memory values. Only names, models, numbers, paths,
command lines up to 80 characters, message summaries up to 200 and memory previews up to 80. A
memory value never appears beyond that redacted 80-character preview.

The log is a display record, not a trust boundary. Anything that can write to it can put any text
in a pane, so readers treat every field as untrusted and never act on it.

## Later: the hub stream

The hub (spec section 13) sends `{"kind":"snapshot","state":<SwarmState>}` on connect, then
`{"kind":"event","event":<envelope>}` for each new line, and `{"kind":"swarm","id":"…"}` when the
current swarm changes. Every envelope is byte-for-byte what is in the file.
