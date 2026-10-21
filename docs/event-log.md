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

Swarm ids match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` and never contain `..`.

## Envelope

Each line is one JSON object, then `\n`, at most 2048 bytes.

| Field | Type | Notes |
|---|---|---|
| `v` | int | Schema version. Readers ignore lines with a higher `v` than they know |
| `ts` | string | ISO-8601 UTC, millisecond precision, writer's clock |
| `swarm` | string | Swarm id |
| `src` | `"mcp"` \| `"recorder"` \| `"transcripts"` | Which writer |
| `type` | string | Event type, below |
| `agent` | string, optional | Agent id the event is about. Absent means the lead (`"lead"`) |
| `data` | object | Per type, below |

## Event types

| Type | Writer | `data` |
|---|---|---|
| `swarm.started` | mcp, recorder | `name`, `topology` (`hierarchical`\|`mesh`\|`star`), `goal?`, `implicit` (bool). A second one for the same swarm renames it |
| `swarm.ended` | mcp | `outcome?` |
| `agent.started` | recorder | `name`, `role`, `description` (≤120), `parent` (agent id or `lead`) |
| `agent.finished` | recorder | `outcome` (`answer`\|`aborted`\|`failed`), `reason?` (≤80) |
| `agent.usage` | transcripts | `model`, `input`, `output`, `cacheRead`, `cacheWrite5m`, `cacheWrite1h` (token counts for one API call) |
| `agent.tool` | recorder | `phase` (`start`\|`end`), `tool`, `kind` (`read`\|`edit`\|`bash`\|`search`\|`web`\|`agent`\|`other`), `subject` (path or command, ≤80), `isError` |
| `message.sent` | recorder | `to` (agent **name** as given to SendMessage), `summary` (≤200) |
| `memory.put` | mcp | `key`, `bytes`, `preview` (≤80) |
| `task.created` | mcp | `id` (`t1`, `t2`…), `title` (≤120), `assignee?`, `dependsOn?` |
| `task.updated` | mcp | `id`, `state` (`pending`\|`active`\|`done`\|`failed`), `assignee?`, `note?` (≤200) |

## Reading rules

1. Read from your last byte offset to the last `\n`. Keep any trailing partial line for next time.
2. If the file is now shorter than your offset, it was replaced: start again from 0 with empty state.
3. A line that doesn't parse or has the wrong shape is skipped and counted as a gap.
4. Order events by `ts`, then `src` (`mcp` < `recorder` < `transcripts`), then file position.
5. `message.sent.to` is a name. Resolve it to the most recently started agent with that name, or
   `lead`. If nothing matches, show a placeholder node `?<name>`.
6. Snapshots are an optimisation. Loading a snapshot then replaying from its `offset` must give
   the same state as replaying the whole file.

## What is never in the log

Full prompts, tool output, file contents and memory values. Only names, models, numbers, paths,
command lines up to 80 characters, message summaries up to 200 and memory previews up to 80.

## Later: the hub stream

The hub (spec section 13) sends `{"kind":"snapshot","state":<SwarmState>}` on connect, then
`{"kind":"event","event":<envelope>}` for each new line, and `{"kind":"swarm","id":"…"}` when the
current swarm changes. Every envelope is byte-for-byte what is in the file.
