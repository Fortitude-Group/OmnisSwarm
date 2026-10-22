# OmnisSwarm: budget guard, replay, GIF export and model badge

Approved by Rob on 2026-10-22. It extends the main design (`2026-10-21-omnisswarm-design.md`); anything not said here follows that spec. Order of work: guard, replay, GIF export, model badge.

## 1. Goals and non-goals

Goals:
- Catch runaway agents early (an agent ran 80 minutes on 2026-10-21) without killing work.
- Turn any finished swarm into a replay in the pane and a short GIF clip, as a showpiece.
- Show, per agent, the model it asked for and the model that answered (OmnisRouter rewrites it).

Non-goals:
- Hard spend caps and kill-switches. Those stay with OmnisRouter (local) and OmnisVigil (fleet).
- Killing a running subagent. The engine can't (`$.turn.abort` stops the lead's turn only).
- Any dependency. The GIF encoder is our own code.
- Reading Router's database or API. That is a later option (spike: `.superpowers/sdd/router-link-spike.md`, option B).

## 2. Budget guard

### 2.1 Limits and defaults

| Limit | Warn at | Act at | Action |
|---|---|---|---|
| Agent running time | 20 min | 30 min | nudge the agent |
| Agent cost (≈ estimate) | $3 | $5 | nudge the agent |
| Swarm cost | $10 | $20 | block new Agent spawns |

- Agent time counts from `agent.started` to now, while the agent is running (not after it finishes).
- Agent cost is the existing per-agent ≈ estimate from tokens and the price table.
- Swarm cost is Claude Code's own session cost (`session.measure` `cost.usd`) minus its value when the swarm started. Where no session cost has arrived yet, the sum of the agents' estimates stands in.
- Each limit fires once per agent (or swarm) per stage; raising a limit re-arms the stages above the current value.

### 2.2 Actions

1. **Warn.** A `guard.warned` event; the agent shows a warning badge in the pane (design: a sweat drop on robots, an amber rim on globes; designer owns the look); a toast naming the agent, the limit and the value, e.g. `coder-b: 21 min, past its 20 min time-box`.
2. **Nudge.** A `guard.nudged` event; `$.session.send({ to: { agentId } })` with: "You're past your time-box (30 min / $5). Wrap up what you have, report to main, and stop." and a copy to `main` naming the agent and the limit. A send that isn't delivered is recorded, not retried.
3. **Block.** A `guard.blocked` event; while the swarm cost is at or past the act limit, a `tool.check` hook denies the lead's `Agent` calls with: "Swarm budget $20 reached. Raise it with /omnis budget <usd> or finish with the agents you have." Running agents carry on. Only the swarm owned by this session is guarded.

### 2.3 Configuration

- Defaults come from plugin `userConfig` (one field per limit, or one compact field; the plan settles which the engine's userConfig supports, by checking `plugin.json` and the d.ts).
- `omnis_swarm_init` takes an optional `budget` object (`agentMinutes`, `agentUsd`, `swarmUsd`; the warn level is the act level's fraction from the defaults: 2/3 for time, 3/5 for agent cost, 1/2 for swarm cost). Recorded as a `budget.set` event so replays and restarts see it.
- `/omnis budget <usd>` sets the swarm act limit mid-run; `/omnis budget` alone shows the current limits and values. Also a `budget.set` event.
- Input validation at the boundary: finite positive numbers, sane ceilings (e.g. ≤ 24 h, ≤ $1000).

### 2.4 Where it runs

The guard runs in the mod (it has the events, `$.ui.toast`, `$.session.send` and `tool.check`). It evaluates on the existing pane/recorder clock (no extra timer when no swarm is running; at most once every 15 s while one is). Guard events go through `omnis_record` like every other recorder event, so the server stays the single writer and the fold shows them.

## 3. Replay

- `/omnis replay [swarm] [speed]` opens the pane (if closed) and plays a recorded swarm. Defaults: the most recent swarm of this project, speed 10×. Speed 1–60.
- Quiet gaps longer than 2 s of replay time are cut to 2 s.
- The header shows `REPLAY 10×` and the replay clock; the pane is otherwise identical to live (same renderer, same style).
- `/omnis replay stop` returns to live. The replay ends on the final state and stays there until stopped.
- The pane stays read-only: control is by commands only.
- The replay source is the event log through a new internal, guarded MCP tool (same origin guard as `omnis_feed`) that returns events from an offset with their timestamps; the mod folds them on its own replay clock.

## 4. GIF export

- `/omnis export gif [swarm]` asks the MCP server (internal guarded tool) to render the swarm to `.omnis-swarm/exports/<swarm>-<yyyymmdd-hhmm>.gif` and answers with the path.
- The server folds the log, steps a replay clock using the same gap-cutting as replay, renders frames with the shared renderer at a fixed size (the full layout, about 960 px wide), rasterises them as `scripts/preview.ts` does, and encodes a GIF with our own LZW encoder (global palette from the render tokens; frame differencing to keep the file small).
- Target clip: 20–30 s at 10 fps whatever the swarm's length (speed chosen to fit), ending with a 3 s summary card (agents, duration, cost, messages, a small OmnisSwarm mark). Designer owns the card.
- Uses the pane style currently set (robots or globes); the server gets it as an argument.
- Limits: at most 600 frames, at most 15 MB; past either, the speed goes up rather than the file growing.
- Rendering code shared with the pane must stay pure (no Node imports), so the mod keeps working.

## 5. Model badge (Router)

- The recorder records the requested model (`turn.step` `e.model`) beside the answered model (`usage.model`) for each agent.
- When they differ, the agent's label area or spotlight card shows `sonnet → haiku` and the ≈ saving from our price table (it compares against the requested model, so it won't equal Router's own figure; the card says "≈ vs requested").
- Before building, a live probe confirms `usage.model` carries the rewritten model (spike, "Not yet confirmed"). If it doesn't, this task stops and reports.

## 6. Events added to the log

`guard.warned`, `guard.nudged`, `guard.blocked`, `budget.set`, and the requested model on the existing token-usage event. Same validation and size rules as the existing events (spec §8).

## 7. Testing

- Guard: fold and threshold tests; kit tests for toast, send (delivered and not), the Agent deny and the pass-through of everything else; `/omnis budget` parsing.
- Replay: gap cutting and clock tests; kit test for start, speed, stop and the header; guarded tool refuses the model.
- GIF: encoder round-trip against a small decoder in the tests; frame cap and size cap; a golden summary card; the export tool refuses the model.
- Badge: fold test for differing models; golden for the card.
- The globe and robot goldens stay byte-identical except where a test names the new feature.

## 8. Constraints

Mod: web APIs only, timers via `$.clock`, never store `$`, one unmatched hook per event, gating hooks pass `next(e)` in `.catch`. Files under 500 lines (`src/mod/pane.ts` is at 493: split it before adding to it). No new dependencies. Commits without AI attribution.
