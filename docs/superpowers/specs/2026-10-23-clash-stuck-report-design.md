# OmnisSwarm: clash guard, stuck nudges and the run report

Approved by Rob on 2026-10-23. It extends the main design (`2026-10-21-omnisswarm-design.md`) and the guard spec (`2026-10-22-guard-replay-design.md`); anything not said here follows those. Order of work: clash guard, stuck nudges, run report.

## 1. Goals and non-goals

The pane already **shows** two of these problems after they happen:

- a file clash, two agents editing the same path within `CLASH_WINDOW_MS` (10 min), drawn as a red dashed line and blinking rims (`fileClashes`, `src/core/stats.ts`; `pane.md` §5);
- a stuck agent, `STUCK_AFTER` (3) failed tools in a row, drawn as an amber outline and `!` (`agentStats().stuck`; `pane.md` §4).

This work makes OmnisSwarm **act** on them, and adds a written record of each run.

Goals:
- Stop one agent silently overwriting another's file in a shared checkout.
- Catch an agent going round in circles before the time-box or budget would.
- Leave a short, readable report of every run, and tell the lead where it is.

Non-goals:
- Seeing writes made through Bash (`sed -i`, `>`, `mv`). Only Edit, Write and NotebookEdit carry a path. The README says so.
- Holds on reads, holds across sessions, holds surviving a mod reload.
- Configurable stuck thresholds.
- Transcript content in the report.
- Any dependency.

## 2. Clash guard

### 2.1 Holds

- A **hold** is a file path owned by one live subagent. Only subagents hold files. The lead never does, because it never finishes and would block its own helpers.
- The path is the tool input's `file_path` (Edit, Write) or `notebook_path` (NotebookEdit), resolved against the session cwd when relative, with `\` turned into `/`, and compared case-insensitively on Windows (`process.platform` is not available in the mod; the session cwd's form decides: a drive letter means case-insensitive).
- The first subagent to call Edit, Write or NotebookEdit on a path that has no live hold takes the hold.
- A hold ends when its holder finishes (`agent.finished`), or when the holder hasn't called Edit, Write or NotebookEdit on that path for **10 minutes** (`HOLD_IDLE_MS = 600_000`, matching `CLASH_WINDOW_MS`).
- Holds live in the mod's memory. A reload drops them, which is safe: the next edit takes a fresh hold.
- Agents in their own worktree edit different absolute paths, so they never clash. That is correct.

### 2.2 Refusal

When an agent other than the holder (the lead included) calls Edit, Write or NotebookEdit on a held path:

- **block** (the default): the call is denied with: `<holder> is editing <path>. Message them, or wait until they finish.` (`<path>` relative to the session cwd when inside it, cut from the left to 80 characters).
- **warn**: the call goes ahead, and the lead gets `$.session.append`: `[OmnisSwarm clash guard] <agent> edited <path> while <holder> holds it.`
- **off**: no holds are kept at all.

Each refusal or warning records a `clash.blocked` event (section 5). Repeated refusals of the same agent on the same path within 60 s record one event, so a retry loop can't flood the log.

### 2.3 Setting

A new `userConfig` field:

```json
"clashGuard": { "type": "string", "title": "File clash guard", "description": "block (the default): an agent can't edit a file another live agent is editing. warn: the edit goes ahead and the lead is told. off: no check.", "default": "block", "options": ["block", "warn", "off"] }
```

An unknown value is treated as `block`.

### 2.4 Pane

A `clash.blocked` event counts as a clashing edit for `fileClashes`, so the existing dashed line and blink (`pane.md` §5) show it with no new drawing. The spotlight's `! clash <path>` line gains ` (blocked)` when the latest clash on that path was refused. The designer confirms the wording in `pane.md` §14.

## 3. Stuck nudges

### 3.1 Patterns

For each running subagent, from its `agent.tool` events in order:

- **Failing:** `STUCK_NUDGE_AFTER = 5` tool calls in a row that ended with `isError`. (The pane's stuck look stays at 3, `STUCK_AFTER`; the nudge waits for 5.)
- **Repeating:** `REPEAT_NUDGE_AFTER = 4` starts of the same tool on the same subject with no `edit`-kind tool start in between. Re-running a test after a fix doesn't count, because the fix is an edit.

### 3.2 Action

On a hit:

1. `$.session.send({ to: { agentId } })`:
   - failing: `Your last 5 tool calls failed. Step back and try another approach, or report to main what's blocking you.`
   - repeating: `You've run <tool> on <subject> 4 times with no change in between. Step back and try another approach, or report to main.`
2. `$.session.append` to main: `[OmnisSwarm] <name> looks stuck (<pattern>) and was asked to step back.` A send that isn't delivered says so, as the budget guard's does.
3. An `agent.stuck` event (section 5). The agent shows the existing stuck look (amber outline and `!`) while the pattern holds; a repeating hit counts as stuck for the pane too.

Each pattern fires once per agent. It re-arms when the agent starts an `edit`-kind tool or a tool call succeeds (failing), or starts any different tool or subject (repeating). Same route and same "delivered" handling as the budget guard's nudge (`src/mod/budget-guard.ts`).

## 4. Run report

### 4.1 When

- When a run goes quiet: the number of running subagents drops to 0 and at least one subagent ran since the last report.
- When `omnis_swarm_end` is called.
- On `/omnis report`, for the current swarm, at any time.

### 4.2 What

A markdown file at `.omnis-swarm/reports/<swarm>-<yyyymmdd>-<hhmm>.md` (local time; `-2`, `-3` for a second report in the same minute, as GIF exports do):

- Heading: swarm name, topology, started and ended (local time), wall time, total cost (≈), agent count.
- A table, one row per agent (lead first): name, role, outcome, running time, cost (≈), tokens, files edited (up to 5, then `+n more`).
- **Problems**, one line each, omitted when empty: guard warnings, nudges and blocks; clashes (blocked or not); stuck nudges; failed agents.
- **Routing**, omitted unless OmnisRouter answered: requested model → answering model per agent and the estimated saving (the §13.5 badge figures).
- Tasks, omitted when the board is empty: counts by state, and the failed ones by title.

Everything comes from the folded `SwarmState`. A pure function `reportMarkdown(state, nowMs, tzOffsetMin)` in `src/core/report.ts` builds it.

### 4.3 How

- An internal MCP tool `omnis_report` (guarded by `next.origin.plugin` like `omnis_record`) folds the swarm's log, writes the file, records `report.written` and replies with the path and the summary figures.
- The mod calls it on the quiet trigger and on `/omnis report`. `omnis_swarm_end` writes one itself.
- The lead gets `$.session.append`: `Swarm report: <path> · <n> agents · <minutes> min · ≈$<cost>.` The report itself isn't put into context.
- `/omnis report` replies with the same line.

## 5. Events

Added to `EventData` and `EVENT_TYPES`, validated in `state-check`, bounded by `LIMITS`:

```ts
'clash.blocked': { path: string; holder: string; mode: 'block' | 'warn' }   // agent: the refused (or warned) agent; path ≤ LIMITS.subject from the left
'agent.stuck': { pattern: 'failing' | 'repeating'; count: number; subject: string; delivered: boolean; reason?: string }   // agent: the stuck agent
'report.written': { path: string; agents: number; minutes: number; costUsd: number }
```

Fold: `clash.blocked` joins the edits `fileClashes` reads; `agent.stuck` sets an optional `AgentState.stuckBy` cleared by the re-arm conditions; `report.written` sets `SwarmState.lastReport`. New fields are optional so states without them keep their size (the feed ceiling, `FEED_REPLY_MAX`).

## 6. Testing

- Pure core: path normalising, hold take/release/idle expiry, both stuck patterns and their re-arming, `reportMarkdown` against fixed states (golden text).
- Kit tests through the engine: a second agent's Edit denied with the exact text; `warn` lets it through and appends to main; `off` keeps no holds; a finished holder releases; the lead is refused but never holds; a stuck nudge sent once and re-armed; `/omnis report` replies with the pointer line; the quiet trigger fires once per run.
- Server: `omnis_report` refuses another plugin, writes under `.omnis-swarm/reports/` only, names files uniquely.
- Every kit test takes `KIT` from `src/mod/test-engine.ts`.

## 7. Docs

README: the clash guard and its setting, the Bash blind spot, stuck nudges, the report and `/omnis report`. `pane.md` §14: the ` (blocked)` spotlight wording and any stuck change.
