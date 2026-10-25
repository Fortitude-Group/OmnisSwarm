# Model hints from past runs

Date: 2026-10-25. Status: approved design, plan to follow.

## 1. Goal

When the lead starts a swarm, tell it which roles have done fine on a cheaper model in past runs, and which have not, so it can pass `model` on its Agent calls with evidence rather than habit. No classifier model: hints come only from what the recorder already logs. Silence is the default; a hint appears only when the evidence clears a bar, and every hint shows its sample size.

## 2. Outcome rows

`src/core/history.ts` (pure) turns a folded `SwarmState` into one row per finished subagent:

| Field | Meaning |
|---|---|
| `v` | Row schema version, 1 |
| `id` | `<swarm id>/<agent id>`, used to write each agent once |
| `role` | The agent's role (subagent type), checked against `NAME`, clipped to 64 |
| `model` | The model that answered (last `agent.usage` model), clipped to 64; agents with no usage are skipped |
| `clean` | See below |
| `costUsd` | Rounded to cents |
| `minutes` | Active minutes, rounded |
| `at` | Finish time, ISO |
| `project` | First 16 hex of a SHA-256 of the project path; never the path |

No prompts, descriptions, subjects or file paths are stored. The lead (main) and unfinished agents get no row.

**Clean** means all of: the agent finished with `answer`; it never looked stuck (`stuckBy` unset); no guard asked it to wrap up (`timeAct` and `costAct` null); and every task whose assignee is the agent ended `done` with its last gate result `passed`, `none` or no gate.

## 3. Stores

- Project: `.omnis-swarm/history.jsonl`.
- Machine: one `history.jsonl` in the plugin's persistent data folder. The plan settles the folder (expected `${CLAUDE_PLUGIN_DATA}`, passed to the server as an env var like `OMNIS_PROJECT_DIR`); if no folder is available the machine store is off.

Both use the same row format, the same symlink refusal as the event log, and are read newest-first, at most 500 rows each. A line that fails to parse or fails the field checks is skipped.

**Backfill.** The first time the project store is read and does not exist, the server folds every `.omnis-swarm/swarms/*.jsonl` once and writes the rows, so past runs count at once. The machine store is never backfilled from other projects.

## 4. When rows are written

When the server writes a run report (`report.written`: swarm end or the quiet report), it appends rows for finished agents whose `id` is not already in the project store. The project write is part of the report step; the machine write is best effort, its failure swallowed, and it never blocks or fails the report.

## 5. The hint rule

`src/core/hints.ts` (pure). Input: project rows and machine rows. Output: up to 5 hint lines.

1. Tier each row by model id: contains `haiku` = 1, `sonnet` = 2, `opus` = 3; anything else (a gateway model, say) is left out of tiering.
2. For each role, use project rows when the role has at least 5 project rows on two or more tiers between them; otherwise use machine rows, and label the line "across projects". Fewer than that anywhere: no hint for the role.
3. For each pair of tiers with at least 5 rows each, compare clean rates:
   - **Cheaper:** the cheaper tier's clean rate is no more than 10 points below the dearer one's. Hint the cheapest tier that qualifies.
   - **Keep:** the cheaper tier's clean rate is 25 or more points below. Hint to keep the role on the dearer tier.
   - In between: no hint.
4. Sort by sample size, largest first; keep 5.

Example lines:

- `omnis-developer: Sonnet finished clean 7 of 8 (≈$0.41 avg) vs Opus 9 of 10 (≈$1.80). Try model: 'sonnet'.`
- `omnis-security-reviewer: Haiku finished clean 2 of 6 vs Sonnet 6 of 6. Keep it on Sonnet (across projects).`

## 6. Delivery

- **`omnis_swarm_init` reply:** a `Model hints from past runs:` block with the lines, after the existing reply text. Left out when there are none.
- **`/omnis hints`:** prints the full table (role, tier, runs, clean, avg cost, avg minutes, source) for the user, plus the hint lines.
- **Run report:** a `## Hints` section with the same lines, left out when empty.

Role and model text is escaped with the report's `md` escaper in the report and the table, and clipped and stripped of control characters in the init reply.

## 7. Setting

`modelHints` userConfig: `on` (default), `project` (never reads or writes the machine store), `off` (no rows written, no hints shown). Passed through `${user_config.*}` env like the gate settings.

## 8. Errors

Every read and write here is best effort. A missing, unreadable or symlinked store reads as empty. A failed write leaves the report, the init reply and the swarm untouched. Nothing in this feature can refuse a tool call.

## 9. Testing

- `history.ts`: row building, the clean rule (each condition on its own), agents skipped (lead, unfinished, no usage), field checks, project hash.
- `hints.ts`: tiering, the 5-run bar, cheaper and keep thresholds at their edges, project-then-machine fallback and label, 5-line cap, sort order, unknown models.
- Server: rows appended on report, written once across two reports, backfill on first read, machine failure swallowed, `project` and `off` settings, symlinked store refused, init reply block present and absent.
- Kit: `/omnis hints` output.

## 10. Out of scope

Splitting a role by task kind (`general-purpose` covers very different jobs, so its hints will be weak); changing the model of a spawn automatically; any classifier model; sharing history between machines.
