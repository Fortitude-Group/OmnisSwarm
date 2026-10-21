# Recorder live check (phase 2, task 9)

Run on 2026-10-21 against branch `phase2-3` at `caac44b`, Claude Code 2.1.306, Windows 10, Node 24.19.0.
Every session ran headless from a fresh empty folder under the session scratchpad (`p2-live/project*`), never
inside the repo, with `--plugin-dir C:/projects/personal/OmnisSwarm`. Prompts only read or wrote inside that folder.

## The runs

| Run | Folder | Session | What it was for |
|---|---|---|---|
| A | `project` | `5c7ab4bd-…` | The plan's Task 9 run: model tries `omnis_record`, one subagent (Glob, SendMessage to main), a protocol `shutdown_request`, then `omnis_swarm_status`. `--settings` adds a catch-all `PreToolUse` command hook. Permission mode from user settings (`auto`). |
| B | `projectB` | `fc380593-…` | Same plugin plus a throwaway probe plugin (`p2-live/p2t9-probe`): its mod logs `$.plugin.name` and `next.origin` on `tool.check`, and calls its own MCP tool for large replies. |
| C | `projectC` | `e7fd0b52-…` | `--permission-mode bypassPermissions`. Model calls `omnis_record` with `{}` and with a schema-valid body, then writes and reads `hello.txt`. |
| D, E | `projectD`, `projectE` | `14b9760d-…`, `e25f0127-…` | A named background teammate and a `shutdown_request` sent while it was still running. |
| F1 to F4 | `projectF1`..`F4` | various | Probe plugin only: size of a `$.mcp.call` reply before Claude Code swaps it for a "saved to file" notice. |

The run A command, exactly as the brief gives it, plus `--output-format json`:

```bash
claude --plugin-dir C:/projects/personal/OmnisSwarm --settings "$S/settings.json" \
  --allowedTools "Glob Read Agent SendMessage ToolSearch mcp__plugin_omnis-swarm_omnis-swarm__omnis_swarm_status" \
  -p "First use ToolSearch to find a tool named omnis_record ... Finally call omnis_swarm_status and print its text."
```

## 1. Recorder events reach `.omnis-swarm`: verified

**Finding.** Run A's log `.omnis-swarm/swarms/session-1519108e.jsonl` has 31 lines: `swarm.started` from the server
and 30 recorder events covering every type the recorder sends. The swarm name is `session-` plus the first 8 hex
characters of the hashed key, and the raw session id appears nowhere under `.omnis-swarm`.

**Evidence** (run A, quoted lines cut for width):

- Hash: `sha256("5c7ab4bd-8243-4964-9b80-c21174fa027b")` starts `1519108ea84a4b2b`. `current` holds `session-1519108e`.
  `swarm.started` has `"implicit":true,"session":"1519108ea84a4b2b"`. `grep -rl 5c7ab4bd .omnis-swarm` found nothing (exit 1).
- `agent.started`: `"agent":"aa5ef95599409106f","data":{"name":"probe-worker","role":"general-purpose","description":"Probe glob and message","parent":"lead"}`
- `agent.tool` start and end pairs for the lead (`ToolSearch`, `Agent`, `SendMessage`, `mcp__plugin_omnis-swarm_omnis-swarm__omnis_swarm_status`)
  and the worker (`Glob` with subject `**/*.md`, `ToolSearch`, `SendMessage` with subject `main`, `SubagentHandback`).
  No `agent.tool` names `omnis_record`, including the model's refused call.
- `agent.usage` for both, e.g. `"agent":"aa5ef95599409106f","data":{"model":"claude-opus-5-5","input":2,"output":129,"cacheRead":0,"cacheWrite5m":33246,"cacheWrite1h":0}`
- `message.sent`: `"agent":"aa5ef95599409106f","data":{"to":"main","summary":"hello from probe"}`
- `agent.finished`: `"agent":"aa5ef95599409106f","data":{"outcome":"answer","reason":"answer"}`
- `session.measure`: `{"contextWindow":1000000,"contextTokens":50110,"contextPercent":5,"costUsd":0.5480256}`
- `omnis_swarm_status` printed:
  `Swarm session-1519108e [session-1519108e] (hierarchical) · 2 agents · 1 running · 296,108 tokens · ≈$0.505`,
  `- lead [lead] running · 183,426 tokens`, `- probe-worker [general-purpose] done · 112,682 tokens`.
- Runs C, D and E show the same pattern (12, 36 and 103 recorder events, E's mostly the teammate's 25 Globs). D and E also logged several
  `session.measure` lines in one session, as cost changed.
- The recorder's own calls don't show in either transcript (main or subagent): no `cacheWrite5m` or `"phase"` string
  in them. Only the model's refused call appears.

**Also seen.**

- Lines are not appended in `ts` order. Run A wrote `agent.usage` at `15:51:36.846` before `agent.tool` start at
  `15:51:36.760`, and `agent.finished` (`44.666`) before the worker's `SubagentHandback` end (`44.628`). The calls
  overlap, so this is expected. `snapshot.ts` sorts with `sortEvents`, and anything that folds the tail
  incrementally (the phase 3 feed) has to put up with it too.
- The lead never gets `agent.finished`. That's by design (`turn.complete` carries no `agentId` for the lead), so it
  stays "running" in the status line.
- Token totals differ from the harness, by definition, not by double counting. The status shows probe-worker at
  112,682 tokens. The Agent tool result says `subagent_tokens: 39755`. 112,682 is the sum of input, output,
  cache read and cache write over its three steps (33,377 + 39,550 + 39,755). 39,755 is just the last step, so the
  harness reports the final context size and we report tokens processed. Worth a line in the pane's help in phase 3.

**Impact.** The recorder path works end to end in a real session. No code change.

## 2. The guard: verified, including under `bypassPermissions`

**Finding.** The mod's own calls pass and the model's are refused with the guard's reason, in `auto` mode (run A)
and in `bypassPermissions` mode (run C). In C the model sent `{}` and then a schema-valid body. Both were refused
before the server saw them: the log has no `"agent":"x"` line and no `abcdefgh` session.

**Evidence.**

- Run A transcript, the model's call: `USE mcp__plugin_omnis-swarm_omnis-swarm__omnis_record {}` then the tool result
  (`is_error: true`): `Permission to use mcp__plugin_omnis-swarm_omnis-swarm__omnis_record denied by plugin omnis-swarm: omnis_record and omnis_feed are internal to the omnis-swarm plugin and only its own hooks may call them. Use the public omnis_* tools instead.`
- Run C, the `PreToolUse` log shows `permission_mode` `bypassPermissions` on every line, and the model quoted the same
  denial for both calls. The session's own events still landed (13 lines, `session-d523a5dc.jsonl`), so the
  recorder's calls were allowed in that mode too.
- Run B, the probe's `tool.check` hook saw both kinds of caller on the same tool:
  ours `{"tool":"mcp__plugin_omnis-swarm_omnis-swarm__omnis_record","origin":{"plugin":"omnis-swarm","tier":"user"}}`,
  and the model's call to a probe tool `{"origin":{"plugin":"engine","tier":"core"}}`.

**Impact.** No code change. Mods-off stays the accepted gap (spec sections 6 and 11).

## 3. `$.mcp.call` raises classic `PreToolUse` command hooks: verified, yes

**Finding.** A project `PreToolUse` command hook with matcher `.*` runs once for every `$.mcp.call` the recorder
makes, and once for the model's refused call too. So every recorder event costs a hook process for anyone who has a
catch-all `PreToolUse` hook.

**Evidence.** The logger appends `tool_name`, `permission_mode` and the sorted input keys per call.

| Run | `omnis_record` lines in the `PreToolUse` log | Recorder events in the swarm log | Model calls to `omnis_record` |
|---|---|---|---|
| A | 31 | 30 | 1 |
| B | 13 | 13 | 0 |
| C | 14 | 12 | 2 |

In C the model's `{}` call shows as `mcp__plugin_omnis-swarm_omnis-swarm__omnis_record	bypassPermissions	[]` and the
recorder's as `…	[agent,data,sessionId,ts,type]` (`[data,sessionId,ts,type]` for `session.measure`). In B the
probe mod's own four `$.mcp.call`s to its `big` tool showed up as well (`…__big	auto	[bytes]`), so this holds for
any mod, not just ours. The hook also ran for the model's call that the guard denied, so a `PreToolUse` hook can't
tell a refused call from one that ran.

**Impact.** Phase 4's README has to say so: with a catch-all `PreToolUse` hook, each recorded event (about 30 in a
tiny session like run A) starts a hook process. Users can exclude us with a matcher such as
`^(?!mcp__plugin_omnis-swarm_).*`. Not tested: a user `PreToolUse` hook that blocks the call. That would stop
recording, and the recorder would count those calls as dropped.

## 4. Protocol `SendMessage` is not double counted: verified for `shutdown_request`, response side not verified

**Finding.** Each protocol send produced exactly one `message.sent` line, from the `tool.call` path. No second line
came from `session.send`. That held in three runs (A, D, E). The teammate side (`shutdown_response`) never happened
headless, because the request was never delivered to the subagent.

**Evidence.**

- Run A: one line, `"agent":"lead","data":{"to":"probe-worker","summary":"[shutdown_request]"}`. Tool result:
  `{"success":true,"message":"Shutdown request sent to probe-worker. Request ID: shutdown-1792597907818@probe-worker",...}`.
  The worker had already finished.
- Run E: the request went at `16:01:17.127` (`[shutdown_request]`, one line). The teammate was still running and
  kept calling Glob until `16:02:20` (`SubagentHandback` start), then reported it never received the request. Same in
  run D. ToolSearch found no `TeamCreate` or `TeamDelete` in this build, so there was no real team to put it in.
- No `message.sent` with `[shutdown_response]` in any run.

**What an interactive run needs** to close this: a session where `TeamCreate` exists, a teammate spawned into that
team, the lead's `shutdown_request` and the teammate's `shutdown_response` with `approve: true`. Then check the log
has exactly one `[shutdown_request]` from the lead and one `[shutdown_response] approve: yes` from the teammate.

**Impact.** No code change. The lead-side path is fine. Not a blocker: the response side uses the same
`protocolMessage` code, which the kit tests cover.

## 5. Large replies through `$.mcp.call`: verified, and it needs a code change in phase 3

**Finding.** Claude Code applies the same output limit to a mod's `$.mcp.call` as to the model's tool calls. Past
about 50,000 characters the mod does not get the reply. It gets Claude Code's "saved to a file" notice instead, with
`isError: false`. The limit follows `MAX_MCP_OUTPUT_TOKENS`. A 30 MB reply closed the connection.

**Evidence** (probe mod log, `textLength` is what the mod received):

| Reply sent | Default | `MAX_MCP_OUTPUT_TOKENS=200000` |
|---|---|---|
| 20,000 to 50,000 chars (`x` padding, run F3, and log-line JSON, run F4) | whole reply | whole reply |
| 52,000 chars (F3) | 1,629 chars, notice | not run |
| 60,000 to 100,000 chars (F1, F2) | 1,629 chars, notice | whole reply |
| 300,000 chars | 1,630 chars, notice | whole reply (299,998) |
| 2,000,000 chars | 1,632 chars, notice | 1,632 chars, notice |
| 30,000,000 chars (B) | `isError: true`, text `Connection closed` | not run |

The notice starts `Error: result (1,999,998 characters across 1 line) exceeds maximum allowed tokens. Output has been saved to …\tool-results\mcp-plugin_p2t9-probe_p2t9-probe-mcp-big-<n>.txt.` and goes on with instructions
for the model. The model gets the same notice when it calls the tool itself (run B).

**Impact.** `omnis_feed` can return up to `FEED_MAX_EVENTS` (500) events of up to `LIMITS.line` (2,048 bytes) each.
Run A's non-usage lines average about 228 bytes, so 500 events comes to about 114,000 characters, well past the
limit. Phase 3 needs (a) a cap on the reply's serialised size, under about 40,000 characters to leave room, with a
"more" offset so the pane pages through, and (b) the mod to treat a reply that won't parse as `FeedReply` (it starts
`Error: result (`) as failed, not as data. `parseFeedReply` returning `null` already covers (b) if the pane handles
that as a retry with a smaller page. `omnis_record` replies are 2 characters (`ok`), so the recorder is not affected.

## 6. `$.plugin.name` and `next.origin.plugin` with `--plugin-dir`: verified

**Finding.** With `--plugin-dir`, both are the `name` from `plugin.json`. Our calls carry
`next.origin` `{"plugin":"omnis-swarm","tier":"user"}`. The probe's own `$.plugin.name` was `p2t9-probe` and its own
calls carried `{"plugin":"p2t9-probe","tier":"user"}`, so the two match for a `--plugin-dir` plugin.

**Evidence.** Probe log: `{"event":"self","payload":{"pluginName":"p2t9-probe"}}` and
`{"tool":"mcp__plugin_p2t9-probe_p2t9-probe-mcp__big","origin":{"plugin":"p2t9-probe","tier":"user"},"self":"p2t9-probe"}`.
For omnis-swarm, `$.plugin.name` wasn't logged directly (no repo change), but it must be `omnis-swarm`: the guard
allows only when `next.origin.plugin === $.plugin.name`, its calls went through with origin `omnis-swarm`, and the
denial text reads "denied by plugin omnis-swarm". The model's origin is `{"plugin":"engine","tier":"core"}`.

**Impact.** No code change. The marketplace install check (does either value pick up a marketplace suffix?) stays
in phase 4.

## Also found

- The repo root has an untracked `.mcp.json` (the RuFlo `claude-flow` server, local dev only). `--plugin-dir` loads it
  as a plugin server, and run A's session reported `plugin:omnis-swarm:claude-flow` failing to connect. That's
  harmless for a marketplace install, since the file isn't tracked, but anyone testing with `--plugin-dir` sees the
  failure. I took this from the session's own report and didn't check the server list separately.
- Each scratch project also got `.claude-flow/` (from the user-level RuFlo hooks, not this plugin) and a `.gitignore`
  holding `.omnis-swarm/` (from `src/core/log.ts`, as designed).

## Follow-ups

1. Phase 3: cap the `omnis_feed` reply under about 40,000 characters, page the rest, and treat the
   "saved to a file" notice as a failed read (item 5).
2. Phase 4 README: classic `PreToolUse` hooks run once per recorded event, and the matcher to exclude us (item 3).
3. An interactive agent-team run for the `shutdown_response` side (item 4). Not a blocker.
