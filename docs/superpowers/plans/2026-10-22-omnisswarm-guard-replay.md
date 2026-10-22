# OmnisSwarm Budget Guard, Replay, GIF Export and Model Badge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a budget guard that warns, nudges and blocks runaway swarms; a replay of any recorded swarm in the pane; a GIF export of a swarm made with our own encoder; and a per-agent "requested → answered" model badge.

**Architecture:** Four new event types (`budget.set`, `guard.warned`, `guard.nudged`, `guard.blocked`) join the log contract, so the fold, the pane and replays all see the guard. The guard runs in the mod: it folds the events its own recorder lands (the server now answers `ok <swarm>` so the mod knows which swarm they went to), evaluates pure thresholds from `src/core/budget.ts`, and acts through a host bound at `session.start` (toast, `$.session.send`, `$.session.append`, a matched `tool.check` on `Agent`). Replay and GIF share one pure re-timing module (`src/core/replay-clock.ts`): events are sorted, gaps cut, and their timestamps rewritten onto the replay clock, so the unchanged renderer plays them at real animation speed. A new guarded tool `omnis_replay` pages raw events to the mod; a new guarded async tool `omnis_export` renders frames server-side with the shared renderer, rasterises them cell-by-cell (the rasteriser moves out of `scripts/preview.ts` into `src/render/raster.ts`) and encodes a GIF89a with our own palette, LZW and frame differencing in `src/gif/`.

**Tech Stack:** Node 24 (type stripping, `node:test`), TypeScript 7 type-check only, Claude Code mod API (`claude-code`, `claude-code/testing`, vendored at `types/claude-code/index.d.ts`), no runtime or dev dependencies added.

**Branch:** `phase3b-guard-replay` off `master` at `4d03b82`. Worktrees branch off it as `wt/p3b-t<N>`.

**Spec:** `docs/superpowers/specs/2026-10-22-guard-replay-design.md` (approved). Parent spec `docs/superpowers/specs/2026-10-21-omnisswarm-design.md` (§8 event rules, §6 recorder, §10 pane). Mod API facts: `docs/spikes/2026-10-21-mod-api.md`. Router link: `.superpowers/sdd/router-link-spike.md`. **Look values:** `docs/design/pane.md` §13 (13.1 tokens, 13.2 sweat drop and guard words, 13.3 replay header, 13.4 GIF header and summary card, 13.5 model badge, 13.7 golden checks). Every task that draws reads its values from §13 and **stops with BLOCKED if §13 is silent on a value it needs**; it never invents a colour, glyph or position.

**Deviations from the spec, approved by Rob on 2026-10-22:**
- The guard warning is a **sweat drop on robots and globes alike** (one drop = warned, two = nudged), not an amber rim on globes: amber already means stuck (§13.2). Spec §2.2's "amber rim on globes" is superseded.
- The GIF summary card's duration is the swarm's **wall-clock duration** (`swarm.startedAt` to `swarm.endedAt`, or the last event when it never ended), and row 12's "X of work in Y s" uses **that same value** for X (Y is the clip's replay length). The §13.4 mock's sample numbers disagree with each other; the figures come from this one value, in §13's two formats (`12m 40s` on the figure row, `12:40` on row 12).

## Global Constraints

- Mod code uses web APIs only: no `node:*` import, no `Buffer`, `process`, `require`, `module`, `__dirname`, `fetch`, `queueMicrotask`, `setImmediate`, **no `setTimeout`/`setInterval`, no `console`**. Timers go through `$.clock.every`/`$.clock.after` only, via a host bound from `$`.
- Never store or assign `$` in module state. Bind a host of closures from `$` at `session.start` (the `hostOf($)` pattern in `src/mod/pane.ts`) and keep the host.
- One unmatched hook per event per plugin. Already taken: `session.start` (recorder), `tool.call` (recorder), `tool.check` (guard.ts), `tool.describe` (guard.ts), `agent.spawn`, `turn.step`, `turn.complete`, `session.send`, `session.measure` (recorder), `ui.close` (pane). Every new hook on those events is **matched** (`{ tool: ... }`, `{ isInteractive: true }`, ...).
- Every gating hook (`tool.check`, `tool.call`, `agent.spawn`, `session.send`, `ui.close`) has a `.catch` that passes `next(e)` (the budget block fails open: the guard never stops work because it broke).
- Files under 500 lines. `src/mod/pane.ts` is split first (Task 0).
- No new dependencies (runtime or dev). `package.json` and the lockfile are not edited by any task.
- Render code shared with the server stays pure: `src/render/**`, `src/core/**` except `log.ts`, `snapshot.ts`, `swarm.ts`, and `src/gif/**` use no Node API. `tests/core/mod-safe.test.ts` enforces it for `src/core` (Task 1 makes it cover every new core file automatically).
- Globe and robot goldens (`tests/render/golden/*.txt`) stay byte-identical unless the task names the change. No task changes an existing golden: every new drawing is behind state the golden fixtures don't have (a guard stage, a replay note, a budget view, a routed model). Task 8 adds one new golden, `summary-card.txt`.
- Untrusted text (agent names, reasons, swarm ids) reaches a grid only through `Grid.text`/`writeParts` and is clipped; reaches the log only through `omnis_record`'s rebuild of `data`.
- Event lines stay ≤ 2048 bytes (spec §8). New numeric fields are finite and bounded; new text fields are bounded and free of control characters.
- Commits: author `Fortitude Omnis <dev@fortitude-omnis.group>`, plain developer English, British spelling, **no `Co-Authored-By`, no "Generated with", no AI attribution**. Do not open PRs.
- Gate before every commit: `npm test` green, `npm run test:mod` green (it runs `claude plugin validate` then the kit), `npm run typecheck` clean. Run commands from Git Bash (git only works there on this machine).

## Settled open points

1. **userConfig holds the limits as three `number` fields.** `ConfigKind` is `'boolean' | 'choice' | 'text' | 'number'` (`types/claude-code/index.d.ts:1993`) and `PluginOptions` values are `string | number | boolean | readonly string[]` (`:7861`); the engine validates the declared `type` before load. The manifest declares no min/max, so `limitsFrom(options)` re-validates each and falls back to the default when out of range. Fields: `budgetAgentMinutes` (30), `budgetAgentUsd` (5), `budgetSwarmUsd` (20). Warn levels are not configurable: they are the act level times 2/3, 3/5 and 1/2 (spec §2.3).
2. **New event shapes** (agent field rules in brackets):
   - `budget.set` `{ agentMinutes?: number; agentUsd?: number; swarmUsd?: number }` — at least one key; each finite, `> 0`, `≤ BUDGET_MAX` (1440 min, $1000, $1000). [no agent]
   - `guard.warned` `{ limit: 'time' | 'agentCost' | 'swarmCost'; value: number; threshold: number }` — `value` 0..1e6, `threshold` (0, 1e6]; minutes for `time`, USD otherwise. [agent required for `time`/`agentCost`, forbidden for `swarmCost`]
   - `guard.nudged` `{ limit: 'time' | 'agentCost'; value; threshold; delivered: boolean; reason?: string ≤ 80 }` [agent required]
   - `guard.blocked` `{ value; threshold }` [no agent]
   - `agent.usage` gains `requested?: string ≤ 80` (Task 10 only, after the probe).
   All four new types are recorder types (they reach the log through `omnis_record`); `omnis_swarm_init` also writes `budget.set` itself with `src: 'mcp'`.
3. **Fold state for the guard:** `AgentState.guard = { timeWarn, timeAct, costWarn, costAct }` and `SwarmState.guard = { warn, block }` hold the *threshold each stage last fired at* (or null); `SwarmState.budget = { agentMinutes, agentUsd, swarmUsd }` holds overrides (null = config default). A stage fires when `value ≥ threshold && (fired === null || fired < threshold)`: once per stage, and a raised limit re-arms the stages above where they fired (spec §2.1).
4. **How the mod learns the swarm:** `omnis_record` answers `ok <swarm-id>` instead of `ok`. The guard folds each recorder body into its local `SwarmState` when that answer arrives, and starts a fresh state whenever the id changes. Swarm cost = latest `session.measure` cost − the last one seen before the swarm's first event (0 if none was seen); with no session cost yet, the sum of agent estimates.
5. **The copy to main** uses `$.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })` on the main conversation (`types/claude-code/index.d.ts:11077`), prefixed `[OmnisSwarm budget guard]`. The guard runs inside the lead's own session, so "send to `main`" would be a send to itself; the spike only proved `main` as an address from a subagent.
6. **The block** is a matched `tool.check` on `{ tool: 'Agent' }` that denies only a real lead call (`e.agentId === undefined && e.tool_use_id !== undefined`) while swarm cost ≥ the act limit. A swarm boundary (`omnis_swarm_end` or `omnis_swarm_init` succeeding, or a new swarm id) clears it.
7. **Replay feed tool `omnis_replay`** `{ swarm?: string (swarm id), since: integer ≥ 0 }` → `{ v: 1, kind: 'replay', swarm, offset, done, events, bad }` or `{ v: 1, kind: 'none', recent: string[] }` (up to 5 recent ids). Default swarm: the most recently modified log in the project (`recentSwarmIds(root, 1)`). Same 40,000-byte and 500-event reply caps as `omnis_feed`. Guarded by the same origin rule (`INTERNAL_TOOL` widened to `omnis_(record|feed|replay|export)`).
8. **Replay re-times events** onto the replay clock instead of mapping a log-time `now`: the renderer's motions (pulses, comets, fade-ins, blinks) then run at real speed, as live. Durations and per-minute rates in the spotlight read in replay time; the header's replay clock shows log time. The mod loads at most 20,000 events (≤ 40 pages); a longer swarm answers "too long to replay in the pane; try /omnis export gif".
9. **GIF encoder:** GIF89a, 256-entry global colour table, index 0 reserved as the transparent colour; colours are assigned first-come up to 255 and then mapped to the nearest (cached), so the table is final when the file is assembled at the end. LZW with min code size 8, clear 256, end 257, 12-bit cap, clear-and-reset at 4096 (the omggif rule, round-tripped against a decoder in the tests). Frame differencing at cell level: the cells that changed since the last frame give a bounding box; only those cells are rasterised; unchanged pixels inside the box are written as index 0; disposal "do not dispose"; a frame with no change adds its delay to the previous one. 10 fps (delay 10). Speed is chosen so the replay part is ≤ 27 s (bisection, floor 1×), then **rounded up to a whole number** so the header badge (` REPLAY 24× `, §13.4) tells the truth; then the 3 s summary card (a 3-frame fade-in, then one frame held 2.7 s). Caps: ≤ 600 frames and ≤ 15 MB, else speed ×1.5 (rounded up) and re-encode, up to 4 tries, then an error. Text is drawn from an embedded 8×16 bitmap font (**Spleen 8×16, BSD 2-Clause**, licence text committed beside it; Task 7f); blocks and braille stay exact geometry; a glyph the font lacks falls back to the soft bar. Size per §13.4: the full layout at **120 × 44 cells**, 8×16 px a cell, so **960 × 704 px** (top grid, a blank chip row, bottom grid, inside those 44 rows).
10. **`omnis_export` is async.** The stdio protocol refuses promise handlers today (`src/mcp/protocol.ts:78-82`). Task 8 lets `handleMessage` await a promise-returning handler and replies out of order by id (JSON-RPC allows it); the export yields to the event loop every 10 frames, so `omnis_record` and `omnis_feed` calls keep being answered while it renders. The `/omnis export gif` command answers at once ("Rendering …") and toasts the path when the call returns.
11. **The pane's budget figures** (§13.2 header `≈$11.20/$20`, ` BLOCKED `, `n over budget`) need limits the fold doesn't hold (config defaults live in the mod). They reach the renderer as `View.budget?: { swarmUsd: number; limit: number; warn: number; blocked: boolean } | null`, filled by the pane from `guardView()` (Task 3b). Absent in replays and GIFs (§13 shows no budget there), so `render` draws the cost group as today.
12. **The drop flash** (§13.2, `GUARD.flashMs`) rides the pulse machinery: `pulsesFrom` turns a `guard.warned`/`guard.nudged` event into `{ agent, kind: 'other', at, isError: false, guard: true }`, which `markPulses` never coalesces and which tool-pulse drawing (robot wave, globe flicker) skips.
13. **Model badge saving is signed** (§13.5 shows "saves" and "costs … more"): `AgentState.routedDeltaUsd` = Σ (cost at requested − cost at answered) over priced, differing calls.

## Execution order and file ownership

```
T0  pane split + /omnis dispatcher                     serial (first)
T1  event contract: types, fold, state-check, record    serial (after T0; T0 and T1 touch disjoint files and may run in parallel)
── wave A, four parallel worktrees after T1 ──────────────────────────────
T2  budget core + omnis_swarm_init budget               ║
T4a sweat drop on nodes + drop flash + all §13 tokens   ║  §13.1, 13.2
T5  omnis_replay tool + replay clock                    ║
T7  GIF codec + rasteriser                              ║  (needs nothing; may start at T0)
T7f 8×16 bitmap font in the rasteriser                  ║  after T7 (same worktree chain; edits raster.ts)
── wave B, parallel worktrees ───────────────────────────────────────────
T3  guard runtime in the mod                            ║  after T0, T2
T4b guard words: spotlight, tree, header BLOCKED/cost   ║  after T4a; §13.2
── wave C, parallel worktrees ───────────────────────────────────────────
T6  replay in the pane + REPLAY header                  ║  after T0, T4b, T5; §13.3
T3b /omnis budget + View.budget wired into the pane     ║  after T3, T4b (T6 and T3b both touch pane-draw.ts: merge T6 first, T3b rebases)
── wave D ───────────────────────────────────────────────────────────────
T8  GIF export tool + GIF header mark + summary card    after T6, T7, T7f; §13.4
T9  /omnis export gif command                           after T8
T10 model badge (live probe first; stops if it fails)   after everything above; §13.5
```

| File | Owner (in order) |
|---|---|
| `src/mod/pane.ts`, `pane-runtime.ts`, `pane-draw.ts`, `pane-commands.ts`, `commands.ts` | T0 creates; T6 edits `pane.ts`, `pane-runtime.ts`, `pane-draw.ts`; then T3b edits `pane-draw.ts` |
| `src/mod/budget-command.ts` | T0 stub → T3b |
| `src/mod/replay-command.ts` | T0 stub → T6 |
| `src/mod/export-command.ts` | T0 stub → T9 |
| `src/core/events.ts`, `fold.ts`, `state-check.ts` | T1 → T10 |
| `src/core/recording.ts`, `src/mcp/tools/record.ts`, `src/mod/guard.ts`, `tests/core/mod-safe.test.ts` | T1 (T10 edits `record.ts`) |
| `src/core/budget.ts`, `src/mcp/tools.ts` | T2 |
| `src/mod/budget-guard.ts`, `src/mod/recorder.ts`, `src/mod/register.ts`, `.claude-plugin/plugin.json` | T3 (T10 edits `recorder.ts`) |
| `src/render/tokens.ts`, `sprites.ts`, `robot.ts`, `guard-badge.ts`, `src/mod/pane-model.ts`, `src/render/types.ts` (`Pulse.guard`) | T4a (T10 edits `graph.ts` labels) |
| `src/render/graph.ts` | T4a → T10 |
| `src/render/spotlight.ts`, `tree.ts` | T4b → T10 |
| `src/render/header.ts`, `frame.ts`, `types.ts` (`View`, `Notes`) | T4b → T6 → T8 |
| `src/core/replay-clock.ts`, `src/core/replay-reply.ts`, `src/mcp/tools/replay.ts`, `src/mcp/log-cursor.ts`, `src/mcp/tools/feed.ts` | T5 |
| `src/mcp/registry.ts` | T5 → T8 |
| `src/mod/replay.ts` | T6 |
| `src/gif/*`, `src/render/raster.ts`, `scripts/preview.ts` | T7 (T7f edits `raster.ts`) |
| `src/render/font/*`, `scripts/build-font.ts` | T7f |
| `src/mcp/tools/export.ts`, `src/mcp/protocol.ts`, `src/render/card.ts` | T8 |
| `src/core/stats.ts`, `src/mod/record-events.ts` | T10 |

Merge order within a wave: A is T2, T4a, T5, T7, T7f; B is T3, T4b; C is T6 then T3b. Each task writes only its own test files (named in the task).

---

### Task 0: Split the pane and add the /omnis dispatcher

Behaviour unchanged: same hooks, same command text, same frames. It makes room in `pane.ts` (493 lines) and gives each later subcommand its own file so the guard, replay and export tasks never edit one shared file.

**Files:**
- Create: `src/mod/pane-runtime.ts`, `src/mod/pane-draw.ts`, `src/mod/pane-commands.ts`, `src/mod/commands.ts`, `src/mod/budget-command.ts`, `src/mod/replay-command.ts`, `src/mod/export-command.ts`
- Modify: `src/mod/pane.ts` (shrinks to `registerPane` and the `ui.render` body)
- Test: `src/mod/commands.test.ts` (new kit test); existing `src/mod/pane*.test.ts` unchanged

**Interfaces:**
- Produces:
  - `pane-runtime.ts`: `type Panel`, `type Style`, `type Kit`, `type Host`, `type Runtime`, `hostOf($): Host`, `panelOf(x): Panel`, `fresh(panel): Runtime`, `export let rt: Runtime`, `resetRuntime(panel: Panel): void`, `pinnedAtom`, `styleAtom`, `pinText`, `styleOf`.
  - `pane-draw.ts`: `svgSource`, `frameAt(now)`, `blitFrame`, `mounted`, `redraw`, `stopFrames`, `wakeFor`, `animate`, `tick`, `show(host, now)`, `stopAll`, `closed(byPerson)`, `spent(ms)`, `waitingText()`, `hooks: PaneHooks<Host>`, `openPane($)`.
  - `pane-commands.ts`: `paneSub: Sub`, `chipRow`, `maybeAutoOpen($)`, `resetAutoOpen()`, `COMMAND_FAILED`.
  - `commands.ts`: `type Sub = { name: string; describe: string; hint: string; usage: string; run: ($: EngineInterface, words: readonly string[]) => Promise<string> }`, `COMMAND_DESCRIPTION`, `COMMAND_HINT`, `USAGE`, `runOmnis($, args: string): Promise<string>`.
  - `budget-command.ts`: `export const budgetSub: Sub | null`; `replay-command.ts`: `replaySub`; `export-command.ts`: `exportSub` — all `null` here.

- [ ] **Step 1: Write the failing kit test**

```ts
// src/mod/commands.test.ts
import { expect, mock, test } from 'claude-code/testing'
import { COMMAND_DESCRIPTION, COMMAND_HINT, USAGE } from './commands.ts'
import { registerPane } from './pane.ts'
import { FIVE_AT } from '../../tests/fixtures/swarm-five.ts'
import { engine, RUN } from './test-engine.ts'

test('the /omnis text is what it was before the split', async () => {
  expect(COMMAND_DESCRIPTION).toBe('OmnisSwarm: /omnis pane shows the live swarm pane, /omnis pane close hides it, /omnis pane style robot|globe picks the node style')
  expect(COMMAND_HINT).toBe('pane [close | style robot|globe]')
  expect(USAGE).toBe('Usage: /omnis pane, /omnis pane close, or /omnis pane style robot|globe.')
})

test('an unknown subcommand answers the usage, and pane still opens', async ($, on) => {
  const clock = mock.clock(on, { now: FIVE_AT.mid })
  const seen = engine(on)
  registerPane(on, { panel: 'command' })
  await $.session.start({ cwd: '/project', surface: null, isInteractive: true })
  expect((await $.command.run({ command: 'omnis', args: 'budget', ...RUN })).text).toBe(USAGE)
  expect((await $.command.run({ command: 'omnis', args: 'pane', ...RUN })).text).toBe('Swarm pane open.')
  await clock.settle()
  expect(seen.opens).toBe(1)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:mod`
Expected: FAIL — `Cannot find module './commands.ts'`.

- [ ] **Step 3: Create `pane-runtime.ts`**

Move these verbatim from `pane.ts`: the `pinnedAtom`, `pinText`, `styleAtom`, `Style`, `styleOf`, `Panel`, `Kit`, `BlitArgs`, `Host`, `hostOf`, `Runtime`, `panelOf`, `fresh` declarations (lines 30-118 today), each `export`ed. Then add:

```ts
/** Module state. A hot reload starts it over and the pane pulls a fresh state within one PULL_MS; the pin is in $.state. */
export let rt: Runtime = fresh('command')

/** Starts the pane's state over (registerPane does, once per load). Importers see the new value: ES bindings are live. */
export function resetRuntime(panel: Panel): void {
  rt = fresh(panel)
}
```

Imports it needs: `atom` from `'claude-code'`; types `Elements, EngineInterface, Timer` from `'claude-code'`; `Frame, Size, Spot, Tween` from `'../render/types.ts'`; `Grid` type from `'../render/grid.ts'`; `emptyModel` from `'./pane-model.ts'`; `PullHost, PullState` from `'./pane-pull.ts'`; `connectServer` from `'./server.ts'`.

- [ ] **Step 4: Create `pane-draw.ts`**

Move verbatim, each exported: `svgSource`, `sizeKey`, `pinOf`, `viewOf`, `waitingText`, `frameAt`, `spent`, `blitFrame`, `mounted`, `redraw`, `stopFrames`, `wakeFor`, `animate`, `tick`, `show`, `stopAll`, `closed`, `hooks`, `openPane` (lines 120-357 today). They read and write `rt` from `pane-runtime.ts` (`import { rt } from './pane-runtime.ts'`); no other change to their bodies. `closed()` also needs `mounted`; `hooks` needs `closed`, `stopFrames`, `show`; `openPane` needs `hostOf`, `hooks`, `startPulling`.

- [ ] **Step 5: Create `commands.ts` and the three stubs**

```ts
// src/mod/commands.ts
/** The /omnis command: each subcommand lives in its own file and is listed here once. */
import type { EngineInterface } from 'claude-code'
import { budgetSub } from './budget-command.ts'
import { exportSub } from './export-command.ts'
import { paneSub } from './pane-commands.ts'
import { replaySub } from './replay-command.ts'

export type Sub = {
  /** The first word after /omnis. */
  name: string
  /** Its part of the command's description, after "OmnisSwarm: ". */
  describe: string
  /** Its part of the argument hint. */
  hint: string
  /** One sentence of usage, shown for anything the command can't read. */
  usage: string
  /** Answers the command; `words` are the lower-cased words after /omnis, the subcommand's name first. */
  run: ($: EngineInterface, words: readonly string[]) => Promise<string>
}

const SUBS: readonly Sub[] = [paneSub, budgetSub, replaySub, exportSub].filter((s): s is Sub => s !== null)

export const COMMAND_DESCRIPTION = `OmnisSwarm: ${SUBS.map(s => s.describe).join(', ')}`
export const COMMAND_HINT = SUBS.map(s => s.hint).join(' | ')
export const USAGE = SUBS.map(s => s.usage).join(' ')

export async function runOmnis($: EngineInterface, args: string): Promise<string> {
  const words = args.trim().toLowerCase().split(/\s+/)
  const sub = SUBS.find(s => s.name === words[0])
  return sub === undefined ? USAGE : sub.run($, words)
}
```

```ts
// src/mod/budget-command.ts  (Task 3b fills it in)
import type { Sub } from './commands.ts'
export const budgetSub: Sub | null = null
```

`replay-command.ts` (`export const replaySub: Sub | null = null`, Task 6) and `export-command.ts` (`export const exportSub: Sub | null = null`, Task 9) are the same three lines.

- [ ] **Step 6: Create `pane-commands.ts`**

Move verbatim: `styleCommand`, `paneCommand`, `autoOpening` (as `let`), `maybeAutoOpen`, `COMMAND_FAILED`, `togglePin`, `chipRow`. Delete the old `USAGE` constant: `styleCommand` and the pane's command now return `PANE_USAGE`. Add:

```ts
const PANE_USAGE = 'Usage: /omnis pane, /omnis pane close, or /omnis pane style robot|globe.'

export function resetAutoOpen(): void {
  autoOpening = false
}

export const paneSub: Sub = {
  name: 'pane',
  describe: '/omnis pane shows the live swarm pane, /omnis pane close hides it, /omnis pane style robot|globe picks the node style',
  hint: 'pane [close | style robot|globe]',
  usage: PANE_USAGE,
  run: async ($, words) => {
    const [, arg = '', value = ''] = words
    if (arg === 'style') return words.length > 3 ? PANE_USAGE : styleCommand($, value)
    return paneCommand($, arg)
  },
}
```

- [ ] **Step 7: Slim `pane.ts`**

`registerPane` keeps its hooks. Replace `rt = fresh(...)` and `autoOpening = false` with `resetRuntime(panelOf(options.panel))` and `resetAutoOpen()`. In the `session.start` hook use `description: COMMAND_DESCRIPTION, argumentHint: COMMAND_HINT`. The `omnis` command hook becomes:

```ts
  on('command.run', { command: 'omnis' }, async ($, e) => ({ text: await runOmnis($, e.args) })).catch(() => COMMAND_FAILED)
```

Keep `export { PANE_ID }` and re-export `svgSource` (`export { svgSource } from './pane-draw.ts'`) so `pane.test.ts` is untouched.

- [ ] **Step 8: Run the gate**

Run: `npm run typecheck && npm test && npm run test:mod && wc -l src/mod/pane*.ts src/mod/commands.ts`
Expected: all green; `pane.ts` ≤ 200 lines, every file < 500.

- [ ] **Step 9: Commit**

```bash
git add src/mod/
git commit -m "Split the pane module and give /omnis a subcommand table"
```

---

### Task 1: Guard and budget events in the log contract

**Files:**
- Modify: `src/core/events.ts`, `src/core/fold.ts`, `src/core/state-check.ts`, `src/core/recording.ts`, `src/mcp/tools/record.ts`, `src/mod/guard.ts`, `tests/core/mod-safe.test.ts`
- Test: `tests/core/fold-guard.test.ts` (new), `tests/mcp/record-guard.test.ts` (new); update `tests/mcp/record.test.ts` and `tests/core/state-check.test.ts` where they assert the old `ok` text or the old key lists

**Interfaces:**
- Produces (events.ts): `GUARD_LIMITS = ['time', 'agentCost', 'swarmCost'] as const`, `type GuardLimit`, `BUDGET_MAX = { agentMinutes: 1440, agentUsd: 1000, swarmUsd: 1000 } as const`, `type BudgetKey = keyof typeof BUDGET_MAX`, `BUDGET_KEYS: readonly BudgetKey[]`, the four `EventData` entries of settled point 2, added to `EVENT_TYPES`.
- Produces (fold.ts): `type AgentGuard = { timeWarn: number | null; timeAct: number | null; costWarn: number | null; costAct: number | null }`, `AgentState.guard: AgentGuard`, `SwarmState.budget: Record<BudgetKey, number | null>`, `SwarmState.guard: { warn: number | null; block: number | null }`.
- Produces (recording.ts): `RECORDER_TYPES` + the four types; `INTERNAL_TOOL = /^mcp__.+__omnis_(record|feed|replay|export)$/`; `REPLAY_TOOL = 'omnis_replay'`; `EXPORT_TOOL = 'omnis_export'`.
- Produces (record.ts): `omnis_record` answers `{ text: \`ok ${swarm}\` }`.

- [ ] **Step 1: Write the failing fold test**

```ts
// tests/core/fold-guard.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldAll, LEAD } from '../../src/core/fold.ts'
import { isSwarmState } from '../../src/core/state-check.ts'
import { ev } from '../helpers.ts'

const start = ev('agent.started', { name: 'coder-b', role: 'coder', description: '', parent: LEAD }, { agent: 'a1', atSec: 1 })

test('a fresh state has no budget overrides and no guard stages', () => {
  const s = foldAll('s1', [start])
  assert.deepEqual(s.budget, { agentMinutes: null, agentUsd: null, swarmUsd: null })
  assert.deepEqual(s.guard, { warn: null, block: null })
  assert.deepEqual(s.agents.a1!.guard, { timeWarn: null, timeAct: null, costWarn: null, costAct: null })
})

test('budget.set merges valid keys and skips bad ones', () => {
  const s = foldAll('s1', [
    ev('budget.set', { swarmUsd: 30 }, { atSec: 2 }),
    ev('budget.set', { agentMinutes: 45, agentUsd: -1 }, { atSec: 3 }),
    ev('budget.set', { agentUsd: 5000 } as never, { atSec: 4 }),
  ])
  assert.deepEqual(s.budget, { agentMinutes: 45, agentUsd: null, swarmUsd: 30 })
})

test('guard events record the threshold each stage fired at, and say so in the feed', () => {
  const s = foldAll('s1', [
    start,
    ev('guard.warned', { limit: 'time', value: 21, threshold: 20 }, { agent: 'a1', atSec: 5 }),
    ev('guard.nudged', { limit: 'agentCost', value: 5.2, threshold: 5, delivered: false, reason: 'gone' }, { agent: 'a1', atSec: 6 }),
    ev('guard.warned', { limit: 'swarmCost', value: 10.4, threshold: 10 }, { atSec: 7 }),
    ev('guard.blocked', { value: 20.1, threshold: 20 }, { atSec: 8 }),
  ])
  assert.deepEqual(s.agents.a1!.guard, { timeWarn: 20, timeAct: null, costWarn: null, costAct: 5 })
  assert.deepEqual(s.guard, { warn: 10, block: 20 })
  assert.deepEqual(s.feed.slice(-4).map(f => f.text), [
    'coder-b: 21 min, past its 20 min warning',
    'coder-b asked to wrap up at ≈$5.20 (not delivered)',
    'swarm: ≈$10.40, past its $10 warning',
    'swarm budget $20 reached: new agents blocked',
  ])
  assert.equal(isSwarmState(JSON.parse(JSON.stringify(s)), 's1'), true)
})

test('a guard event with a bad limit or numbers changes nothing', () => {
  const s = foldAll('s1', [start, ev('guard.warned', { limit: 'nope', value: Number.NaN, threshold: 20 } as never, { agent: 'a1', atSec: 5 })])
  assert.deepEqual(s.agents.a1!.guard, { timeWarn: null, timeAct: null, costWarn: null, costAct: null })
})
```

- [ ] **Step 2: Write the failing record test**

```ts
// tests/mcp/record-guard.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRecordTools } from '../../src/mcp/tools/record.ts'
import { Session } from '../../src/mcp/session.ts'
import { swarmLogPath } from '../../src/core/log.ts'
import { tmpRoot } from '../helpers.ts'

const SID = 'abcdef12-3456-7890-abcd-ef1234567890'
const NOW = new Date('2026-10-22T10:00:00.000Z')
const tool = (root: string) => createRecordTools({ root, session: new Session(root), now: () => NOW })[0]!
const call = (root: string, body: Record<string, unknown>) => tool(root).handler({ sessionId: SID, ts: NOW.toISOString(), ...body })

test('omnis_record answers ok and the swarm the event landed in', () => {
  const root = tmpRoot()
  const out = call(root, { type: 'budget.set', data: { swarmUsd: 30 } })
  assert.match(out.text, /^ok session-[a-z0-9]{8}$/)
  const swarm = out.text.slice(3)
  const line = JSON.parse(readFileSync(swarmLogPath(root, swarm), 'utf8').trim().split('\n').at(-1)!)
  assert.deepEqual(line.data, { swarmUsd: 30 })
})

test('guard events are rebuilt from known fields', () => {
  const root = tmpRoot()
  call(root, { type: 'guard.nudged', agent: 'a1', data: { limit: 'time', value: 31, threshold: 30, delivered: false, reason: 'gone', extra: 'x' } })
  call(root, { type: 'guard.blocked', data: { value: 20.5, threshold: 20 } })
})

for (const [label, body] of [
  ['budget.set with no keys', { type: 'budget.set', data: {} }],
  ['budget.set past its ceiling', { type: 'budget.set', data: { agentMinutes: 1441 } }],
  ['budget.set with zero', { type: 'budget.set', data: { swarmUsd: 0 } }],
  ['a warned time limit with no agent', { type: 'guard.warned', data: { limit: 'time', value: 21, threshold: 20 } }],
  ['a warned swarm limit with an agent', { type: 'guard.warned', agent: 'a1', data: { limit: 'swarmCost', value: 11, threshold: 10 } }],
  ['a nudge on the swarm limit', { type: 'guard.nudged', agent: 'a1', data: { limit: 'swarmCost', value: 1, threshold: 1, delivered: true } }],
  ['a nudge with no delivered flag', { type: 'guard.nudged', agent: 'a1', data: { limit: 'time', value: 31, threshold: 30 } }],
  ['a blocked event with an agent', { type: 'guard.blocked', agent: 'a1', data: { value: 21, threshold: 20 } }],
  ['an infinite value', { type: 'guard.blocked', data: { value: 1e400, threshold: 20 } }],
  ['a reason with a newline', { type: 'guard.nudged', agent: 'a1', data: { limit: 'time', value: 31, threshold: 30, delivered: false, reason: 'a\nb' } }],
] as const) {
  test(`omnis_record refuses ${label}`, () => {
    assert.throws(() => call(tmpRoot(), body as unknown as Record<string, unknown>), { name: 'InputError' })
  })
}
```

- [ ] **Step 3: Run them to verify they fail**

Run: `node --test tests/core/fold-guard.test.ts tests/mcp/record-guard.test.ts`
Expected: FAIL — `s.budget` is undefined; `budget.set` is not one of the record types.

- [ ] **Step 4: Extend `events.ts`**

```ts
export const GUARD_LIMITS = ['time', 'agentCost', 'swarmCost'] as const
export type GuardLimit = (typeof GUARD_LIMITS)[number]
/** The highest each budget limit may be set to (spec section 2.3). Minutes, dollars, dollars. */
export const BUDGET_MAX = { agentMinutes: 1440, agentUsd: 1000, swarmUsd: 1000 } as const
export type BudgetKey = keyof typeof BUDGET_MAX
export const BUDGET_KEYS: readonly BudgetKey[] = ['agentMinutes', 'agentUsd', 'swarmUsd']
/** The bound on a guard event's value and threshold. */
export const GUARD_MAX = 1e6
```

Add to `EventData`:

```ts
  'budget.set': { agentMinutes?: number; agentUsd?: number; swarmUsd?: number }
  'guard.warned': { limit: GuardLimit; value: number; threshold: number }
  'guard.nudged': { limit: Exclude<GuardLimit, 'swarmCost'>; value: number; threshold: number; delivered: boolean; reason?: string }
  'guard.blocked': { value: number; threshold: number }
```

and `'budget.set', 'guard.warned', 'guard.nudged', 'guard.blocked'` to the end of `EVENT_TYPES`.

- [ ] **Step 5: Extend `fold.ts`**

Add the types from the Interfaces block. In `agentOf`'s `created` literal add `guard: { timeWarn: null, timeAct: null, costWarn: null, costAct: null },`. In `emptyState` add `budget: { agentMinutes: null, agentUsd: null, swarmUsd: null }, guard: { warn: null, block: null },`. Then the cases (before `case 'task.updated'`):

```ts
    case 'budget.set': {
      for (const key of BUDGET_KEYS) {
        const v = (e.data as Record<string, unknown>)[key]
        if (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= BUDGET_MAX[key]) state.budget[key] = v
      }
      break
    }
    case 'guard.warned':
    case 'guard.nudged': {
      const d = e.data
      const value = guardNum(d.value, 0)
      const threshold = guardNum(d.threshold, Number.MIN_VALUE)
      if (value === null || threshold === null || !isOneOf(GUARD_LIMITS, d.limit)) break
      if (d.limit === 'swarmCost') {
        if (e.type !== 'guard.warned') break
        state.guard.warn = threshold
        feed(state, { at, kind: 'agent', agent: LEAD, text: `swarm: ${usdText(value)}, past its ${limitText('swarmCost', threshold)} warning` })
        break
      }
      const a = agentOf(state, who, at)
      const act = e.type === 'guard.nudged'
      if (d.limit === 'time') a.guard[act ? 'timeAct' : 'timeWarn'] = threshold
      else a.guard[act ? 'costAct' : 'costWarn'] = threshold
      const shown = d.limit === 'time' ? `${Math.floor(value)} min` : usdText(value)
      const text = act
        ? `${a.name} asked to wrap up at ${shown}${(d as { delivered?: unknown }).delivered === true ? '' : ' (not delivered)'}`
        : `${a.name}: ${shown}, past its ${limitText(d.limit, threshold)} warning`
      feed(state, { at, kind: 'agent', agent: a.id, text })
      break
    }
    case 'guard.blocked': {
      const threshold = guardNum(e.data.threshold, Number.MIN_VALUE)
      if (threshold === null || guardNum(e.data.value, 0) === null) break
      state.guard.block = threshold
      feed(state, { at, kind: 'agent', agent: LEAD, text: `swarm budget ${limitText('swarmCost', threshold)} reached: new agents blocked` })
      break
    }
```

with these helpers above `fold`:

```ts
const guardNum = (x: unknown, min: number): number | null =>
  typeof x === 'number' && Number.isFinite(x) && x >= min && x <= GUARD_MAX ? x : null
/** ≈$5.20: two decimals, as the pane shows estimates. */
const usdText = (usd: number): string => `≈$${usd.toFixed(2)}`
/** A limit as set: 20 min, $10, $2.50. */
export const limitText = (limit: GuardLimit, n: number): string =>
  limit === 'time' ? `${n} min` : `$${Number.isInteger(n) ? n : n.toFixed(2)}`
```

Import `BUDGET_KEYS, BUDGET_MAX, GUARD_LIMITS, GUARD_MAX, type BudgetKey, type GuardLimit` from `./events.ts`. `fold.ts` ends near 420 lines.

- [ ] **Step 6: Extend `state-check.ts`**

Add `'guard'` to the `agent` key list with `guardRec(x.guard)`; add `'budget', 'guard'` to `isSwarmState`'s key list with:

```ts
const guardRec = (x: unknown): boolean =>
  exact(x, ['timeWarn', 'timeAct', 'costWarn', 'costAct']) && Object.values(x).every(nnum)
const budget = (x: unknown): boolean => exact(x, ['agentMinutes', 'agentUsd', 'swarmUsd']) && Object.values(x).every(nnum)
const swarmGuard = (x: unknown): boolean => exact(x, ['warn', 'block']) && Object.values(x).every(nnum)
```

A snapshot written before this change no longer passes `isSwarmState`, so `loadSnapshot` returns null and the swarm is folded from its log once (it rewrites the snapshot). That is the existing fallback; no migration.

- [ ] **Step 7: Extend `recording.ts`, `guard.ts` and `record.ts`**

`recording.ts`: append the four types to `RECORDER_TYPES`; set `INTERNAL_TOOL = /^mcp__.+__omnis_(record|feed|replay|export)$/`; add `export const REPLAY_TOOL = 'omnis_replay'` and `export const EXPORT_TOOL = 'omnis_export'`.

`guard.ts`: `DENY_REASON = 'omnis_record, omnis_feed, omnis_replay and omnis_export are internal to the omnis-swarm plugin and only its own hooks may call them. Use the public omnis_* tools instead.'`

`record.ts`: add the helper and cases, and the agent rule.

```ts
function measure(d: Args, key: string, min: number): number {
  const v = d[key]
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > GUARD_MAX || (min > 0 && v === 0)) {
    throw new InputError(`data.${key} must be a number from ${min} to ${GUARD_MAX}`)
  }
  return v
}
```

```ts
    case 'budget.set': {
      const out: EventData['budget.set'] = {}
      for (const key of BUDGET_KEYS) {
        if (d[key] === undefined) continue
        const v = d[key]
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > BUDGET_MAX[key]) throw new InputError(`data.${key} must be a number above 0 and at most ${BUDGET_MAX[key]}`)
        out[key] = v
      }
      if (Object.keys(out).length === 0) throw new InputError('data must set at least one of agentMinutes, agentUsd, swarmUsd')
      return out
    }
    case 'guard.warned':
      return { limit: oneOf(d, 'limit', GUARD_LIMITS), value: measure(d, 'value', 0), threshold: measure(d, 'threshold', 1e-9) }
    case 'guard.nudged': {
      if (typeof d.delivered !== 'boolean') throw new InputError('data.delivered must be true or false')
      return {
        limit: oneOf(d, 'limit', ['time', 'agentCost'] as const), value: measure(d, 'value', 0), threshold: measure(d, 'threshold', 1e-9),
        delivered: d.delivered, ...(d.reason !== undefined && { reason: text(d, 'reason', LIMITS.reason) }),
      }
    }
    case 'guard.blocked':
      return { value: measure(d, 'value', 0), threshold: measure(d, 'threshold', 1e-9) }
```

In the handler, right after `const data = dataFor(type, args.data)`:

```ts
      const agentLevel = type === 'guard.nudged' || (type === 'guard.warned' && (data as EventData['guard.warned']).limit !== 'swarmCost')
      const swarmLevel = type === 'budget.set' || type === 'guard.blocked' || (type === 'guard.warned' && !agentLevel)
      if (agentLevel && agent === undefined) throw new InputError(`${type} for an agent limit needs agent`)
      if (swarmLevel && agent !== undefined) throw new InputError(`${type} is about the swarm and takes no agent`)
```

and the reply `return { text: \`ok ${swarm}\` }`. Import `BUDGET_KEYS, BUDGET_MAX, GUARD_LIMITS, GUARD_MAX` from events.

- [ ] **Step 8: Make the mod-safe test cover every core file**

In `tests/core/mod-safe.test.ts` replace the `MOD_SAFE` list with:

```ts
// Every core file is mod-safe except these, which the server alone uses. A new core file is checked without editing this.
const NODE_ONLY = new Set(['log.ts', 'snapshot.ts', 'swarm.ts'])
const MOD_SAFE = readdirSync(coreDir).filter(f => f.endsWith('.ts') && !NODE_ONLY.has(f))
```

(import `readdirSync`; move the `coreDir` line above it). Its import check must accept the core files it now covers: if it rejects `./feed-reply.ts` or `./state-check.ts` imports, that is its old allow-list, which becomes `MOD_SAFE` itself.

- [ ] **Step 9: Run the gate**

Run: `npm run typecheck && npm test && npm run test:mod`
Expected: green after updating the two existing tests that assert `text === 'ok'` (`tests/mcp/record.test.ts`: assert `/^ok [a-z0-9]/`) and the state-check fixtures that list keys. Goldens unchanged (`git diff --stat tests/render/golden` empty).

- [ ] **Step 10: Commit**

```bash
git add src/core src/mcp/tools/record.ts src/mod/guard.ts tests
git commit -m "Add budget and guard events to the log, the fold and omnis_record"
```

---

### Task 2: Budget limits, thresholds and omnis_swarm_init's budget

Pure guard logic both sides use, and the `budget` argument of `omnis_swarm_init`.

**Files:**
- Create: `src/core/budget.ts`
- Modify: `src/mcp/tools.ts` (`omnis_swarm_init` only)
- Test: `tests/core/budget.test.ts`, `tests/mcp/init-budget.test.ts`

**Interfaces:**
- Consumes: Task 1's `BUDGET_KEYS`, `BUDGET_MAX`, `AgentState.guard`, `SwarmState.budget`, `SwarmState.guard`, `limitText`.
- Produces:

```ts
export type Limits = Record<BudgetKey, number>
export type BudgetPatch = Partial<Limits>
export const DEFAULT_LIMITS: Limits            // { agentMinutes: 30, agentUsd: 5, swarmUsd: 20 }
export const WARN_AT: Limits                   // { agentMinutes: 2/3, agentUsd: 3/5, swarmUsd: 1/2 }
export const OPTION_KEYS: Record<BudgetKey, string> // budgetAgentMinutes, budgetAgentUsd, budgetSwarmUsd
export function limitsFrom(options: Readonly<Record<string, unknown>>): Limits
export function parseBudget(x: unknown): { ok: true; patch: BudgetPatch } | { ok: false; error: string }
export function parseUsd(word: string): number | null
export function effective(defaults: Limits, state: SwarmState): Limits
export const warnLevel: (limits: Limits, key: BudgetKey) => number
export function swarmCost(state: SwarmState, baseUsd: number | null): number
export type GuardAction =
  | { kind: 'warn'; agent: string; limit: 'time' | 'agentCost'; value: number; threshold: number }
  | { kind: 'nudge'; agent: string; limit: 'time' | 'agentCost'; value: number; threshold: number }
  | { kind: 'swarm-warn'; value: number; threshold: number }
  | { kind: 'block'; value: number; threshold: number }
export function evaluate(state: SwarmState, limits: Limits, swarmUsd: number, now: number): GuardAction[]
export const isBlocked: (limits: Limits, swarmUsd: number) => boolean
export function toastText(a: GuardAction, name: string, limits: Limits): string
export const nudgeText: (limits: Limits) => string
export function mainText(name: string, a: GuardAction, limits: Limits, delivered: boolean, reason?: string): string
export const blockReason: (limits: Limits) => string
export function budgetText(limits: Limits, swarmUsd: number): string
```

- [ ] **Step 1: Write the failing core test**

```ts
// tests/core/budget.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldAll, fold, LEAD } from '../../src/core/fold.ts'
import {
  DEFAULT_LIMITS, budgetText, blockReason, effective, evaluate, isBlocked, limitsFrom, nudgeText, parseBudget, parseUsd, swarmCost, toastText, warnLevel,
} from '../../src/core/budget.ts'
import { at, ev } from '../helpers.ts'

const started = ev('agent.started', { name: 'coder-b', role: 'coder', description: '', parent: LEAD }, { agent: 'a1', atSec: 0 })
const min = (m: number) => at(0) + m * 60_000

test('limits come from the options, a bad value falling back to the default', () => {
  assert.deepEqual(limitsFrom({}), DEFAULT_LIMITS)
  assert.deepEqual(limitsFrom({ budgetAgentMinutes: 45, budgetAgentUsd: -2, budgetSwarmUsd: 'x' }), { ...DEFAULT_LIMITS, agentMinutes: 45 })
  assert.deepEqual(limitsFrom({ budgetSwarmUsd: 1001 }), DEFAULT_LIMITS)
})

test('warn levels are the spec fractions of the act level', () => {
  assert.equal(warnLevel(DEFAULT_LIMITS, 'agentMinutes'), 20)
  assert.equal(warnLevel(DEFAULT_LIMITS, 'agentUsd'), 3)
  assert.equal(warnLevel(DEFAULT_LIMITS, 'swarmUsd'), 10)
})

test('parseBudget takes a partial object and refuses anything else', () => {
  assert.deepEqual(parseBudget({ swarmUsd: 30 }), { ok: true, patch: { swarmUsd: 30 } })
  assert.equal(parseBudget({}).ok, false)
  assert.equal(parseBudget({ agentMinutes: 0 }).ok, false)
  assert.equal(parseBudget({ agentUsd: 1001 }).ok, false)
  assert.equal(parseBudget({ swarmUsd: 5, extra: 1 }).ok, false)
  assert.equal(parseBudget([5]).ok, false)
})

test('parseUsd reads 30, $30 and 2.50 and refuses the rest', () => {
  assert.equal(parseUsd('30'), 30)
  assert.equal(parseUsd('$30'), 30)
  assert.equal(parseUsd('2.50'), 2.5)
  for (const bad of ['0', '-1', '1001', '1e3', 'abc', '', '2.555']) assert.equal(parseUsd(bad), null, bad)
})

test('effective limits take the swarm overrides', () => {
  const s = foldAll('s1', [ev('budget.set', { swarmUsd: 40 }, { atSec: 1 })])
  assert.deepEqual(effective(DEFAULT_LIMITS, s), { ...DEFAULT_LIMITS, swarmUsd: 40 })
})

test('swarm cost is session cost over its baseline, or the agents before any session cost', () => {
  const s = foldAll('s1', [started, ev('agent.usage', { model: 'claude-opus-5-5', input: 0, output: 100_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, { agent: 'a1', atSec: 1 })])
  assert.equal(swarmCost(s, null), 2)
  fold(s, ev('session.measure', { contextWindow: 1, costUsd: 7.5 }, { atSec: 2 }))
  assert.equal(swarmCost(s, 1.5), 6)
  assert.equal(swarmCost(s, null), 7.5)
})

test('time: warn at 20 min, nudge at 30, each once', () => {
  const s = foldAll('s1', [started])
  assert.deepEqual(evaluate(s, DEFAULT_LIMITS, 0, min(19)), [])
  assert.deepEqual(evaluate(s, DEFAULT_LIMITS, 0, min(21)), [{ kind: 'warn', agent: 'a1', limit: 'time', value: 21, threshold: 20 }])
  fold(s, ev('guard.warned', { limit: 'time', value: 21, threshold: 20 }, { agent: 'a1', atSec: 21 * 60 }))
  assert.deepEqual(evaluate(s, DEFAULT_LIMITS, 0, min(25)), [])
  assert.deepEqual(evaluate(s, DEFAULT_LIMITS, 0, min(31)), [{ kind: 'nudge', agent: 'a1', limit: 'time', value: 31, threshold: 30 }])
})

test('a jump past both stages gives the warning and the nudge together', () => {
  const s = foldAll('s1', [started])
  assert.deepEqual(evaluate(s, DEFAULT_LIMITS, 0, min(40)).map(a => a.kind), ['warn', 'nudge'])
})

test('finished agents, the lead and placeholders are not timed', () => {
  const s = foldAll('s1', [started, ev('agent.finished', { outcome: 'answer' }, { agent: 'a1', atSec: 60 }), ev('message.sent', { to: 'ghost', summary: '' }, { atSec: 61 })])
  assert.deepEqual(evaluate(s, DEFAULT_LIMITS, 0, min(90)), [])
})

test('raising a limit re-arms the stages above where they fired', () => {
  const s = foldAll('s1', [started, ev('guard.warned', { limit: 'time', value: 21, threshold: 20 }, { agent: 'a1', atSec: 1 })])
  const raised = { ...DEFAULT_LIMITS, agentMinutes: 60 }
  assert.deepEqual(evaluate(s, raised, 0, min(39)), [])
  assert.deepEqual(evaluate(s, raised, 0, min(41)).map(a => a.kind), ['warn'])
})

test('swarm cost warns at half and blocks at the limit', () => {
  const s = foldAll('s1', [started])
  assert.deepEqual(evaluate(s, DEFAULT_LIMITS, 10.4, min(1)), [{ kind: 'swarm-warn', value: 10.4, threshold: 10 }])
  fold(s, ev('guard.warned', { limit: 'swarmCost', value: 10.4, threshold: 10 }, { atSec: 61 }))
  assert.deepEqual(evaluate(s, DEFAULT_LIMITS, 20, min(1)), [{ kind: 'block', value: 20, threshold: 20 }])
  assert.equal(isBlocked(DEFAULT_LIMITS, 20), true)
  assert.equal(isBlocked(DEFAULT_LIMITS, 19.99), false)
})

test('the words', () => {
  assert.equal(toastText({ kind: 'warn', agent: 'a1', limit: 'time', value: 21.4, threshold: 20 }, 'coder-b', DEFAULT_LIMITS), 'coder-b: 21 min, past its 20 min time-box')
  assert.equal(toastText({ kind: 'warn', agent: 'a1', limit: 'agentCost', value: 3.1, threshold: 3 }, 'coder-b', DEFAULT_LIMITS), 'coder-b: ≈$3.10, past its $3 warning')
  assert.equal(toastText({ kind: 'nudge', agent: 'a1', limit: 'time', value: 31, threshold: 30 }, 'coder-b', DEFAULT_LIMITS), 'coder-b: 31 min, asked to wrap up (30 min time-box)')
  assert.equal(toastText({ kind: 'block', value: 20, threshold: 20 }, '', DEFAULT_LIMITS), 'Swarm budget $20 reached: new agents are blocked. /omnis budget <usd> raises it.')
  assert.equal(nudgeText(DEFAULT_LIMITS), "You're past your time-box (30 min / $5). Wrap up what you have, report to main, and stop.")
  assert.equal(blockReason(DEFAULT_LIMITS), 'Swarm budget $20 reached. Raise it with /omnis budget <usd> or finish with the agents you have.')
  assert.equal(budgetText(DEFAULT_LIMITS, 4.123), 'Budget: each agent 30 min / $5 (warns at 20 min / $3); swarm $20 (warns at $10). Swarm so far ≈$4.12. New agents: allowed.')
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/core/budget.test.ts`
Expected: FAIL — `Cannot find module '../../src/core/budget.ts'`.

- [ ] **Step 3: Write `src/core/budget.ts`**

```ts
/** The budget guard's limits and thresholds (spec section 2). Pure and mod-safe: the mod and the server both use it. */
import { BUDGET_KEYS, BUDGET_MAX, type BudgetKey } from './events.ts'
import { LEAD, limitText, type AgentState, type SwarmState } from './fold.ts'

export type Limits = Record<BudgetKey, number>
export type BudgetPatch = Partial<Limits>
export type GuardAction =
  | { kind: 'warn'; agent: string; limit: 'time' | 'agentCost'; value: number; threshold: number }
  | { kind: 'nudge'; agent: string; limit: 'time' | 'agentCost'; value: number; threshold: number }
  | { kind: 'swarm-warn'; value: number; threshold: number }
  | { kind: 'block'; value: number; threshold: number }

export const DEFAULT_LIMITS: Limits = { agentMinutes: 30, agentUsd: 5, swarmUsd: 20 }
/** Each warning as a fraction of its act level: 20 of 30 minutes, $3 of $5, $10 of $20. */
export const WARN_AT: Limits = { agentMinutes: 2 / 3, agentUsd: 3 / 5, swarmUsd: 1 / 2 }
/** The plugin.json userConfig field for each limit. */
export const OPTION_KEYS: Record<BudgetKey, string> = { agentMinutes: 'budgetAgentMinutes', agentUsd: 'budgetAgentUsd', swarmUsd: 'budgetSwarmUsd' }

const round2 = (n: number): number => Math.round(n * 100) / 100
const valid = (key: BudgetKey, x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0 && x <= BUDGET_MAX[key]

export function limitsFrom(options: Readonly<Record<string, unknown>>): Limits {
  const out = { ...DEFAULT_LIMITS }
  for (const key of BUDGET_KEYS) {
    const v = options[OPTION_KEYS[key]]
    if (valid(key, v)) out[key] = v
  }
  return out
}

export function parseBudget(x: unknown): { ok: true; patch: BudgetPatch } | { ok: false; error: string } {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return { ok: false, error: 'budget must be an object' }
  const raw = x as Record<string, unknown>
  for (const k of Object.keys(raw)) if (!(BUDGET_KEYS as readonly string[]).includes(k)) return { ok: false, error: `budget has an unknown field ${k.slice(0, 32)}` }
  const patch: BudgetPatch = {}
  for (const key of BUDGET_KEYS) {
    if (raw[key] === undefined) continue
    if (!valid(key, raw[key])) return { ok: false, error: `budget.${key} must be a number above 0 and at most ${BUDGET_MAX[key]}` }
    patch[key] = raw[key] as number
  }
  return Object.keys(patch).length === 0 ? { ok: false, error: 'budget must set at least one of agentMinutes, agentUsd, swarmUsd' } : { ok: true, patch }
}

/** `/omnis budget <usd>`: 30, $30 or 2.50 (at most two decimals), above 0 and at most the ceiling. */
export function parseUsd(word: string): number | null {
  const m = /^\$?(\d{1,4}(?:\.\d{1,2})?)$/.exec(word)
  if (m === null) return null
  const n = Number(m[1])
  return valid('swarmUsd', n) ? n : null
}

export function effective(defaults: Limits, state: SwarmState): Limits {
  const out = { ...defaults }
  for (const key of BUDGET_KEYS) {
    const v = state.budget[key]
    if (v !== null) out[key] = v
  }
  return out
}

export const warnLevel = (limits: Limits, key: BudgetKey): number => round2(limits[key] * WARN_AT[key])

/** Claude Code's session cost since the swarm began; before any session cost has arrived, the agents' own estimates. */
export function swarmCost(state: SwarmState, baseUsd: number | null): number {
  const session = state.session.costUsd
  if (session !== null) return round2(Math.max(0, session - (baseUsd ?? 0)))
  let sum = 0
  for (const a of Object.values(state.agents)) sum += a.costUsd
  return round2(sum)
}

/** A stage fires once its threshold is reached, unless it already fired at that threshold or a higher one. */
const fires = (value: number, threshold: number, fired: number | null): boolean => value >= threshold && (fired === null || fired < threshold)

const timed = (a: AgentState): boolean => a.id !== LEAD && !a.placeholder && a.finishedAt === null

export function evaluate(state: SwarmState, limits: Limits, swarmUsd: number, now: number): GuardAction[] {
  const out: GuardAction[] = []
  for (const a of Object.values(state.agents)) {
    if (!timed(a)) continue
    const checks = [
      { limit: 'time' as const, value: round2(Math.max(0, now - a.startedAt) / 60_000), key: 'agentMinutes' as const, warned: a.guard.timeWarn, acted: a.guard.timeAct },
      { limit: 'agentCost' as const, value: round2(a.costUsd), key: 'agentUsd' as const, warned: a.guard.costWarn, acted: a.guard.costAct },
    ]
    for (const c of checks) {
      const warn = warnLevel(limits, c.key)
      if (fires(c.value, warn, c.warned)) out.push({ kind: 'warn', agent: a.id, limit: c.limit, value: c.value, threshold: warn })
      if (fires(c.value, limits[c.key], c.acted)) out.push({ kind: 'nudge', agent: a.id, limit: c.limit, value: c.value, threshold: limits[c.key] })
    }
  }
  const warn = warnLevel(limits, 'swarmUsd')
  if (fires(swarmUsd, warn, state.guard.warn)) out.push({ kind: 'swarm-warn', value: swarmUsd, threshold: warn })
  if (fires(swarmUsd, limits.swarmUsd, state.guard.block)) out.push({ kind: 'block', value: swarmUsd, threshold: limits.swarmUsd })
  return out
}

export const isBlocked = (limits: Limits, swarmUsd: number): boolean => swarmUsd >= limits.swarmUsd

const shown = (limit: 'time' | 'agentCost', value: number): string => (limit === 'time' ? `${Math.floor(value)} min` : `≈$${value.toFixed(2)}`)

export function toastText(a: GuardAction, name: string, limits: Limits): string {
  switch (a.kind) {
    case 'warn':
      return a.limit === 'time'
        ? `${name}: ${shown(a.limit, a.value)}, past its ${limitText('time', a.threshold)} time-box`
        : `${name}: ${shown(a.limit, a.value)}, past its ${limitText('agentCost', a.threshold)} warning`
    case 'nudge':
      return `${name}: ${shown(a.limit, a.value)}, asked to wrap up (${limitText(a.limit, a.threshold)} ${a.limit === 'time' ? 'time-box' : 'budget'})`
    case 'swarm-warn':
      return `Swarm ≈$${a.value.toFixed(2)}, past its ${limitText('swarmCost', a.threshold)} warning`
    case 'block':
      return `Swarm budget ${limitText('swarmCost', limits.swarmUsd)} reached: new agents are blocked. /omnis budget <usd> raises it.`
  }
}

export const nudgeText = (limits: Limits): string =>
  `You're past your time-box (${limits.agentMinutes} min / ${limitText('agentCost', limits.agentUsd)}). Wrap up what you have, report to main, and stop.`

export function mainText(name: string, a: GuardAction, limits: Limits, delivered: boolean, reason?: string): string {
  const limit = a.kind === 'nudge' ? `${limitText(a.limit, a.threshold)} ${a.limit === 'time' ? 'time-box' : 'budget'}` : `${limitText('swarmCost', limits.swarmUsd)} budget`
  const tail = delivered ? '' : ` The message was not delivered${reason === undefined ? '' : `: ${reason.slice(0, 80)}`}.`
  return `[OmnisSwarm budget guard] ${name} passed its ${limit} and was asked to wrap up and report to you.${tail}`
}

export const blockReason = (limits: Limits): string =>
  `Swarm budget ${limitText('swarmCost', limits.swarmUsd)} reached. Raise it with /omnis budget <usd> or finish with the agents you have.`

export function budgetText(limits: Limits, swarmUsd: number): string {
  const usd = (n: number) => limitText('agentCost', n)
  return `Budget: each agent ${limits.agentMinutes} min / ${usd(limits.agentUsd)} (warns at ${warnLevel(limits, 'agentMinutes')} min / ${usd(warnLevel(limits, 'agentUsd'))}); ` +
    `swarm ${usd(limits.swarmUsd)} (warns at ${usd(warnLevel(limits, 'swarmUsd'))}). Swarm so far ≈$${swarmUsd.toFixed(2)}. ` +
    `New agents: ${isBlocked(limits, swarmUsd) ? 'blocked' : 'allowed'}.`
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test tests/core/budget.test.ts tests/core/mod-safe.test.ts`
Expected: PASS (mod-safe now covers `budget.ts` automatically).

- [ ] **Step 5: Write the failing init test**

```ts
// tests/mcp/init-budget.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createTools } from '../../src/mcp/tools.ts'
import { Session } from '../../src/mcp/session.ts'
import { swarmLogPath } from '../../src/core/log.ts'
import { tmpRoot } from '../helpers.ts'

const init = (root: string) => createTools({ root, session: new Session(root) }).find(t => t.name === 'omnis_swarm_init')!

test('omnis_swarm_init with a budget writes budget.set after swarm.started', () => {
  const root = tmpRoot()
  init(root).handler({ name: 'auth', topology: 'mesh', budget: { swarmUsd: 40, agentMinutes: 45 } })
  const lines = readFileSync(swarmLogPath(root, 'auth'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.deepEqual(lines.map(l => l.type), ['swarm.started', 'budget.set'])
  assert.deepEqual(lines[1].data, { agentMinutes: 45, swarmUsd: 40 })
  assert.equal(lines[1].src, 'mcp')
})

test('omnis_swarm_init refuses a bad budget before writing anything', () => {
  const root = tmpRoot()
  assert.throws(() => init(root).handler({ name: 'x', topology: 'mesh', budget: { swarmUsd: 0 } }), { name: 'InputError' })
  assert.throws(() => init(root).handler({ name: 'x', topology: 'mesh', budget: { tokens: 5 } }), { name: 'InputError' })
})

test('the schema lists the budget object', () => {
  const schema = init(tmpRoot()).inputSchema as { properties: Record<string, { properties?: Record<string, unknown> }> }
  assert.deepEqual(Object.keys(schema.properties.budget!.properties!), ['agentMinutes', 'agentUsd', 'swarmUsd'])
})
```

- [ ] **Step 6: Add the budget to `omnis_swarm_init`**

Schema property:

```ts
          budget: {
            type: 'object',
            description: 'Optional limits for this swarm. Warnings come at 2/3 of the minutes, 3/5 of the agent dollars and 1/2 of the swarm dollars.',
            properties: {
              agentMinutes: { type: 'number', exclusiveMinimum: 0, maximum: BUDGET_MAX.agentMinutes, description: 'Minutes an agent may run before it is asked to wrap up.' },
              agentUsd: { type: 'number', exclusiveMinimum: 0, maximum: BUDGET_MAX.agentUsd, description: 'Approximate dollars an agent may spend before it is asked to wrap up.' },
              swarmUsd: { type: 'number', exclusiveMinimum: 0, maximum: BUDGET_MAX.swarmUsd, description: 'Dollars the swarm may spend before new agents are blocked.' },
            },
            additionalProperties: false,
          },
```

Handler, first lines (before anything is written):

```ts
        let budget: BudgetPatch | null = null
        if (args.budget !== undefined && args.budget !== null) {
          const parsed = parseBudget(args.budget)
          if (!parsed.ok) throw new InputError(parsed.error)
          budget = parsed.patch
        }
        const noteBudget = (swarm: string): void => {
          if (budget !== null) emit(makeEvent({ type: 'budget.set', swarm, src: 'mcp', data: budget, now }))
        }
```

Call `noteBudget(existing)` after the rename branch's `emit` and `noteBudget(id)` after the new swarm's `emit`. Import `parseBudget, type BudgetPatch` from `'../core/budget.ts'` and `BUDGET_MAX` from events.

- [ ] **Step 7: Run the gate**

Run: `npm run typecheck && npm test && npm run test:mod`
Expected: green. Update `tests/e2e/mcp-server.test.ts` only if it snapshots the init schema.

- [ ] **Step 8: Commit**

```bash
git add src/core/budget.ts src/mcp/tools.ts tests/core/budget.test.ts tests/mcp/init-budget.test.ts
git commit -m "Add the guard's limits and thresholds, and a budget on omnis_swarm_init"
```

---

### Task 3: The guard in the mod

Warn, nudge and block, live. The mod folds what its recorder lands, evaluates on each cost observation and on a 15 s timer while an agent is running, and acts.

**Files:**
- Create: `src/mod/budget-guard.ts`
- Modify: `src/mod/recorder.ts` (observer + exported `record`), `src/mod/register.ts`, `.claude-plugin/plugin.json` (three userConfig fields)
- Test: `src/mod/budget-guard.test.ts` (kit)

**Interfaces:**
- Consumes: Task 1 (event types, `ok <swarm>` reply), Task 2 (`limitsFrom`, `effective`, `evaluate`, `swarmCost`, `isBlocked`, texts).
- Produces:

```ts
// recorder.ts
export type RecordObserver = {
  /** The recorder's session.start ran: bind what needs $. */
  started: ($: EngineInterface) => void
  /** omnis_record accepted `body` (stamped `ts`) into `swarm`. */
  recorded: (body: RecordBody, ts: string, swarm: string) => void
}
export function registerRecorder(on: On, observer?: RecordObserver): void
export function record($: EngineInterface, body: RecordBody): Promise<void>   // the existing send()
// budget-guard.ts
export const TICK_MS = 15_000
export const guardObserver: RecordObserver
export function registerBudgetGuard(on: On, options: PluginOptions): void
export function guardView(): { limits: Limits; swarmUsd: number; swarm: string | null }
export function setSwarmBudget(usd: number): boolean   // false when no host is bound yet
```

- [ ] **Step 1: Write the failing kit test**

```ts
// src/mod/budget-guard.test.ts
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { registerRecorder } from './recorder.ts'
import { guardObserver, registerBudgetGuard } from './budget-guard.ts'

const LOADED = { timeoutMs: 60000 }
const SID = 'abcdef12-3456-7890-abcd-ef1234567890'
const T0 = Date.parse('2026-10-22T10:00:00.000Z')
type Seen = { records: Array<{ type: string; agent?: string; data: Record<string, unknown> }>; toasts: string[]; sends: Array<{ to: unknown; text: string }>; appends: string[]; deliver: boolean }

function engine(on: On): Seen {
  const seen: Seen = { records: [], toasts: [], sends: [], appends: [], deliver: true }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SID }))
  on('state.get', () => ({ value: { value: undefined, version: 0 } }))
  on('state.set', () => ({ value: { version: 1 } }))
  on('agent.list', () => ({ value: [] }))
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'plugin:omnis-swarm:omnis-swarm' } }))
  on('mcp.call', (_$, e) => {
    const a = e.args as { type: string; agent?: string; data: Record<string, unknown> }
    seen.records.push({ type: a.type, ...(a.agent !== undefined && { agent: a.agent }), data: a.data })
    return { value: { content: [{ type: 'text', text: 'ok s1' }], isError: false } }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(String(e.text))
    return { value: undefined }
  })
  on('session.send', (_$, e) => {
    seen.sends.push({ to: e.to, text: e.text })
    return seen.deliver ? { isDelivered: true } : { isDelivered: false, reason: 'No agent is reachable' }
  })
  on('session.append', (_$, e) => {
    seen.appends.push(JSON.stringify(e.message))
    return { value: { uuid: 'u1' } }
  })
  on('tool.check', () => ({ decision: 'allow' }))
  on('agent.spawn', () => ({ agentId: 'a1' }))
  return seen
}

async function boot($: Parameters<Parameters<typeof test>[2]>[0], on: On, options = {}) {
  const clock = mock.clock(on, { now: T0 })
  const seen = engine(on)
  registerRecorder(on, guardObserver)
  registerBudgetGuard(on, options)
  await $.session.start({ cwd: '/p', surface: null, isInteractive: false })
  await clock.settle()
  await $.agent.spawn({ name: 'coder-b', subagentType: 'coder', description: 'x', prompt: 'p' })
  await clock.settle()
  return { clock, seen }
}

// The timer ticks every 15 s from the spawn, so the stages fire on the 20:00 and 30:00 ticks exactly.
test('20 minutes in: guard.warned and a toast; 30 minutes: a nudge, a copy to main and guard.nudged', LOADED, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await clock.advance(21 * 60_000)
  await clock.settle()
  expect(seen.records.filter(r => r.type === 'guard.warned')).toEqual([{ type: 'guard.warned', agent: 'a1', data: { limit: 'time', value: 20, threshold: 20 } }])
  expect(seen.toasts).toContain('coder-b: 20 min, past its 20 min time-box')
  await clock.advance(10 * 60_000)
  await clock.settle()
  expect(seen.sends).toEqual([{ to: { agentId: 'a1' }, text: "You're past your time-box (30 min / $5). Wrap up what you have, report to main, and stop." }])
  expect(seen.appends[0]).toContain('[OmnisSwarm budget guard] coder-b passed its 30 min time-box')
  expect(seen.records.find(r => r.type === 'guard.nudged')!.data).toEqual({ limit: 'time', value: 30, threshold: 30, delivered: true })
})

test('a nudge that is not delivered is recorded with its reason and not retried', LOADED, async ($, on) => {
  const { clock, seen } = await boot($, on)
  seen.deliver = false
  await clock.advance(31 * 60_000)
  await clock.settle()
  await clock.advance(5 * 60_000)
  await clock.settle()
  expect(seen.sends.length).toBe(1)
  expect(seen.records.find(r => r.type === 'guard.nudged')!.data).toEqual({ limit: 'time', value: 30, threshold: 30, delivered: false, reason: 'No agent is reachable' })
})

test('past the swarm budget the lead may not spawn; a subagent, other tools and a raised budget may', LOADED, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await $.session.measure({ context: { window: 1 }, cost: { usd: 21 }, changed: ['cost'] } as never)
  await clock.settle()
  expect(seen.records.some(r => r.type === 'guard.blocked')).toBe(true)
  const lead = await $.tool.check({ tool: 'Agent', input: {}, tool_use_id: 't1' })
  expect(lead.decision).toBe('deny')
  expect(lead.reason).toBe('Swarm budget $20 reached. Raise it with /omnis budget <usd> or finish with the agents you have.')
  expect((await $.tool.check({ tool: 'Agent', input: {}, tool_use_id: 't2', agentId: 'a1' })).decision).toBe('allow')
  expect((await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 't3' })).decision).toBe('allow')
})

test('a limit from userConfig is used', LOADED, async ($, on) => {
  const { clock, seen } = await boot($, on, { budgetAgentMinutes: 9 })
  await clock.advance(7 * 60_000)
  await clock.settle()
  expect(seen.records.find(r => r.type === 'guard.warned')!.data).toEqual({ limit: 'time', value: 6, threshold: 6 })
})

test('no running agent, no timer', LOADED, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = engine(on)
  registerRecorder(on, guardObserver)
  registerBudgetGuard(on, {})
  await $.session.start({ cwd: '/p', surface: null, isInteractive: false })
  await clock.advance(60 * 60_000)
  await clock.settle()
  expect(seen.records.filter(r => r.type.startsWith('guard.'))).toEqual([])
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:mod`
Expected: FAIL — `Cannot find module './budget-guard.ts'`.

- [ ] **Step 3: Give the recorder an observer**

In `recorder.ts`: add the `RecordObserver` type; `let observer: RecordObserver | null = null` in module state (set in `registerRecorder`, reset to `null` when none is passed). Rename `send` to `record` and export it. In its success path:

```ts
    return $.mcp.call(server, RECORD_TOOL, args).then(result => {
      if (result.isError) return failed()
      rec.outbox.settle(true, carried)
      const block = result.content[0]
      const swarm = block !== undefined && block.type === 'text' && typeof block.text === 'string' && block.text.startsWith('ok ') ? block.text.slice(3) : ''
      // A throw in the observer must not count as a failed call.
      if (observer !== null && isValidSwarmId(swarm)) {
        try {
          observer.recorded(body, ts, swarm)
        } catch {
          // The guard keeps its last state.
        }
      }
    }, failed)
```

In the `session.start` hook, after `void start($).catch(() => {})`: `if (observer !== null) safely($, () => observer!.started($))`. Import `isValidSwarmId` from `../core/events.ts`.

- [ ] **Step 4: Write `src/mod/budget-guard.ts`**

```ts
/**
 * The budget guard (spec section 2): folds what this session's recorder lands, warns, nudges an agent past its
 * time-box or budget, and blocks the lead's new Agent calls past the swarm budget. It never stops work: a failure in
 * here fails open. Pure thresholds and words are in core/budget.ts.
 */
import type { EngineInterface, On, PluginOptions, Timer } from 'claude-code'
import {
  blockReason, effective, evaluate, isBlocked, limitsFrom, mainText, nudgeText, parseBudget, swarmCost, toastText,
  type BudgetPatch, type GuardAction, type Limits,
} from '../core/budget.ts'
import { makeEvent, type SwarmEvent } from '../core/events.ts'
import { emptyState, fold, LEAD, type SwarmState } from '../core/fold.ts'
import type { RecordBody } from '../core/recording.ts'
import { record, type RecordObserver } from './recorder.ts'

export const TICK_MS = 15_000
const SWARM_INIT_TOOL = /^mcp__.+__omnis_swarm_init$/
const SWARM_END_TOOL = /^mcp__.+__omnis_swarm_end$/
const TOAST_MS = 8_000

/** What the guard needs from the engine, bound from `$` at session.start. */
type GuardHost = {
  every: (ms: number, fn: () => void) => Timer
  toast: (text: string) => void
  sendTo: (agentId: string, text: string) => Promise<{ isDelivered: boolean; reason?: string }>
  tellMain: (text: string) => Promise<unknown>
  record: (body: RecordBody) => Promise<void>
}

type Guard = {
  defaults: Limits
  host: GuardHost | null
  state: SwarmState | null
  /** The session cost when this swarm began, and the latest one seen. */
  baseUsd: number | null
  sessionUsd: number | null
  /** A budget from an omnis_swarm_init that may land in a swarm the guard has not seen yet. */
  nextBudget: BudgetPatch | null
  timer: Timer | null
}

const freshGuard = (defaults: Limits): Guard => ({ defaults, host: null, state: null, baseUsd: null, sessionUsd: null, nextBudget: null, timer: null })
/** Module state; a hot reload starts it over (and may warn once more about an agent it had already warned about). */
let g: Guard = freshGuard(limitsFrom({}))

function hostOf($: EngineInterface): GuardHost {
  return {
    every: (ms, fn) => $.clock.every(ms, fn),
    toast: text => {
      try {
        $.ui.toast(text, { timeoutMs: TOAST_MS })
      } catch {
        // No toast stack (a headless session): the event in the log says it.
      }
    },
    sendTo: (agentId, text) => $.session.send({ to: { agentId }, text }),
    tellMain: text => $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } }),
    record: body => record($, body),
  }
}

const limits = (): Limits => (g.state === null ? g.defaults : effective(g.defaults, g.state))
const cost = (): number => (g.state === null ? 0 : swarmCost(g.state, g.baseUsd))
const nameOf = (id: string): string => g.state?.agents[id]?.name ?? id

/** Applies one event to the guard's own state, as the fold would; the swarm id is the state's. */
function apply(body: RecordBody, ts: string): void {
  if (g.state === null) return
  fold(g.state, makeEvent({ type: body.type, swarm: g.state.swarm.id, src: 'recorder', data: body.data, ...(body.agent !== undefined && { agent: body.agent }), now: new Date(ts) }) as SwarmEvent)
}

/** A different swarm: start over, carrying a pending init budget into it. */
function enter(swarm: string): void {
  g.state = emptyState(swarm)
  g.baseUsd = g.sessionUsd
  if (g.nextBudget !== null) {
    apply({ type: 'budget.set', data: g.nextBudget }, new Date(Date.now()).toISOString())
    g.nextBudget = null
  }
}

/** Ends the guard's swarm: nothing is timed or blocked until the next swarm's first event. */
function leave(): void {
  g.state = null
  g.nextBudget = null
  syncTimer()
}

const running = (): boolean => g.state !== null && Object.values(g.state.agents).some(a => a.id !== LEAD && !a.placeholder && a.finishedAt === null)

/** The timer runs only while an agent is running, at most every TICK_MS. */
function syncTimer(): void {
  const want = g.host !== null && running()
  if (want && g.timer === null) g.timer = g.host!.every(TICK_MS, () => check())
  if (!want && g.timer !== null) {
    g.timer.cancel()
    g.timer = null
  }
}

/** Records a guard event, folding it here first so a second check before the reply can't fire it again. */
function note(body: RecordBody): void {
  apply(body, new Date(Date.now()).toISOString())
  void g.host?.record(body).catch(() => undefined)
}

async function nudge(host: GuardHost, a: Extract<GuardAction, { kind: 'nudge' }>, lim: Limits): Promise<void> {
  let delivered = false
  let reason: string | undefined
  try {
    const sent = await host.sendTo(a.agent, nudgeText(lim))
    delivered = sent.isDelivered
    reason = sent.isDelivered ? undefined : String(sent.reason ?? '').slice(0, 80)
  } catch (err) {
    reason = err instanceof Error ? err.message.slice(0, 80) : 'the send failed'
  }
  void host.record({ type: 'guard.nudged', agent: a.agent, data: { limit: a.limit, value: a.value, threshold: a.threshold, delivered, ...(reason !== undefined && reason !== '' && { reason: reason.replace(/[\p{Cc}\p{Cf}]/gu, ' ') }) } }).catch(() => undefined)
  void host.tellMain(mainText(nameOf(a.agent), a, lim, delivered, reason)).catch(() => undefined)
}

/** One evaluation: every action is folded first, then acted on. A throw loses this check only. */
function check(): void {
  const host = g.host
  if (host === null || g.state === null) return
  try {
    const lim = limits()
    for (const a of evaluate(g.state, lim, cost(), Date.now())) {
      host.toast(toastText(a, a.kind === 'warn' || a.kind === 'nudge' ? nameOf(a.agent) : '', lim))
      if (a.kind === 'warn') note({ type: 'guard.warned', agent: a.agent, data: { limit: a.limit, value: a.value, threshold: a.threshold } })
      else if (a.kind === 'swarm-warn') note({ type: 'guard.warned', data: { limit: 'swarmCost', value: a.value, threshold: a.threshold } })
      else if (a.kind === 'block') note({ type: 'guard.blocked', data: { value: a.value, threshold: a.threshold } })
      else {
        // The nudge's own event waits for the send's answer; this keeps the stage from firing again meanwhile.
        apply({ type: 'guard.nudged', agent: a.agent, data: { limit: a.limit, value: a.value, threshold: a.threshold, delivered: false } }, new Date(Date.now()).toISOString())
        void nudge(host, a, lim)
      }
    }
  } catch {
    // Fail open.
  }
  syncTimer()
}

export const guardObserver: RecordObserver = {
  started: $ => {
    g.timer?.cancel()
    g.timer = null
    g.host = hostOf($)
    syncTimer()
  },
  recorded: (body, ts, swarm) => {
    // The guard's own events were folded when it sent them.
    if (body.type === 'guard.warned' || body.type === 'guard.nudged' || body.type === 'guard.blocked' || body.type === 'budget.set') return
    if (body.type === 'session.measure' && typeof body.data.costUsd === 'number') g.sessionUsd = body.data.costUsd
    if (g.state === null || g.state.swarm.id !== swarm) enter(swarm)
    apply(body, ts)
    if (body.type === 'agent.usage' || body.type === 'session.measure' || body.type === 'agent.started' || body.type === 'agent.finished') check()
  },
}

export function guardView(): { limits: Limits; swarmUsd: number; swarm: string | null } {
  return { limits: limits(), swarmUsd: cost(), swarm: g.state?.swarm.id ?? null }
}

/** /omnis budget <usd>: records budget.set and checks again (a raised limit lifts the block at once). */
export function setSwarmBudget(usd: number): boolean {
  if (g.host === null) return false
  if (g.state === null) {
    g.nextBudget = { ...g.nextBudget, swarmUsd: usd }
  } else {
    note({ type: 'budget.set', data: { swarmUsd: usd } })
    check()
  }
  return true
}

const failed = (result: { isError?: boolean; deny?: unknown }): boolean => result.isError === true || result.deny !== undefined

export function registerBudgetGuard(on: On, options: PluginOptions): void {
  g = freshGuard(limitsFrom(options))

  // Matched: guard.ts holds the one unmatched tool.check. Only the lead's real Agent calls are refused.
  on('tool.check', { tool: 'Agent' }, ($, e, next) =>
    e.agentId === undefined && e.tool_use_id !== undefined && g.state !== null && isBlocked(limits(), cost())
      ? { decision: 'deny' as const, reason: blockReason(limits()) }
      : next(e),
  ).catch((_$, e, next) => next(e))

  // A swarm boundary: init may carry a budget; end lets the block go.
  on('tool.call', { tool: [SWARM_INIT_TOOL, SWARM_END_TOOL] }, async ($, e, next) => {
    const result = await next(e)
    try {
      if (!failed(result)) {
        if (SWARM_END_TOOL.test(String(e.tool))) leave()
        else {
          const parsed = parseBudget((e as unknown as { budget?: unknown }).budget)
          leave()
          if (parsed.ok) g.nextBudget = parsed.patch
        }
      }
    } catch {
      // The guard keeps its last state.
    }
    return result
  }).catch((_$, e, next) => next(e))
}
```

The file ends near 220 lines.

- [ ] **Step 5: Wire it**

`register.ts`:

```ts
export const register: Register = (on, options) => {
  registerGuard(on)
  registerRecorder(on, guardObserver)
  registerBudgetGuard(on, options)
  registerPane(on, options)
}
```

`plugin.json` `userConfig` gains:

```json
    "budgetAgentMinutes": { "type": "number", "title": "Agent time-box (minutes)", "description": "An agent running this long is asked to wrap up; it is warned at two thirds of it. 1 to 1440.", "default": 30 },
    "budgetAgentUsd": { "type": "number", "title": "Agent budget (USD, approximate)", "description": "An agent whose estimated spend reaches this is asked to wrap up; it is warned at three fifths. Up to 1000.", "default": 5 },
    "budgetSwarmUsd": { "type": "number", "title": "Swarm budget (USD)", "description": "Past this, the lead can't start new agents until you raise it with /omnis budget <usd>; it warns at half. Up to 1000.", "default": 20 }
```

- [ ] **Step 6: Run the gate**

Run: `npm run typecheck && npm test && npm run test:mod`
Expected: green, including `claude plugin validate` accepting the number fields. If validate refuses `"type": "number"`, stop and report BLOCKED with its message (settled point 1 would be wrong).

- [ ] **Step 7: Commit**

```bash
git add src/mod/budget-guard.ts src/mod/budget-guard.test.ts src/mod/recorder.ts src/mod/register.ts .claude-plugin/plugin.json
git commit -m "Warn, nudge and block runaway agents and swarms from the mod"
```

---

### Task 3b: /omnis budget, and the budget figures in the pane

Runs after Task 6 has merged (both edit `src/mod/pane-draw.ts`).

**Files:**
- Modify: `src/mod/budget-command.ts`, `src/mod/budget-guard.ts` (adds `viewBudget()`), `src/mod/pane-draw.ts` (`viewOf` fills `View.budget` while live)
- Test: `src/mod/budget-command.test.ts` (kit), one case appended to `src/mod/budget-guard.test.ts`

**Interfaces:**
- Consumes: `Sub` (Task 0), `guardView`, `setSwarmBudget` (Task 3), `parseUsd`, `budgetText` (Task 2).
- Produces: `budgetSub: Sub` with name `budget`; `viewBudget(): ViewBudget | null` in `budget-guard.ts` (null while the guard has no swarm), consumed by `pane-draw.ts`.

- [ ] **Step 1: Write the failing kit test**

```ts
// src/mod/budget-command.test.ts
import { expect, test } from 'claude-code/testing'
import { budgetSub } from './budget-command.ts'
import { registerBudgetGuard, guardObserver } from './budget-guard.ts'
import { registerRecorder } from './recorder.ts'

test('/omnis budget with no amount shows the limits', async ($, on) => {
  registerRecorder(on, guardObserver)
  registerBudgetGuard(on, {})
  expect(await budgetSub!.run($, ['budget'])).toBe('Budget: each agent 30 min / $5 (warns at 20 min / $3); swarm $20 (warns at $10). Swarm so far ≈$0.00. New agents: allowed.')
})

test('/omnis budget refuses an amount it cannot read', async ($, on) => {
  registerBudgetGuard(on, {})
  for (const bad of ['abc', '0', '5000', '1e3']) expect(await budgetSub!.run($, ['budget', bad])).toBe('Usage: /omnis budget shows the limits; /omnis budget <usd> sets the swarm budget (above 0, at most 1000).')
})

test('/omnis budget 30 before the session has started says so', async ($, on) => {
  registerBudgetGuard(on, {})
  expect(await budgetSub!.run($, ['budget', '30'])).toBe('The budget guard is not running yet; try again once the session has started.')
})
```

Add one case to `src/mod/budget-guard.test.ts` (the Task 3 file, now owned here for this case only — append, do not change its other tests):

```ts
test('/omnis budget 30 lifts the block', LOADED, async ($, on) => {
  const { clock } = await boot($, on)
  await $.session.measure({ context: { window: 1 }, cost: { usd: 21 }, changed: ['cost'] } as never)
  await clock.settle()
  const { budgetSub } = await import('./budget-command.ts')
  expect(await budgetSub!.run($, ['budget', '30'])).toBe('Swarm budget set to $30. New agents: allowed.')
  expect((await $.tool.check({ tool: 'Agent', input: {}, tool_use_id: 't9' })).decision).toBe('allow')
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:mod`
Expected: FAIL — `budgetSub` is null.

- [ ] **Step 3: Implement**

```ts
// src/mod/budget-command.ts
/** /omnis budget: shows the limits, or sets the swarm budget (a budget.set event; spec section 2.3). */
import { budgetText, isBlocked, parseUsd } from '../core/budget.ts'
import { guardView, setSwarmBudget } from './budget-guard.ts'
import type { Sub } from './commands.ts'

const USAGE = 'Usage: /omnis budget shows the limits; /omnis budget <usd> sets the swarm budget (above 0, at most 1000).'

export const budgetSub: Sub | null = {
  name: 'budget',
  describe: '/omnis budget shows or sets the swarm budget',
  hint: 'budget [usd]',
  usage: USAGE,
  run: async (_$, words) => {
    if (words.length === 1) {
      const v = guardView()
      return budgetText(v.limits, v.swarmUsd)
    }
    const usd = words.length === 2 ? parseUsd(words[1]!) : null
    if (usd === null) return USAGE
    if (!setSwarmBudget(usd)) return 'The budget guard is not running yet; try again once the session has started.'
    const v = guardView()
    return `Swarm budget set to $${Number.isInteger(usd) ? usd : usd.toFixed(2)}. New agents: ${isBlocked(v.limits, v.swarmUsd) ? 'blocked' : 'allowed'}.`
  },
}
```

- [ ] **Step 4: Put the budget figures in the pane (§13.2 header)**

```ts
// budget-guard.ts, added
export function viewBudget(): ViewBudget | null {
  if (g.state === null) return null
  const lim = limits()
  const swarmUsd = cost()
  return { swarmUsd, limit: lim.swarmUsd, warn: warnLevel(lim, 'swarmUsd'), blocked: isBlocked(lim, swarmUsd) }
}
```

(import `warnLevel` from `../core/budget.ts`, `type ViewBudget` from `../render/types.ts`). In `pane-draw.ts`'s `viewOf`, add `budget: rt.replay === null ? viewBudget() : null` (a replay shows no live budget). The guard's state and the pane's are the same session's swarm, so the figures agree with what the block does. Kit case, appended to `budget-guard.test.ts`: after the $21 session cost, `viewBudget()` is `{ swarmUsd: 21, limit: 20, warn: 10, blocked: true }`.

- [ ] **Step 5: Run the gate**

Run: `npm run typecheck && npm test && npm run test:mod`
Expected: green; `src/mod/commands.test.ts`'s first test now fails on the changed description — update its expected strings to include `, /omnis budget shows or sets the swarm budget`, hint `pane [close | style robot|globe] | budget [usd]`, and the joined usage. That file's update belongs to this task.

- [ ] **Step 6: Commit**

```bash
git add src/mod/budget-command.ts src/mod/budget-command.test.ts src/mod/budget-guard.ts src/mod/budget-guard.test.ts src/mod/pane-draw.ts src/mod/commands.test.ts
git commit -m "Add /omnis budget and show the swarm budget in the pane header"
```

---

### Task 4a: The sweat drop on robots and globes, the drop flash, and every §13 token

**Follows `docs/design/pane.md` §13.1 and §13.2** (Rob approved the drop on both styles; there is no amber rim for the guard). Values below are copied from §13; if §13 and this task disagree, §13 wins and the task says so in its report.

**Files:**
- Create: `src/render/guard-badge.ts`
- Modify: `src/render/tokens.ts` (all of §13.1: `GUARD`, `REPLAY`, `GLYPH.times`), `src/render/sprites.ts` (`SkinSprite.sweat`), `src/render/robot.ts` (drop, drip, flash), `src/render/graph.ts` (globe drop, label clearance, guard pulses skipped), `src/render/types.ts` (`Pulse.guard?: true` only), `src/mod/pane-model.ts` (`pulsesFrom`, `markPulses`)
- Test: `tests/render/guard-badge.test.ts`, one case in `tests/mod/pane-model.test.ts`

**Interfaces:**
- Consumes: Task 1 `AgentState.guard`.
- Produces:

```ts
// guard-badge.ts (pure)
export type Drops = 0 | 1 | 2
/** 1 from the first guard.warned, 2 from the first guard.nudged; 0 for a done or failed agent (§13.2 "When it shows"). */
export function dropsFor(a: AgentState): Drops
/** Sprite pixels of the drop for one size; the second drop is the first mirrored, x → w - 1 - x. */
export function spriteDrops(s: SkinSprite, drops: Drops): Array<[number, number]>
/** The drip pixel(s) for hop slot `slot` (0-9): slots 2-4 only, M and L only, at body.x1 (and body.x0 when nudged). */
export function dripPixels(s: SkinSprite, size: RobotSize, drops: Drops, slot: number): Array<[number, number]>
/** Canvas pixels of a globe's drop(s), outside the ring at one o'clock (and eleven o'clock when nudged). */
export function globeDrops(p: Point, r: number, ringPx: number, drops: Drops): Array<[number, number]>
/** The drop colour under a flash: q3 3 and 1 white, 2 GUARD.drop; null when no flash is live. */
export function flashColour(pulses: readonly Pulse[], agent: string, tEff: number): number | null
// tokens.ts (§13.1)
export const GUARD = { drop: 0xe0f4ff, dripMix: 0.7, flashMs: 450, blockedBadge: { fg: CANVAS, bg: STATUS.failed } } as const
export const REPLAY = { raised: 0x202337, badge: { fg: CANVAS, bg: ACCENT } } as const
// GLYPH.times = '×'
// sprites.ts: SkinSprite.sweat: readonly (readonly [number, number])[]   (the warned pixels; clawd S/M/L per §13.2)
// types.ts: Pulse gains guard?: true
```

- [ ] **Step 1: Write the failing test**

```ts
// tests/render/guard-badge.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldAll, LEAD } from '../../src/core/fold.ts'
import { dripPixels, dropsFor, flashColour, globeDrops, spriteDrops } from '../../src/render/guard-badge.ts'
import { render } from '../../src/render/frame.ts'
import { ROBOT_SKINS } from '../../src/render/sprites.ts'
import { GUARD, MOTION } from '../../src/render/tokens.ts'
import { emptyView } from '../../src/render/types.ts'
import type { SwarmEvent } from '../../src/core/events.ts'
import { at, ev } from '../helpers.ts'

const clawd = ROBOT_SKINS.clawd!.sprites
const start = ev('agent.started', { name: 'coder-b', role: 'coder', description: '', parent: LEAD }, { agent: 'a1', atSec: 1 })
const warned: SwarmEvent[] = [start, ev('guard.warned', { limit: 'time', value: 21, threshold: 20 }, { agent: 'a1', atSec: 2 })]
const nudged: SwarmEvent[] = [...warned, ev('guard.nudged', { limit: 'time', value: 31, threshold: 30, delivered: true }, { agent: 'a1', atSec: 3 })]
const done: SwarmEvent[] = [...nudged, ev('agent.finished', { outcome: 'answer' }, { agent: 'a1', atSec: 4 })]

test('one drop when warned, two when nudged, none once done', () => {
  assert.equal(dropsFor(foldAll('s1', [start]).agents.a1!), 0)
  assert.equal(dropsFor(foldAll('s1', warned).agents.a1!), 1)
  assert.equal(dropsFor(foldAll('s1', nudged).agents.a1!), 2)
  assert.equal(dropsFor(foldAll('s1', done).agents.a1!), 0)
})

test('clawd drop pixels match §13.2, the nudged copy mirrored', () => {
  assert.deepEqual(spriteDrops(clawd.S, 1), [[7, 0], [7, 1]])
  assert.deepEqual(spriteDrops(clawd.M, 1), [[9, 0], [8, 1], [9, 1]])
  assert.deepEqual(spriteDrops(clawd.L, 1), [[11, 0], [10, 1], [11, 1], [10, 2], [11, 2]])
  assert.deepEqual(spriteDrops(clawd.M, 2), [[9, 0], [8, 1], [9, 1], [1, 0], [2, 1], [1, 1]])
  assert.deepEqual(spriteDrops(clawd.M, 0), [])
})

test('the drip runs in hop slots 2-4 down body.x1, M and L only, both sides when nudged', () => {
  const m = clawd.M
  assert.deepEqual(dripPixels(m, 'M', 1, 1), [])
  assert.deepEqual(dripPixels(m, 'M', 1, 2), [[m.body[2], 2]])
  assert.deepEqual(dripPixels(m, 'M', 1, 4), [[m.body[2], 4]])
  assert.deepEqual(dripPixels(m, 'M', 1, 5), [])
  assert.deepEqual(dripPixels(m, 'M', 2, 3), [[m.body[2], 3], [m.body[0], 3]])
  assert.deepEqual(dripPixels(clawd.S, 'S', 1, 3), [])
})

test('the globe drop sits outside the ring at one o-clock; a small globe gets two pixels', () => {
  const p = { x: 40, y: 20 }
  const k = 5.5 * Math.SQRT1_2
  const a = { x: Math.round(40 + k), y: Math.round(20 - k) + 1 }
  assert.deepEqual(globeDrops(p, 3, 1, 1), [[a.x + 1, a.y - 2], [a.x, a.y - 1], [a.x + 1, a.y - 1]])
  assert.equal(globeDrops(p, 2, 1, 1).length, 2)
  const both = globeDrops(p, 3, 1, 2)
  assert.equal(both.length, 6)
  assert.ok(both.slice(3).every(([x]) => x < p.x), 'the second drop is at eleven o-clock')
})

test('the flash: white, drop, white over 450 ms; nothing after', () => {
  assert.equal(GUARD.flashMs, MOTION.pulseMs)
  const pulse = { agent: 'a1', kind: 'other' as const, at: 1_000, isError: false, guard: true as const }
  assert.equal(flashColour([pulse], 'a1', 1_050), 0xffffff)
  assert.equal(flashColour([pulse], 'a1', 1_225), GUARD.drop)
  assert.equal(flashColour([pulse], 'a1', 1_500), null)
  assert.equal(flashColour([pulse], 'a2', 1_050), null)
})

const colours = (events: SwarmEvent[], style: 'globe' | 'robot'): Set<number> => {
  const f = render(foldAll('s1', events), { ...emptyView(), style }, at(5), { columns: 120, rows: 44 })
  const out = new Set<number>()
  for (let y = 0; y < f.top.rows; y++) for (let x = 0; x < f.top.columns; x++) out.add(f.top.fg(x, y)).add(f.top.bg(x, y))
  return out
}

for (const style of ['globe', 'robot'] as const) {
  test(`a warned ${style} shows GUARD.drop; an unwarned or finished one does not`, () => {
    assert.equal(colours([start], style).has(GUARD.drop), false)
    assert.equal(colours(warned, style).has(GUARD.drop), true)
    assert.equal(colours(done, style).has(GUARD.drop), false)
  })
}
```

The drop is drawn on the half-block canvas, so `GUARD.drop` shows as a cell's fg or bg wherever a drop pixel lands; the pixel-exact checks cover position.

Add to `tests/mod/pane-model.test.ts`:

```ts
test('a guard event becomes a guard pulse that is never coalesced', () => {
  const evs = [
    ev('agent.tool', { phase: 'start', tool: 'Read', kind: 'read', subject: 'a', isError: false }, { agent: 'a1', atSec: 1 }),
    ev('guard.warned', { limit: 'time', value: 21, threshold: 20 }, { agent: 'a1', atSec: 1 }),
  ]
  const marked = markPulses(pulsesFrom(evs), {})
  const guard = marked.pulses.find(p => p.guard === true)!
  assert.equal(guard.coalesced, undefined)
  assert.equal(guard.kind, 'other')
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/render/guard-badge.test.ts tests/mod/pane-model.test.ts`
Expected: FAIL — `Cannot find module '../../src/render/guard-badge.ts'`.

- [ ] **Step 3: Tokens and sprites**

`tokens.ts`: add `GUARD` and `REPLAY` exactly as in Interfaces (with §13.1's contrast notes as comments), and `times: '×'` to `GLYPH` (if `safeGlyph` refuses U+00D7, stop and report: §13.1 assumes it is allowed). `sprites.ts`: `SkinSprite` gains `sweat: readonly (readonly [number, number])[]`; clawd S `[[7, 0], [7, 1]]`, M `[[9, 0], [8, 1], [9, 1]]`, L `[[11, 0], [10, 1], [11, 1], [10, 2], [11, 2]]`. Any other skin in `ROBOT_SKINS` gets `sweat: []` and a line in the report (§13 defines only clawd).

- [ ] **Step 4: Write `src/render/guard-badge.ts`**

```ts
/** The guard's sweat drop (pane.md §13.2): how many, where, the drip and the flash. Pure. */
import type { AgentState } from '../core/fold.ts'
import type { RobotSize, SkinSprite } from './sprites.ts'
import { GUARD } from './tokens.ts'
import type { Point, Pulse } from './types.ts'

export type Drops = 0 | 1 | 2

export function dropsFor(a: AgentState): Drops {
  if (a.finishedAt !== null || a.outcome !== null) return 0
  const g = a.guard
  if (g.timeAct !== null || g.costAct !== null) return 2
  return g.timeWarn !== null || g.costWarn !== null ? 1 : 0
}

export function spriteDrops(s: SkinSprite, drops: Drops): Array<[number, number]> {
  if (drops === 0) return []
  const one = s.sweat.map(([x, y]): [number, number] => [x, y])
  return drops === 1 ? one : [...one, ...one.map(([x, y]): [number, number] => [s.w - 1 - x, y])]
}

/** Slots 2, 3 and 4 of the hop's 10-slot clock put the drip at rows dropBottom + 1, + 2, + 3, skipped past the body. */
export function dripPixels(s: SkinSprite, size: RobotSize, drops: Drops, slot: number): Array<[number, number]> {
  if (drops === 0 || size === 'S' || slot < 2 || slot > 4 || s.sweat.length === 0) return []
  const dropBottom = Math.max(...s.sweat.map(([, y]) => y))
  const y = dropBottom + (slot - 1)
  if (y > s.body[3]) return []
  const out: Array<[number, number]> = [[s.body[2], y]]
  if (drops === 2) out.push([s.body[0], y])
  return out
}

export function globeDrops(p: Point, r: number, ringPx: number, drops: Drops): Array<[number, number]> {
  if (drops === 0) return []
  const k = (r + ringPx + 1.5) * Math.SQRT1_2
  const a = { x: Math.round(p.x + k), y: Math.round(p.y - k) + 1 }
  const one: Array<[number, number]> = r >= 2.2 ? [[a.x + 1, a.y - 2], [a.x, a.y - 1], [a.x + 1, a.y - 1]] : [[a.x, a.y - 1], [a.x, a.y]]
  if (drops === 1) return one
  return [...one, ...one.map(([x, y]): [number, number] => [Math.round(2 * p.x - x), y])]
}

/** §13.2: q3(flash) 3 and 1 white, 2 the drop colour, over GUARD.flashMs, from the agent's newest guard pulse. */
export function flashColour(pulses: readonly Pulse[], agent: string, tEff: number): number | null {
  let at = Number.NEGATIVE_INFINITY
  for (const p of pulses) if (p.guard === true && p.agent === agent && p.at <= tEff && p.at > at) at = p.at
  const age = tEff - at
  if (!(age >= 0 && age < GUARD.flashMs)) return null
  const q = 3 - Math.min(2, Math.floor((age / GUARD.flashMs) * 3))
  return q === 2 ? GUARD.drop : 0xffffff
}
```

Under a degraded budget (`motion.pulseFade` off) the flash is one frame of `#ffffff` held for `pulseHoldMs` (§13.2 table): the caller passes `tEff` clamped to the pulse's `at` while its age is under `motion.pulseHoldMs`, and nothing after.

- [ ] **Step 5: Draw it**

- `pane-model.ts` `pulsesFrom`: for `guard.warned` / `guard.nudged` with an agent and `limit !== 'swarmCost'`, push `{ agent, kind: 'other', at, isError: false, guard: true }`. `markPulses`: a guard pulse is never coalesced and does **not** restart the agent's flicker clock.
- Every tool-pulse consumer skips guard pulses so behaviour is unchanged for tools: `robotPulses` (`robot.ts`), the globe flicker (`graph.ts`), and `busiest` (`spotlight.ts`; a one-line filter here, ahead of Task 4b, noted in the report). `targetFps` keeps them: a flash runs at `FPS.busy`.
- `robot.ts`: after the sprite and before the bar, paint `spriteDrops(s, dropsFor(a))` in `flashColour(...) ?? GUARD.drop`, riding the hop offset like the sprite. At size S with `arms === 'up'`, skip `(7, 1)` (§13.2: the arm wins). Drip: `dripPixels(s, size, drops, slot)` in `mix(body, GUARD.drop, GUARD.dripMix)`, with `slot` from the same hop slot clock the hop uses (§12.5; `grep -n "hop" src/render/robot.ts`), only when `motion.breathe` and the frame is not `still`.
- `graph.ts`: after the halo and rims, before links, paint `globeDrops(n.p, n.r, GRAPH.ringPx, dropsFor(a))` in `flashColour(...) ?? GUARD.drop`, and count those pixels in the node's footprint for label clearance (the `reach`/`below` computation near lines 221-237).
- Add a warned fixture to `tests/render/frame.test.ts`'s pair-budget case (§13.6: the drop adds 1-2 colours per node, not measured).

- [ ] **Step 6: Run the gate**

Run: `npm run typecheck && npm test && npm run test:mod && git diff --stat tests/render/golden`
Expected: green; golden diff empty. Render warned and nudged robots at S, M and L and a warned and a nudged globe through `paintGrids` in a scratch script (not committed) and send the PNG paths to the designer for §13.7's first three checks.

- [ ] **Step 7: Commit**

```bash
git add src/render src/mod/pane-model.ts tests/render/guard-badge.test.ts tests/mod/pane-model.test.ts tests/render/frame.test.ts
git commit -m "Draw a sweat drop on agents past their budget, with a flash when it appears"
```

---

### Task 4b: Guard words in the spotlight, the tree and the header

**Follows §13.2 "Words elsewhere" and "A blocked swarm in the header".**

**Files:**
- Modify: `src/render/guard-badge.ts` (adds `guardWords`), `src/render/spotlight.ts` (row 4), `src/render/tree.ts`, `src/render/header.ts`, `src/render/frame.ts`, `src/render/types.ts` (`View.budget`)
- Test: `tests/render/guard-words.test.ts`

**Interfaces:**
- Consumes: Task 4a `dropsFor`, `GUARD.blockedBadge`; Task 1 `AgentState.guard`.
- Produces:

```ts
// guard-badge.ts
/** §13.2 words: 'over time-box 21m/20m', 'over $3.20/$3', 'nudged 31m/30m'; the limit furthest past its stage wins. */
export function guardWords(a: AgentState, now: number): string | null
// types.ts
export type ViewBudget = { swarmUsd: number; limit: number; warn: number; blocked: boolean }
// View gains budget?: ViewBudget | null   (filled by the pane in Task 3b; absent in replays and GIFs)
```

- [ ] **Step 1: Write the failing test**

```ts
// tests/render/guard-words.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldAll, LEAD } from '../../src/core/fold.ts'
import type { SwarmEvent } from '../../src/core/events.ts'
import { guardWords } from '../../src/render/guard-badge.ts'
import { render } from '../../src/render/frame.ts'
import { gridText } from '../../src/render/grid.ts'
import { emptyView, type View } from '../../src/render/types.ts'
import { at, ev } from '../helpers.ts'

const start = ev('agent.started', { name: 'coder-b', role: 'coder', description: '', parent: LEAD }, { agent: 'a1', atSec: 0 })
const warnedTime: SwarmEvent[] = [start, ev('guard.warned', { limit: 'time', value: 20, threshold: 20 }, { agent: 'a1', atSec: 1200 })]

test('the words name the limit and the figures', () => {
  assert.equal(guardWords(foldAll('s1', [start]).agents.a1!, at(60)), null)
  assert.equal(guardWords(foldAll('s1', warnedTime).agents.a1!, at(21 * 60)), 'over time-box 21m/20m')
  const nudged = foldAll('s1', [...warnedTime, ev('guard.nudged', { limit: 'time', value: 30, threshold: 30, delivered: true }, { agent: 'a1', atSec: 1800 })])
  assert.equal(guardWords(nudged.agents.a1!, at(31 * 60)), 'nudged 31m/30m')
})

test('cost words use dollars; the limit furthest past wins', () => {
  const s = foldAll('s1', [
    ...warnedTime,
    ev('agent.usage', { model: 'claude-opus-5-5', input: 0, output: 160_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, { agent: 'a1', atSec: 1210 }),
    ev('guard.warned', { limit: 'agentCost', value: 3.2, threshold: 3 }, { agent: 'a1', atSec: 1211 }),
  ])
  assert.equal(guardWords(s.agents.a1!, at(20 * 60 + 15)), 'over $3.20/$3')
})

const top = (view: View = emptyView()) => gridText(render(foldAll('s1', warnedTime), view, at(21 * 60), { columns: 120, rows: 44 }).top)

test('the header shows swarm cost against its limit from the warn level, and BLOCKED while spawns are denied', () => {
  assert.doesNotMatch(top().join('\n'), /BLOCKED|\/\$20/)
  assert.match(top({ ...emptyView(), budget: { swarmUsd: 11.2, limit: 20, warn: 10, blocked: false } })[0]!, /≈\$11\.20\/\$20/)
  const blocked = top({ ...emptyView(), budget: { swarmUsd: 20.4, limit: 20, warn: 10, blocked: true } })
  assert.match(blocked[1]!, / BLOCKED /)
  assert.match(blocked[1]!, /new agents/)
  assert.match(blocked[1]!, /\/omnis budget <usd>/)
  assert.match(blocked[1]!, /1 over budget/)
})

test('the spotlight carries the words', () => {
  const f = render(foldAll('s1', warnedTime), { ...emptyView(), pinned: 'a1' }, at(21 * 60), { columns: 120, rows: 44 })
  assert.match(gridText(f.bottom!).join('\n'), /over time-box 21m\/20m/)
})
```

Add a tree-step case (a size that draws the tree; `tests/render/frame.test.ts` shows which) asserting ` over` follows the agent's figures, and a 1-row-header case asserting ` BLOCKED ` sits right-aligned before the gaps marker.

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/render/guard-words.test.ts`
Expected: FAIL — `guardWords` is not exported.

- [ ] **Step 3: Implement**

```ts
// guard-badge.ts, added
const fmtM = (min: number): string => `${Math.floor(min)}m`
const fmtD = (usd: number): string => `$${Number.isInteger(usd) ? usd : usd.toFixed(2)}`

export function guardWords(a: AgentState, now: number): string | null {
  const drops = dropsFor(a)
  if (drops === 0) return null
  const g = a.guard
  const minutes = Math.max(0, now - a.startedAt) / 60_000
  // Nudged words use the act thresholds, warned words the warn ones; a limit only warned falls back to its warn figure.
  const time = drops === 2 ? (g.timeAct ?? null) : g.timeWarn
  const cost = drops === 2 ? (g.costAct ?? null) : g.costWarn
  const nudgedTime = drops === 2 && g.timeAct !== null
  const nudgedCost = drops === 2 && g.costAct !== null
  const t = time ?? g.timeWarn
  const c = cost ?? g.costWarn
  const tr = t === null ? -1 : minutes / t
  const cr = c === null ? -1 : a.costUsd / c
  if (tr < 0 && cr < 0) return null
  if (tr >= cr) return nudgedTime ? `nudged ${fmtM(minutes)}/${fmtM(t!)}` : `over time-box ${fmtM(minutes)}/${fmtM(t!)}`
  const spent = Math.round(a.costUsd * 100) / 100
  return nudgedCost ? `nudged ${fmtD(spent)}/${fmtD(c!)}` : `over ${fmtD(spent)}/${fmtD(c!)}`
}
```

- `spotlight.ts` row 4 (the "tool activity by kind, errors, stuck" row, ~line 127): right-aligned before `! stuck`, `[guardWords(agent, nowMs), STATUS.warn]`, whole or absent.
- `tree.ts`: after the figures, `[' over', STATUS.warn]` when `dropsFor(agent) > 0`.
- `types.ts`: `ViewBudget`, and `View.budget?: ViewBudget | null`.
- `header.ts` / `frame.ts`: `HeaderNotes` gains `budget?: ViewBudget | null` and `overBudget?: number`; `render` fills them from `view.budget` and the count of agents with `dropsFor > 0`. Row 0's cost group: below `warn`, unchanged; from `warn`, the figure in `STATUS.warn` (`STATUS.failed` from `limit`) then `/$<limit>` in `TEXT.dim`. Row 1 notes: priority 0, ahead of the degraded note, while `blocked`: ` BLOCKED ` in `GUARD.blockedBadge` (fg on bg; if `Part` can't carry a background, give `writeParts` an optional third element for it, keeping two-element parts working), then ` new agents` `TEXT.dim`, SEP, `/omnis budget <usd>` `TEXT.dim`; priority 2, after the degraded note: `n over budget` in `STATUS.warn` when n > 0. 1-row header and `drawSummary`: ` BLOCKED ` right-aligned before the gaps marker, nothing else.

- [ ] **Step 4: Run the gate**

Run: `npm run typecheck && npm test && npm run test:mod && git diff --stat tests/render/golden`
Expected: green; golden diff empty (no fixture sets `view.budget` or a guard event).

- [ ] **Step 5: Commit**

```bash
git add src/render tests/render/guard-words.test.ts
git commit -m "Say in words which agents are over budget and when spawns are blocked"
```

---

### Task 5: omnis_replay and the replay clock

**Files:**
- Create: `src/core/replay-clock.ts`, `src/core/replay-reply.ts`, `src/mcp/tools/replay.ts`, `src/mcp/log-cursor.ts`
- Modify: `src/mcp/tools/feed.ts` (imports `atLineStart`, `offsetAfter` from `log-cursor.ts`; no behaviour change), `src/mcp/registry.ts`
- Test: `tests/core/replay-clock.test.ts`, `tests/mcp/replay.test.ts`

**Interfaces:**
- Consumes: Task 1 `REPLAY_TOOL`, `INTERNAL_TOOL`.
- Produces:

```ts
// replay-clock.ts (pure, mod-safe; used by the mod in Task 6 and the server in Task 8)
export const MAX_GAP_MS = 2_000
export const MIN_SPEED = 1
export const MAX_SPEED = 60
export function replayOffsets(ts: readonly number[], speed: number, maxGapMs?: number): number[]
export function retime(events: readonly SwarmEvent[], speed: number, startMs: number, maxGapMs?: number): { events: SwarmEvent[]; offsets: number[]; logTs: number[] }
export function logTimeAt(logTs: readonly number[], offsets: readonly number[], r: number): number
export function fitSpeed(ts: readonly number[], targetMs: number, minSpeed: number, maxGapMs?: number): number
// replay-reply.ts (pure, mod-safe)
export const REPLAY_MAX_EVENTS = 20_000
export type ReplayReply = { v: 1; kind: 'replay'; swarm: string; offset: number; done: boolean; events: SwarmEvent[]; bad: number } | { v: 1; kind: 'none'; recent: string[] }
export function parseReplayReply(text: string): ReplayReply | null
// log-cursor.ts (server)
export function atLineStart(file: string, offset: number): boolean
export function offsetAfter(file: string, since: number, count: number): { offset: number; bad: number }
// tools/replay.ts
export function createReplayTools(ctx: ToolContext): ToolDef[]
```

- [ ] **Step 1: Write the failing clock test**

```ts
// tests/core/replay-clock.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fitSpeed, logTimeAt, replayOffsets, retime } from '../../src/core/replay-clock.ts'
import { LEAD } from '../../src/core/fold.ts'
import { at, ev } from '../helpers.ts'

test('offsets divide gaps by the speed and cut quiet ones to 2 s', () => {
  assert.deepEqual(replayOffsets([0, 1_000, 61_000, 62_000], 10), [0, 100, 2_100, 2_200])
  assert.deepEqual(replayOffsets([0, 1_000, 61_000], 1), [0, 1_000, 3_000])
  assert.deepEqual(replayOffsets([], 10), [])
  assert.deepEqual(replayOffsets([5_000, 4_000], 10), [0, 0])
})

test('retime sorts, rewrites timestamps onto the replay clock and keeps the log times', () => {
  const a = ev('agent.started', { name: 'a', role: 'r', description: '', parent: LEAD }, { agent: 'a1', atSec: 10 })
  const b = ev('agent.finished', { outcome: 'answer' }, { agent: 'a1', atSec: 70 })
  const out = retime([b, a], 10, 1_000_000)
  assert.deepEqual(out.events.map(e => e.type), ['agent.started', 'agent.finished'])
  assert.deepEqual(out.events.map(e => Date.parse(e.ts)), [1_000_000, 1_002_000])
  assert.deepEqual(out.logTs, [at(10), at(70)])
  assert.equal(out.events[0]!.swarm, a.swarm)
})

test('the log time at a replay offset is interpolated, cut gaps included', () => {
  const logTs = [0, 1_000, 61_000]
  const offsets = replayOffsets(logTs, 10)
  assert.equal(logTimeAt(logTs, offsets, 50), 500)
  assert.equal(logTimeAt(logTs, offsets, 1_100), 31_000)
  assert.equal(logTimeAt(logTs, offsets, 99_999), 61_000)
  assert.equal(logTimeAt(logTs, offsets, -5), 0)
})

test('fitSpeed finds the slowest speed whose replay fits', () => {
  const ts = Array.from({ length: 600 }, (_, i) => i * 1_000)
  const s = fitSpeed(ts, 27_000, 0.25)
  const end = (sp: number) => replayOffsets(ts, sp).at(-1)!
  assert.ok(end(s) <= 27_000)
  assert.ok(end(s * 0.99) > 27_000)
  assert.equal(fitSpeed([0, 1_000], 27_000, 0.25), 0.25)
})
```

- [ ] **Step 2: Write the failing tool test**

```ts
// tests/mcp/replay.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendEvent } from '../../src/core/log.ts'
import { makeEvent } from '../../src/core/events.ts'
import { parseReplayReply } from '../../src/core/replay-reply.ts'
import { createReplayTools } from '../../src/mcp/tools/replay.ts'
import { Session } from '../../src/mcp/session.ts'
import { tmpRoot } from '../helpers.ts'

const tool = (root: string) => createReplayTools({ root, session: new Session(root) })[0]!
const seed = (root: string, swarm: string, n: number) => {
  for (let i = 0; i < n; i++) {
    appendEvent(root, makeEvent({ type: 'message.sent', swarm, src: 'recorder', data: { to: 'main', summary: 'x'.repeat(150) }, now: new Date(Date.UTC(2026, 9, 22, 10, 0, i)) }))
  }
}

test('omnis_replay pages a swarm from offset 0 to done', () => {
  const root = tmpRoot()
  seed(root, 'alpha', 400)
  let since = 0
  let total = 0
  for (let page = 0; page < 20; page++) {
    const reply = parseReplayReply(tool(root).handler({ swarm: 'alpha', since }).text)
    assert.ok(reply !== null && reply.kind === 'replay')
    total += reply.events.length
    since = reply.offset
    if (reply.done) break
  }
  assert.equal(total, 400)
})

test('with no swarm named it replays the most recent log', () => {
  const root = tmpRoot()
  seed(root, 'older', 1)
  seed(root, 'newer', 1)
  const reply = parseReplayReply(tool(root).handler({ since: 0 }).text)
  assert.equal(reply?.kind === 'replay' && reply.swarm, 'newer')
})

test('an unknown swarm answers none with the recent ids', () => {
  const root = tmpRoot()
  seed(root, 'alpha', 1)
  assert.deepEqual(parseReplayReply(tool(root).handler({ swarm: 'nope', since: 0 }).text), { v: 1, kind: 'none', recent: ['alpha'] })
})

test('a bad swarm id or offset is refused', () => {
  const root = tmpRoot()
  assert.throws(() => tool(root).handler({ swarm: '../x', since: 0 }), { name: 'InputError' })
  assert.throws(() => tool(root).handler({ swarm: 'con', since: 0 }), { name: 'InputError' })
  assert.throws(() => tool(root).handler({ since: -1 }), { name: 'InputError' })
})

test('parseReplayReply refuses events from another swarm and non-replies', () => {
  assert.equal(parseReplayReply('nope'), null)
  assert.equal(parseReplayReply(JSON.stringify({ v: 1, kind: 'replay', swarm: 'a', offset: 1, done: true, events: [{ v: 1, ts: '2026-10-22T10:00:00.000Z', swarm: 'b', src: 'mcp', type: 'swarm.ended', data: {} }], bad: 0 })), null)
})
```

Add to `src/mod/guard.test.ts`'s first test loop the replay tool name `mcp__plugin_omnis-swarm_omnis-swarm__omnis_replay` (the regex was widened in Task 1; this proves it for the new tool).

- [ ] **Step 3: Run them to verify they fail**

Run: `node --test tests/core/replay-clock.test.ts tests/mcp/replay.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Write `src/core/replay-clock.ts`**

```ts
/** The replay clock (spec sections 3 and 4): gaps divided by the speed, quiet ones cut, events re-timed onto it. Pure, mod-safe. */
import type { SwarmEvent } from './events.ts'

export const MAX_GAP_MS = 2_000
export const MIN_SPEED = 1
export const MAX_SPEED = 60
const SOURCE_ORDER: Record<string, number> = { mcp: 0, recorder: 1, transcripts: 2 }

/** Replay milliseconds from the first event for each log time (sorted ascending): each gap / speed, at most maxGapMs. */
export function replayOffsets(ts: readonly number[], speed: number, maxGapMs = MAX_GAP_MS): number[] {
  const out: number[] = []
  let r = 0
  for (let i = 0; i < ts.length; i++) {
    if (i > 0) r += Math.min(Math.max(0, ts[i]! - ts[i - 1]!) / speed, maxGapMs)
    out.push(r)
  }
  return out
}

/** Sorted as the log reader sorts (time, then source, then file order), each ts moved to startMs + its replay offset. */
export function retime(events: readonly SwarmEvent[], speed: number, startMs: number, maxGapMs = MAX_GAP_MS): { events: SwarmEvent[]; offsets: number[]; logTs: number[] } {
  const sorted = events
    .map((event, index) => ({ event, index, time: Date.parse(event.ts) }))
    .filter(x => !Number.isNaN(x.time))
    .sort((a, b) => a.time - b.time || (SOURCE_ORDER[a.event.src] ?? 9) - (SOURCE_ORDER[b.event.src] ?? 9) || a.index - b.index)
  const logTs = sorted.map(x => x.time)
  const offsets = replayOffsets(logTs, speed, maxGapMs)
  return { events: sorted.map((x, i) => ({ ...x.event, ts: new Date(startMs + offsets[i]!).toISOString() }) as SwarmEvent), offsets, logTs }
}

/** The log time a replay offset stands for: interpolated between events, so a cut gap runs its log time faster. */
export function logTimeAt(logTs: readonly number[], offsets: readonly number[], r: number): number {
  if (logTs.length === 0) return 0
  if (r <= offsets[0]!) return logTs[0]!
  let lo = 0
  let hi = offsets.length - 1
  if (r >= offsets[hi]!) return logTs[hi]!
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (offsets[mid]! <= r) lo = mid
    else hi = mid
  }
  const span = offsets[hi]! - offsets[lo]!
  return span <= 0 ? logTs[hi]! : logTs[lo]! + ((r - offsets[lo]!) / span) * (logTs[hi]! - logTs[lo]!)
}

/** The slowest speed, not below minSpeed, at which the replay lasts at most targetMs. Duration falls as speed rises. */
export function fitSpeed(ts: readonly number[], targetMs: number, minSpeed: number, maxGapMs = MAX_GAP_MS): number {
  const end = (s: number) => replayOffsets(ts, s, maxGapMs).at(-1) ?? 0
  if (end(minSpeed) <= targetMs) return minSpeed
  let lo = minSpeed
  let hi = minSpeed
  while (end(hi) > targetMs && hi < 1e9) hi *= 2
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2
    if (end(mid) <= targetMs) hi = mid
    else lo = mid
  }
  return hi
}
```

- [ ] **Step 5: Write `src/core/replay-reply.ts`**

```ts
/** The omnis_replay reply and the mod's check of it. Pure and mod-safe. */
import { isValidSwarmId, parseLine, type SwarmEvent } from './events.ts'
import { FEED_MAX_EVENTS } from './feed-reply.ts'

/** The most events the pane loads for one replay. */
export const REPLAY_MAX_EVENTS = 20_000

export type ReplayReply =
  | { v: 1; kind: 'replay'; swarm: string; offset: number; done: boolean; events: SwarmEvent[]; bad: number }
  | { v: 1; kind: 'none'; recent: string[] }

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const isCount = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0

export function parseReplayReply(text: string): ReplayReply | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObj(raw) || raw.v !== 1) return null
  if (raw.kind === 'none') {
    if (!Array.isArray(raw.recent) || raw.recent.length > 5 || !raw.recent.every(r => typeof r === 'string' && isValidSwarmId(r))) return null
    return { v: 1, kind: 'none', recent: raw.recent as string[] }
  }
  if (raw.kind !== 'replay' || typeof raw.swarm !== 'string' || !isValidSwarmId(raw.swarm) || !isCount(raw.offset) || typeof raw.done !== 'boolean' || !isCount(raw.bad)) return null
  if (!Array.isArray(raw.events) || raw.events.length > FEED_MAX_EVENTS) return null
  const events: SwarmEvent[] = []
  for (const item of raw.events) {
    const parsed = parseLine(JSON.stringify(item))
    if (!parsed.ok || parsed.event.swarm !== raw.swarm) return null
    events.push(parsed.event)
  }
  return { v: 1, kind: 'replay', swarm: raw.swarm, offset: raw.offset, done: raw.done, events, bad: raw.bad }
}
```

- [ ] **Step 6: Move the cursor helpers and write the tool**

Move `atLineStart` and `offsetAfter` from `feed.ts` into `src/mcp/log-cursor.ts` verbatim, exported (with their `node:fs` imports, `LIMITS`, `parseLine`, `MAX_READ_BYTES`); `feed.ts` imports them.

```ts
// src/mcp/tools/replay.ts
/**
 * omnis_replay: hands the pane a recorded swarm's events, page by page, for /omnis replay. Internal: the mod's guard
 * refuses the model (INTERNAL_TOOL). Read-only: it never appends events or changes which swarm the session owns.
 */
import { existsSync, statSync } from 'node:fs'
import { isValidSwarmId } from '../../core/events.ts'
import { fitEvents } from '../../core/feed-reply.ts'
import { readEvents, sortEvents, swarmLogPath } from '../../core/log.ts'
import { REPLAY_TOOL } from '../../core/recording.ts'
import type { ReplayReply } from '../../core/replay-reply.ts'
import { recentSwarmIds } from '../../core/swarm.ts'
import { offsetAfter } from '../log-cursor.ts'
import type { Args, ToolDef } from '../protocol.ts'
import type { ToolContext } from '../tools.ts'
import { InputError, optString } from '../validate.ts'

const SWARM_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const FAILED = 'Could not read the swarm files in .omnis-swarm/ (see the server log).'

function since(args: Args): number {
  const v = args.since
  if (v === undefined || v === null) return 0
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new InputError('since must be a whole number of at least 0')
  return v
}

export function createReplayTools(ctx: ToolContext): ToolDef[] {
  const { root } = ctx
  const answer = (reply: ReplayReply) => ({ text: JSON.stringify(reply) })
  const tool: ToolDef = {
    name: REPLAY_TOOL,
    description: 'Internal to the OmnisSwarm pane: reads a recorded swarm for /omnis replay. When the OmnisSwarm mod is loaded it refuses calls from the model.',
    inputSchema: {
      type: 'object',
      properties: {
        swarm: { type: 'string', pattern: SWARM_ID.source, description: 'The swarm to replay; the most recent when left out.' },
        since: { type: 'integer', minimum: 0, description: 'The offset from the last reply; 0 to start.' },
      },
      additionalProperties: false,
    },
    handler: args => {
      const from = since(args)
      const named = optString(args, 'swarm', 64)
      if (named !== undefined && !isValidSwarmId(named)) throw new InputError('swarm is not a valid swarm id')
      try {
        const recent = recentSwarmIds(root, 5)
        const id = named ?? recent[0]
        if (id === undefined || !existsSync(swarmLogPath(root, id))) return answer({ v: 1, kind: 'none', recent })
        const file = swarmLogPath(root, id)
        const read = readEvents(file, from)
        if (read.reset) return answer({ v: 1, kind: 'replay', swarm: id, offset: 0, done: false, events: [], bad: 0 })
        const fit = Math.min(fitEvents(read.events, id), 500)
        const cut = fit === read.events.length ? { offset: read.offset, bad: read.bad } : offsetAfter(file, from, fit)
        const done = cut.offset >= statSync(file).size
        return answer({ v: 1, kind: 'replay', swarm: id, offset: cut.offset, done, events: sortEvents(read.events.slice(0, fit)), bad: cut.bad })
      } catch (err) {
        process.stderr.write(`omnis: omnis_replay failed: ${err instanceof Error ? err.message : String(err)}\n`)
        throw new Error(FAILED)
      }
    },
  }
  return [tool]
}
```

`registry.ts`: add `createReplayTools` to `toolFactories` (after `createFeedTools`).

- [ ] **Step 7: Run the gate**

Run: `npm run typecheck && npm test && npm run test:mod`
Expected: green; `tests/e2e/mcp-server.test.ts` lists tools — add `omnis_replay` to its expected list (this task owns that line).

- [ ] **Step 8: Commit**

```bash
git add src/core/replay-clock.ts src/core/replay-reply.ts src/mcp tests/core/replay-clock.test.ts tests/mcp/replay.test.ts tests/e2e/mcp-server.test.ts src/mod/guard.test.ts
git commit -m "Add the replay clock and the internal omnis_replay tool"
```

---

### Task 6: /omnis replay in the pane, and the REPLAY header

**Follows `docs/design/pane.md` §13.3.** Uses Task 4a's `REPLAY` tokens and `GLYPH.times`; edits `header.ts`/`frame.ts` after Task 4b.

**Files:**
- Create: `src/mod/replay.ts`
- Modify: `src/mod/replay-command.ts`, `src/mod/pane-runtime.ts` (`replay` field), `src/mod/pane-draw.ts` (`frameAt` picks the replay model; live news ignored while replaying), `src/mod/pane.ts` (nothing beyond imports if needed), `src/render/types.ts`, `src/render/frame.ts` (`Notes.replay`), `src/render/header.ts`
- Test: `src/mod/replay.test.ts` (kit), `tests/render/replay-header.test.ts`

**Interfaces:**
- Consumes: `retime`, `logTimeAt`, `MIN_SPEED`, `MAX_SPEED` (Task 5), `parseReplayReply`, `REPLAY_MAX_EVENTS`, `REPLAY_TOOL`, `pulsesFrom`, `markPulses`, `prunePulses`, `emptyModel` (pane-model.ts), `fold`, `emptyState`.
- Produces:
  - `pane-runtime.ts`: `Runtime.replay: ReplayRun | null` where `type ReplayRun = { swarm: string; speed: number; events: SwarmEvent[]; logTs: number[]; offsets: number[]; startMs: number; cursor: number; model: PaneModel; timer: Timer | null; ended: boolean }`.
  - `replay.ts`: `loadReplay(host: Host, swarm: string | null): Promise<{ ok: true; swarm: string; events: SwarmEvent[] } | { ok: false; text: string }>`, `startReplay(host, swarm, events, speed): void`, `stopReplay(host): void`, `replayTick(host): void`, `REPLAY_TICK_MS = 100`.
  - `frame.ts`: `Notes.replay?: { speed: number; clockMs: number; totalMs: number; ended: boolean } | null`, drawn by `drawHeader`/`drawSummary` per §13.3. `clockMs` is log time since the swarm's first event; `totalMs` the swarm's own length (no gap cutting).
  - `header.ts`: `fmtClock(ms): string` — `mm:ss` (two-digit minutes) under an hour, `h:mm:ss` from one.
  - `replaySub: Sub` with name `replay`.

- [ ] **Step 1: Write the failing header test**

```ts
// tests/render/replay-header.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldAll } from '../../src/core/fold.ts'
import { render } from '../../src/render/frame.ts'
import { gridText } from '../../src/render/grid.ts'
import { emptyView } from '../../src/render/types.ts'
import { fmtClock } from '../../src/render/header.ts'
import { REPLAY } from '../../src/render/tokens.ts'
import { fiveAgentEvents, FIVE_SWARM, FIVE_AT } from '../fixtures/swarm-five.ts'

const state = foldAll(FIVE_SWARM, fiveAgentEvents())

const replay = (over: Partial<{ speed: number; clockMs: number; totalMs: number; ended: boolean }> = {}) =>
  ({ replay: { speed: 10, clockMs: 192_000, totalMs: 520_000, ended: false, ...over } })

test('row 0 starts with the badge and the swarm clock', () => {
  const f = render(state, emptyView(), FIVE_AT.mid, { columns: 120, rows: 44 }, replay())
  assert.match(gridText(f.top)[0]!, /^ REPLAY 10× {2}03:12 \/ 08:40 {2}◆ /)
})

test('at the end the clock says end and row 1 offers the stop command', () => {
  const f = render(state, emptyView(), FIVE_AT.mid, { columns: 120, rows: 44 }, replay({ clockMs: 520_000, ended: true }))
  const rows = gridText(f.top)
  assert.match(rows[0]!, /08:40 \/ 08:40 end/)
  assert.match(rows[1]!, /\/omnis replay stop/)
})

test('both header rows are painted REPLAY.raised', () => {
  const f = render(state, emptyView(), FIVE_AT.mid, { columns: 120, rows: 44 }, replay())
  assert.equal(f.top.bg(60, 0), REPLAY.raised)
  assert.equal(f.top.bg(60, 1), REPLAY.raised)
  assert.equal(f.top.bg(1, 0), REPLAY.badge.bg)
})

test('the clock reads h:mm:ss past an hour', () => {
  assert.equal(fmtClock(192_000), '03:12')
  assert.equal(fmtClock(3_792_000), '1:03:12')
})

test('without a replay the header is unchanged', () => {
  const plain = render(state, emptyView(), FIVE_AT.mid, { columns: 120, rows: 44 })
  assert.doesNotMatch(gridText(plain.top)[0]!, /REPLAY/)
})
```

Add one case per size step (`tests/render/frame.test.ts` lists the sizes) asserting the badge shows on the 1-row header and the summary line too (§13.7: "at every size step").

- [ ] **Step 2: Write the failing kit test**

```ts
// src/mod/replay.test.ts
import { expect, mock, test } from 'claude-code/testing'
import { registerPane } from './pane.ts'
import { engine, opened, RUN, settle } from './test-engine.ts'
import { FIVE_AT, FIVE_SWARM, fiveAgentEvents } from '../../tests/fixtures/swarm-five.ts'

const LOADED = { timeoutMs: 60000 }
const page = (done: boolean) => JSON.stringify({ v: 1, kind: 'replay', swarm: FIVE_SWARM, offset: 9, done, events: fiveAgentEvents(), bad: 0 })

test('/omnis replay opens the pane, plays at 10× by default, and stop returns to live', LOADED, async ($, on) => {
  const clock = mock.clock(on, { now: FIVE_AT.mid })
  const seen = engine(on)
  on('mcp.call', (_$, e) => (e.tool === 'omnis_replay' ? { value: { content: [{ type: 'text', text: page(true) }], isError: false } } : undefined))
  registerPane(on, { panel: 'command' })
  await $.session.start({ cwd: '/p', surface: null, isInteractive: true })
  expect((await $.command.run({ command: 'omnis', args: 'replay', ...RUN })).text).toBe(`Replaying ${FIVE_SWARM} at 10×. /omnis replay stop returns to live.`)
  expect(seen.opens).toBe(1)
  await opened($, on)
  await clock.advance(500)
  await settle()
  expect(seen.calls.some(c => c.tool === 'omnis_replay' && c.args.since === 0)).toBe(true)
  expect((await $.command.run({ command: 'omnis', args: 'replay stop', ...RUN })).text).toBe('Back to the live swarm.')
})

test('speed outside 1-60 and an unknown swarm are refused', LOADED, async ($, on) => {
  engine(on)
  on('mcp.call', (_$, e) => (e.tool === 'omnis_replay' ? { value: { content: [{ type: 'text', text: JSON.stringify({ v: 1, kind: 'none', recent: ['alpha'] }) }], isError: false } } : undefined))
  registerPane(on, { panel: 'command' })
  await $.session.start({ cwd: '/p', surface: null, isInteractive: true })
  expect((await $.command.run({ command: 'omnis', args: 'replay alpha 61', ...RUN })).text).toBe('Usage: /omnis replay [swarm] [speed 1-60], or /omnis replay stop.')
  expect((await $.command.run({ command: 'omnis', args: 'replay nope', ...RUN })).text).toBe('No swarm nope here. Recent: alpha.')
})
```

If the kit refuses two `mcp.call` hooks (the stub engine already has one), add an `onTool` switch to `test-engine.ts`'s `Seen` instead — `test-engine.ts` is test support owned by this task for that one change.

- [ ] **Step 3: Run them to verify they fail**

Run: `node --test tests/render/replay-header.test.ts && npm run test:mod`
Expected: FAIL — `Notes` has no `replay`; `replaySub` is null.

- [ ] **Step 4: Header and frame**

`frame.ts`: `Notes` gains `replay` (Interfaces). `header.ts`, per §13.3:

- `drawHeader` / `drawSummary` take the replay through `HeaderNotes.replay`. While it is set, both rows (and the 1-row header and summary line) are filled with `REPLAY.raised` in place of `CANVAS_RAISED`.
- Row 0 starts with ` REPLAY ${speed}${GLYPH.times} ` in `REPLAY.badge` (fg on bg, the way Task 4b draws ` BLOCKED `), then ` ${fmtClock(clockMs)}` `TEXT.primary` and ` / ${fmtClock(totalMs)}` `TEXT.dim`, then ` end` `TEXT.dim` once `ended`, then two spaces and the usual row 0. Badge and clock are never dropped; everything after them keeps the whole-or-absent rule.
- Row 1 notes gain `/omnis replay stop` `TEXT.dim` at priority 1 once `ended`.
- 1-row header and summary line: the badge first, then the clock if it fits whole, then the usual parts.

```ts
/** The replay clock (§13.3): mm:ss under an hour, h:mm:ss from one. */
export const fmtClock = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}
```

Ages in the feed, the burn rate and live timeline bars already follow `now`, which in a replay is the re-timed clock (settled point 8), so §13.3's "measured against the replay clock" needs no further change.

- [ ] **Step 5: Write `src/mod/replay.ts`**

```ts
/**
 * /omnis replay (spec section 3): loads a recorded swarm through omnis_replay, re-times it onto the replay clock and
 * plays it into the pane's own model, so the unchanged renderer animates it as it does live. Mod-safe.
 */
import type { SwarmEvent } from '../core/events.ts'
import { emptyState, fold } from '../core/fold.ts'
import { REPLAY_TOOL } from '../core/recording.ts'
import { logTimeAt, retime } from '../core/replay-clock.ts'
import { parseReplayReply, REPLAY_MAX_EVENTS } from '../core/replay-reply.ts'
import { emptyModel, markPulses, prunePulses, pulsesFrom } from './pane-model.ts'
import { show, stopFrames } from './pane-draw.ts'
import { rt, type Host } from './pane-runtime.ts'

export const REPLAY_TICK_MS = 100
const MAX_PAGES = 60

export async function loadReplay(host: Host, swarm: string | null): Promise<{ ok: true; swarm: string; events: SwarmEvent[] } | { ok: false; text: string }> {
  const server = rt.server ?? (await host.connect().catch(() => null))
  if (server === null) return { ok: false, text: 'The swarm server is not connected yet; try again in a moment.' }
  const events: SwarmEvent[] = []
  let since = 0
  let id = swarm
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await host.call(server, REPLAY_TOOL, { since, ...(id !== null && { swarm: id }) })
    const block = result.content[0]
    const reply = !result.isError && block !== undefined && block.type === 'text' && typeof block.text === 'string' ? parseReplayReply(block.text) : null
    if (reply === null) return { ok: false, text: 'The swarm log could not be read for a replay.' }
    if (reply.kind === 'none') return { ok: false, text: reply.recent.length === 0 ? 'No recorded swarm here yet.' : `No swarm ${swarm ?? ''} here. Recent: ${reply.recent.join(', ')}.` }
    id = reply.swarm
    events.push(...reply.events)
    if (events.length > REPLAY_MAX_EVENTS) return { ok: false, text: 'That swarm is too long to replay in the pane; try /omnis export gif.' }
    if (reply.done) return { ok: true, swarm: reply.swarm, events }
    since = reply.offset
  }
  return { ok: false, text: 'That swarm is too long to replay in the pane; try /omnis export gif.' }
}

export function startReplay(host: Host, swarm: string, events: readonly SwarmEvent[], speed: number): void {
  stopReplay(host, false)
  const startMs = Date.now()
  const timed = retime(events, speed, startMs)
  rt.replay = {
    swarm, speed, events: timed.events, logTs: timed.logTs, offsets: timed.offsets, startMs, cursor: 0,
    model: { ...emptyModel(), swarm, state: emptyState(swarm) }, timer: host.every(REPLAY_TICK_MS, () => replayTick(host)), ended: false,
  }
  rt.spot = null
  rt.tween = null
  rt.last = null
  host.invalidate()
}

/** Folds every event now due into the replay model and draws. At the end the timer stops and the final state stays. */
export function replayTick(host: Host): void {
  const run = rt.replay
  if (run === null) return
  try {
    const now = Date.now()
    const due: SwarmEvent[] = []
    while (run.cursor < run.events.length && Date.parse(run.events[run.cursor]!.ts) <= now) due.push(run.events[run.cursor++]!)
    if (due.length > 0) {
      const state = run.model.state!
      for (const e of due) fold(state, e)
      const marked = markPulses(pulsesFrom(due), run.model.lastFlicker)
      run.model = { ...run.model, pulses: prunePulses([...run.model.pulses, ...marked.pulses], now), lastFlicker: marked.lastFlicker }
    }
    if (run.cursor >= run.events.length && !run.ended) {
      run.ended = true
      run.timer?.cancel()
      run.timer = null
    }
    show(host, now)
  } catch {
    stopReplay(host)
  }
}

/** The log clock the header shows. */
export const replayClockMs = (now: number): number => {
  const run = rt.replay
  if (run === null || run.logTs.length === 0) return 0
  return logTimeAt(run.logTs, run.offsets, now - run.startMs) - run.logTs[0]!
}

export function stopReplay(host: Host, redraw = true): void {
  rt.replay?.timer?.cancel()
  rt.replay = null
  rt.spot = null
  rt.tween = null
  rt.last = null
  stopFrames()
  if (redraw) host.invalidate()
}
```

`pane-runtime.ts`: add the `ReplayRun` type and `replay: null` in `fresh`. `pane-draw.ts`: in `frameAt`, read `const model = rt.replay?.model ?? rt.model` everywhere it reads `rt.model` (pulses, degraded notes, state), prune into whichever it read, and pass `{ ..., replay: rt.replay === null ? null : { speed: rt.replay.speed, clockMs: replayClockMs(now), totalMs: replayTotalMs(), ended: rt.replay.ended } }` in `render`'s notes, where `replayTotalMs = () => run.logTs.at(-1)! - run.logTs[0]!` (0 with no events) lives beside `replayClockMs`; `replayClockMs` is imported from `./replay.ts` (a cycle `replay.ts` ↔ `pane-draw.ts` of functions only, resolved at call time; if the type-checker or kit objects, move `replayClockMs` into `pane-draw.ts`). In `hooks.show`, return early while `rt.replay !== null` so live pulls don't overwrite the replay; `hooks.swarmChanged` likewise leaves the replay alone. In `closed()`, call `rt.replay?.timer?.cancel(); rt.replay = null`.

- [ ] **Step 6: Write the command**

```ts
// src/mod/replay-command.ts
/** /omnis replay [swarm] [speed] and /omnis replay stop (spec section 3). */
import { isValidSwarmId } from '../core/events.ts'
import { MAX_SPEED, MIN_SPEED } from '../core/replay-clock.ts'
import type { Sub } from './commands.ts'
import { openPane } from './pane-draw.ts'
import { hostOf, rt } from './pane-runtime.ts'
import { loadReplay, startReplay, stopReplay } from './replay.ts'

const USAGE = 'Usage: /omnis replay [swarm] [speed 1-60], or /omnis replay stop.'
const DEFAULT_SPEED = 10

/** [swarm] [speed] in either order is not allowed: a lone number is the speed, a lone id the swarm. */
export function parseReplay(words: readonly string[]): { swarm: string | null; speed: number } | 'stop' | null {
  const rest = words.slice(1)
  if (rest.length === 1 && rest[0] === 'stop') return 'stop'
  if (rest.length > 2) return null
  let swarm: string | null = null
  let speed = DEFAULT_SPEED
  for (const [i, w] of rest.entries()) {
    if (/^\d{1,2}$/.test(w)) {
      speed = Number(w)
      if (speed < MIN_SPEED || speed > MAX_SPEED) return null
    } else if (i === 0 && isValidSwarmId(w) && w !== 'stop') swarm = w
    else return null
  }
  return { swarm, speed }
}

export const replaySub: Sub | null = {
  name: 'replay',
  describe: '/omnis replay [swarm] [speed] replays a recorded swarm',
  hint: 'replay [swarm] [speed] | replay stop',
  usage: USAGE,
  run: async ($, words) => {
    const parsed = parseReplay(words)
    if (parsed === null) return USAGE
    const host = rt.host ?? hostOf($)
    if (parsed === 'stop') {
      if (rt.replay === null) return 'No replay is playing.'
      stopReplay(host)
      return 'Back to the live swarm.'
    }
    if (rt.panel === 'off') return 'The swarm pane is off (the panel setting). Set it to command or auto in /config to use it.'
    const loaded = await loadReplay(host, parsed.swarm)
    if (!loaded.ok) return loaded.text
    if (!rt.open) await openPane($)
    startReplay(host, loaded.swarm, loaded.events, parsed.speed)
    return `Replaying ${loaded.swarm} at ${parsed.speed}×. /omnis replay stop returns to live.`
  },
}
```

Add a node test of `parseReplay` to `src/mod/replay.test.ts` as a kit `test` (it is pure): `replay` → `{ swarm: null, speed: 10 }`, `replay alpha 20` → `{ swarm: 'alpha', speed: 20 }`, `replay 5` → `{ swarm: null, speed: 5 }`, `replay 0`, `replay alpha beta`, `replay alpha 61` → null, `replay stop` → `'stop'`.

- [ ] **Step 7: Run the gate**

Run: `npm run typecheck && npm test && npm run test:mod && git diff --stat tests/render/golden && wc -l src/mod/*.ts`
Expected: green; golden diff empty; every file < 500. Update `commands.test.ts`'s expected description, hint and usage (append the replay parts) — Task 3b, which merges after this task, appends its budget parts on top.

- [ ] **Step 8: Commit**

```bash
git add src/mod src/render tests/render/replay-header.test.ts
git commit -m "Replay a recorded swarm in the pane with /omnis replay"
```

---

### Task 7: GIF codec and the shared rasteriser

Pure and self-contained; it can start as soon as the plan is approved.

**Files:**
- Create: `src/render/raster.ts`, `src/gif/palette.ts`, `src/gif/lzw.ts`, `src/gif/encode.ts`, `tests/gif/decode.ts` (test support)
- Modify: `scripts/preview.ts` (imports `paintGrids` from `src/render/raster.ts`; output unchanged)
- Test: `tests/gif/lzw.test.ts`, `tests/gif/encode.test.ts`, `tests/render/raster.test.ts`

**Interfaces:**
- Produces:

```ts
// raster.ts (pure)
export type Cells = { columns: number; rows: number; glyph: Uint32Array; fg: Uint32Array; bg: Uint32Array }
export function cellsOf(grids: readonly (Grid | null)[], columns: number, rows: number): Cells   // stacks grids with one blank row between, padded with CANVAS
export function paintCell(rgb: Uint8Array, width: number, x0: number, y0: number, glyph: number, fg: number, bg: number): void
export function paintGrids(grids: readonly Grid[]): { width: number; height: number; rgb: Uint8Array }  // what preview.ts did
export function changedBox(a: Cells | null, b: Cells): { x: number; y: number; w: number; h: number } | null  // in cells
// palette.ts
export class Palette { indexOf(rgb: number): number; table(): Uint8Array; get size(): number }
export const TRANSPARENT = 0
// lzw.ts
export function lzwEncode(indices: Uint8Array, minCodeSize?: number): Uint8Array
// encode.ts
export type GifFrame = { x: number; y: number; w: number; h: number; delayCs: number; transparent: boolean; lzw: Uint8Array }
export class GifWriter {
  constructor(width: number, height: number)
  /** Adds the next full-canvas frame (cell grid); unchanged cells become transparent; no change at all adds to the last delay. */
  add(cells: Cells, delayCs: number): void
  get frames(): number
  get bytes(): number      // running estimate of the file size
  finish(): Uint8Array
}
```

- [ ] **Step 1: Write the test decoder**

```ts
// tests/gif/decode.ts
/** A small GIF89a reader for the encoder's tests: global palette, frames, LZW. Not shipped. */
export function lzwDecode(data: Uint8Array, minCodeSize: number, count: number): Uint8Array {
  const clear = 1 << minCodeSize
  const eoi = clear + 1
  const out = new Uint8Array(count)
  const prefix = new Int32Array(4096)
  const suffix = new Uint8Array(4096)
  const first = new Uint8Array(4096)
  for (let i = 0; i < clear; i++) {
    prefix[i] = -1
    suffix[i] = i
    first[i] = i
  }
  const stack = new Uint8Array(4097)
  let size = minCodeSize + 1
  let next = eoi + 1
  let prev = -1
  let bits = 0
  let nbits = 0
  let p = 0
  let op = 0
  for (;;) {
    while (nbits < size) {
      if (p >= data.length) return out.subarray(0, op)
      bits |= data[p++]! << nbits
      nbits += 8
    }
    const code = bits & ((1 << size) - 1)
    bits >>>= size
    nbits -= size
    if (code === clear) {
      size = minCodeSize + 1
      next = eoi + 1
      prev = -1
      continue
    }
    if (code === eoi) break
    if (prev === -1) {
      out[op++] = suffix[code]!
      prev = code
      continue
    }
    let sp = 0
    let c = code
    if (code >= next) {
      stack[sp++] = first[prev]!
      c = prev
    }
    while (c >= clear) {
      stack[sp++] = suffix[c]!
      c = prefix[c]!
    }
    stack[sp++] = c
    const head = c
    while (sp > 0 && op < count) out[op++] = stack[--sp]!
    if (next < 4096) {
      prefix[next] = prev
      suffix[next] = head
      first[next] = first[prev]!
      next++
      if (next === 1 << size && size < 12) size++
    }
    prev = code
  }
  return out.subarray(0, op)
}

export type Decoded = { width: number; height: number; palette: number[]; frames: Array<{ x: number; y: number; w: number; h: number; delayCs: number; transparent: number | null; disposal: number; pixels: Uint8Array }>; loops: boolean }

export function decodeGif(b: Uint8Array): Decoded {
  const u16 = (i: number) => b[i]! | (b[i + 1]! << 8)
  if (String.fromCharCode(...b.subarray(0, 6)) !== 'GIF89a') throw new Error('not GIF89a')
  const width = u16(6)
  const height = u16(8)
  const packed = b[10]!
  const gct = 2 << (packed & 7)
  const palette: number[] = []
  let p = 13
  for (let i = 0; i < gct; i++, p += 3) palette.push((b[p]! << 16) | (b[p + 1]! << 8) | b[p + 2]!)
  const frames: Decoded['frames'] = []
  let gce = { delayCs: 0, transparent: null as number | null, disposal: 0 }
  let loops = false
  const blocks = (): Uint8Array => {
    const parts: number[] = []
    for (let n = b[p++]!; n > 0; n = b[p++]!) {
      for (let i = 0; i < n; i++) parts.push(b[p + i]!)
      p += n
    }
    return Uint8Array.from(parts)
  }
  for (;;) {
    const tag = b[p++]
    if (tag === 0x3b) break
    if (tag === 0x21) {
      const label = b[p++]
      if (label === 0xf9) {
        const flags = b[p + 1]!
        gce = { delayCs: u16(p + 2), transparent: flags & 1 ? b[p + 4]! : null, disposal: (flags >> 2) & 7 }
        p += 6
      } else {
        const body = blocks()
        if (label === 0xff && String.fromCharCode(...body.subarray(0, 11)) === 'NETSCAPE2.0') loops = true
      }
      continue
    }
    if (tag !== 0x2c) throw new Error(`bad block ${tag}`)
    const x = u16(p)
    const y = u16(p + 2)
    const w = u16(p + 4)
    const h = u16(p + 6)
    p += 9
    const min = b[p++]!
    frames.push({ x, y, w, h, ...gce, pixels: lzwDecode(blocks(), min, w * h) })
  }
  return { width, height, palette, frames, loops }
}
```

- [ ] **Step 2: Write the failing codec tests**

```ts
// tests/gif/lzw.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lzwEncode } from '../../src/gif/lzw.ts'
import { lzwDecode } from './decode.ts'

const roundTrip = (data: Uint8Array) => assert.deepEqual(lzwDecode(lzwEncode(data), 8, data.length), data)

test('LZW round-trips short, repetitive, random and dictionary-filling input', () => {
  roundTrip(Uint8Array.from([7]))
  roundTrip(new Uint8Array(10_000).fill(3))
  roundTrip(Uint8Array.from({ length: 5000 }, (_, i) => i % 7))
  let seed = 1
  roundTrip(Uint8Array.from({ length: 200_000 }, () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 16) & 255))
})

test('a flat run compresses well', () => {
  assert.ok(lzwEncode(new Uint8Array(100_000)).length < 2_000)
})
```

```ts
// tests/gif/encode.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GifWriter } from '../../src/gif/encode.ts'
import { Palette, TRANSPARENT } from '../../src/gif/palette.ts'
import type { Cells } from '../../src/render/raster.ts'
import { CELL_H, CELL_W } from '../../src/render/svg.ts'
import { decodeGif } from './decode.ts'

const cells = (columns: number, rows: number, bg: number): Cells => ({
  columns, rows, glyph: new Uint32Array(columns * rows).fill(0x20), fg: new Uint32Array(columns * rows).fill(0xffffff), bg: new Uint32Array(columns * rows).fill(bg),
})

test('a two-frame GIF decodes: header, loop, palette, a full frame then a small transparent one', () => {
  const w = new GifWriter(4 * CELL_W, 3 * CELL_H)
  const a = cells(4, 3, 0x0d1117)
  w.add(a, 10)
  const b = cells(4, 3, 0x0d1117)
  b.bg[5] = 0xff8800
  w.add(b, 10)
  const gif = decodeGif(w.finish())
  assert.equal(gif.width, 32)
  assert.equal(gif.height, 48)
  assert.equal(gif.loops, true)
  assert.equal(gif.frames.length, 2)
  assert.deepEqual([gif.frames[1]!.x, gif.frames[1]!.y, gif.frames[1]!.w, gif.frames[1]!.h], [CELL_W, CELL_H, CELL_W, CELL_H])
  assert.equal(gif.frames[1]!.transparent, TRANSPARENT)
  assert.equal(gif.frames[0]!.pixels.every(i => gif.palette[i] === 0x0d1117), true)
  assert.equal(gif.frames[1]!.pixels.every(i => gif.palette[i] === 0xff8800), true)
})

test('an unchanged frame adds its delay to the last one', () => {
  const w = new GifWriter(8, 16)
  w.add(cells(1, 1, 0x112233), 10)
  w.add(cells(1, 1, 0x112233), 10)
  const gif = decodeGif(w.finish())
  assert.equal(gif.frames.length, 1)
  assert.equal(gif.frames[0]!.delayCs, 20)
})

test('the palette keeps index 0 free and maps colours past 255 to the nearest', () => {
  const p = new Palette()
  assert.notEqual(p.indexOf(0x000000), TRANSPARENT)
  for (let i = 1; i <= 300; i++) p.indexOf(i * 50_000)
  assert.equal(p.size, 256)
  const near = p.indexOf(0xfefefe)
  assert.ok(near > 0 && near < 256)
})
```

```ts
// tests/render/raster.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { changedBox, cellsOf, paintGrids } from '../../src/render/raster.ts'
import { goldenFrame, GOLDEN_CASES } from './golden-cases.ts'

test('paintGrids sizes the picture as preview did', () => {
  const f = goldenFrame(GOLDEN_CASES[0]!)
  const grids = f.bottom === null ? [f.top] : [f.top, f.bottom]
  const pic = paintGrids(grids)
  assert.equal(pic.width, Math.max(...grids.map(g => g.columns)) * 8)
  assert.equal(pic.height, (grids.reduce((n, g) => n + g.rows, 0) + grids.length - 1) * 16)
})

test('changedBox finds the cells that differ', () => {
  const f = goldenFrame(GOLDEN_CASES[0]!)
  const a = cellsOf([f.top, f.bottom], 120, 56)
  const b = cellsOf([f.top, f.bottom], 120, 56)
  assert.equal(changedBox(a, b), null)
  b.bg[3 * 120 + 7] = 0x123456
  assert.deepEqual(changedBox(a, b), { x: 7, y: 3, w: 1, h: 1 })
  assert.deepEqual(changedBox(null, b), { x: 0, y: 0, w: 120, h: 56 })
})
```

- [ ] **Step 3: Run them to verify they fail**

Run: `node --test tests/gif/*.test.ts tests/render/raster.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Write the rasteriser**

`src/render/raster.ts`: move `DOTS`, the `fill` closure and the per-cell drawing body of `paint()` from `scripts/preview.ts` into `paintCell` (same maths: `bg` fill unless `DEFAULT`, `blockShape`, braille dots, the 0.6 soft bar for any other non-space glyph; `fg === DEFAULT` reads `0xc9d1d9`), operating on `rgb`/`width` passed in. `paintGrids` is the old `paint()` calling `paintCell`. `cellsOf` copies `top` rows, leaves one row of `CANVAS` background (`import { CANVAS } from './tokens.ts'`), copies `bottom`, and fills any remaining rows and columns with `CANVAS`. `changedBox`:

```ts
export function changedBox(a: Cells | null, b: Cells): { x: number; y: number; w: number; h: number } | null {
  if (a === null || a.columns !== b.columns || a.rows !== b.rows) return { x: 0, y: 0, w: b.columns, h: b.rows }
  let x0 = b.columns
  let y0 = b.rows
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < b.rows; y++) {
    for (let x = 0; x < b.columns; x++) {
      const i = y * b.columns + x
      if (a.glyph[i] === b.glyph[i] && a.fg[i] === b.fg[i] && a.bg[i] === b.bg[i]) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
}
```

`scripts/preview.ts` keeps `png()` and its output loop and calls `paintGrids`. Run `node scripts/preview.ts .superpowers/preview-check` before and after and compare the PNG bytes (`cmp`): identical.

- [ ] **Step 5: Write palette, LZW and the writer**

```ts
// src/gif/palette.ts
/** The GIF's one global colour table: index 0 is the transparent colour; colours take indices first-come, then map to the nearest. */
export const TRANSPARENT = 0

export class Palette {
  readonly #colors: number[] = [0x000000]
  readonly #index = new Map<number, number>()

  get size(): number {
    return this.#colors.length
  }

  indexOf(rgb: number): number {
    const known = this.#index.get(rgb)
    if (known !== undefined) return known
    let i: number
    if (this.#colors.length < 256) {
      i = this.#colors.length
      this.#colors.push(rgb)
    } else {
      let best = 1
      let bestD = Number.POSITIVE_INFINITY
      for (let j = 1; j < 256; j++) {
        const c = this.#colors[j]!
        const dr = ((c >> 16) & 255) - ((rgb >> 16) & 255)
        const dg = ((c >> 8) & 255) - ((rgb >> 8) & 255)
        const db = (c & 255) - (rgb & 255)
        const d = dr * dr + dg * dg + db * db
        if (d < bestD) {
          bestD = d
          best = j
        }
      }
      i = best
    }
    this.#index.set(rgb, i)
    return i
  }

  /** 256 RGB triplets, unused slots black. */
  table(): Uint8Array {
    const t = new Uint8Array(768)
    this.#colors.forEach((c, i) => {
      t[i * 3] = (c >> 16) & 255
      t[i * 3 + 1] = (c >> 8) & 255
      t[i * 3 + 2] = c & 255
    })
    return t
  }
}
```

```ts
// src/gif/lzw.ts
/** GIF's variable-width LZW: codes from minCodeSize+1 bits up to 12, packed least significant bit first. */
export function lzwEncode(indices: Uint8Array, minCodeSize = 8): Uint8Array {
  const clear = 1 << minCodeSize
  const eoi = clear + 1
  const out: number[] = []
  let size = minCodeSize + 1
  let next = eoi + 1
  let dict = new Map<number, number>()
  let buf = 0
  let count = 0
  const emit = (code: number): void => {
    buf |= code << count
    count += size
    while (count >= 8) {
      out.push(buf & 255)
      buf >>>= 8
      count -= 8
    }
  }
  emit(clear)
  if (indices.length > 0) {
    let prefix = indices[0]!
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i]!
      const key = prefix * 256 + k
      const found = dict.get(key)
      if (found !== undefined) {
        prefix = found
        continue
      }
      emit(prefix)
      if (next === 4096) {
        emit(clear)
        dict = new Map()
        size = minCodeSize + 1
        next = eoi + 1
      } else {
        if (next >= 1 << size) size++
        dict.set(key, next++)
      }
      prefix = k
    }
    emit(prefix)
  }
  emit(eoi)
  if (count > 0) out.push(buf & 255)
  return Uint8Array.from(out)
}
```

```ts
// src/gif/encode.ts
/**
 * A GIF89a writer for the export (spec section 4): one global palette, a looping animation, and frame differencing at
 * cell level. Each frame paints only the cells that changed; unchanged pixels inside that box are transparent. Pure.
 */
import { changedBox, paintCell, type Cells } from '../render/raster.ts'
import { CELL_H, CELL_W } from '../render/svg.ts'
import { lzwEncode } from './lzw.ts'
import { Palette, TRANSPARENT } from './palette.ts'

export type GifFrame = { x: number; y: number; w: number; h: number; delayCs: number; transparent: boolean; lzw: Uint8Array }
const MAX_DELAY_CS = 65_535

export class GifWriter {
  readonly width: number
  readonly height: number
  readonly #palette = new Palette()
  readonly #frames: GifFrame[] = []
  #last: Cells | null = null
  #lastIdx: Uint8Array | null = null
  #bytes = 800

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
  }

  get frames(): number {
    return this.#frames.length
  }

  get bytes(): number {
    return this.#bytes
  }

  add(cells: Cells, delayCs: number): void {
    const box = changedBox(this.#last, cells)
    const prev = this.#frames.at(-1)
    if (box === null && prev !== undefined && prev.delayCs + delayCs <= MAX_DELAY_CS) {
      prev.delayCs += delayCs
      return
    }
    const b = box ?? { x: 0, y: 0, w: 1, h: 1 }
    const px = { x: b.x * CELL_W, y: b.y * CELL_H, w: Math.min(b.w * CELL_W, this.width - b.x * CELL_W), h: Math.min(b.h * CELL_H, this.height - b.y * CELL_H) }
    const rgb = new Uint8Array(px.w * px.h * 3)
    for (let cy = b.y; cy < b.y + b.h; cy++) {
      for (let cx = b.x; cx < b.x + b.w; cx++) {
        const i = cy * cells.columns + cx
        paintCell(rgb, px.w, (cx - b.x) * CELL_W, (cy - b.y) * CELL_H, cells.glyph[i]!, cells.fg[i]!, cells.bg[i]!)
      }
    }
    const full = this.#lastIdx ?? new Uint8Array(this.width * this.height)
    const idx = new Uint8Array(px.w * px.h)
    const first = this.#lastIdx === null
    for (let y = 0; y < px.h; y++) {
      for (let x = 0; x < px.w; x++) {
        const o = (y * px.w + x) * 3
        const colour = this.#palette.indexOf((rgb[o]! << 16) | (rgb[o + 1]! << 8) | rgb[o + 2]!)
        const at = (px.y + y) * this.width + px.x + x
        idx[y * px.w + x] = !first && full[at] === colour ? TRANSPARENT : colour
        full[at] = colour
      }
    }
    this.#lastIdx = full
    this.#last = { ...cells, glyph: cells.glyph.slice(), fg: cells.fg.slice(), bg: cells.bg.slice() }
    const lzw = lzwEncode(idx)
    this.#frames.push({ ...px, delayCs, transparent: !first, lzw })
    this.#bytes += 19 + lzw.length + Math.ceil(lzw.length / 255) + 2
  }

  finish(): Uint8Array {
    const out: number[] = []
    const u16 = (n: number) => out.push(n & 255, (n >> 8) & 255)
    out.push(...[0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
    u16(this.width)
    u16(this.height)
    out.push(0xf7, 0, 0)
    out.push(...this.#palette.table())
    out.push(0x21, 0xff, 0x0b, ...[...'NETSCAPE2.0'].map(c => c.charCodeAt(0)), 0x03, 0x01, 0x00, 0x00, 0x00)
    for (const f of this.#frames) {
      out.push(0x21, 0xf9, 0x04, (1 << 2) | (f.transparent ? 1 : 0))
      u16(f.delayCs)
      out.push(TRANSPARENT, 0x00, 0x2c)
      u16(f.x)
      u16(f.y)
      u16(f.w)
      u16(f.h)
      out.push(0x00, 8)
      for (let i = 0; i < f.lzw.length; i += 255) {
        const n = Math.min(255, f.lzw.length - i)
        out.push(n)
        for (let j = 0; j < n; j++) out.push(f.lzw[i + j]!)
      }
      out.push(0x00)
    }
    out.push(0x3b)
    return Uint8Array.from(out)
  }
}
```

Every pixel inside a changed box is re-indexed, so a first frame never uses index 0 (the palette starts at 1 for real colours); later frames mark unchanged pixels transparent. If `finish()`'s `number[]` proves slow on a 15 MB file in the cap test of Task 8, switch it to a growing `Uint8Array` with the same layout.

- [ ] **Step 6: Run the gate**

Run: `npm run typecheck && npm test && npm run test:mod`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add src/gif src/render/raster.ts scripts/preview.ts tests/gif tests/render/raster.test.ts
git commit -m "Add a GIF89a encoder and move the rasteriser out of the preview script"
```

---

### Task 7f: Real glyphs in the rasteriser (8×16 bitmap font)

The GIF is a showpiece, so text is drawn from a bitmap font, not soft bars. Blocks and braille stay exactly as Task 7 draws them; only the "any other glyph" branch changes. Runs after Task 7 (it edits `raster.ts`); Task 8 depends on it.

**Font: Spleen 8×16** by Frédéric Cambus, **BSD 2-Clause licence** (https://github.com/fcambus/spleen, file `spleen-8x16.bdf` from the latest tagged release). BSD-2 allows embedding in a closed product as long as the copyright notice and licence text go with it. The licence text is committed as `src/render/font/LICENSE-spleen.txt` (verbatim from the release's `LICENSE`), `src/render/font/README.md` names the font, its version and its URL, and the generated module's header comment repeats the copyright line. All three live under `src/`, which the plugin ships, so the notice travels with the code. If the release's licence is not BSD-2 when fetched, stop and report.

Glyphs Spleen lacks from the required set are drawn by hand in `src/render/font/extra.ts` (our own work, no licence question). They are reviewed by the designer as a PNG before commit.

**Required glyphs** (listed from the code at `4d03b82` plus §13; a test keeps the list complete):
- printable ASCII U+0020-U+007E;
- in `src/render/*.ts` today: `·` U+00B7, `–` U+2013, `•` U+2022, `…` U+2026, `›` U+203A, `↑` U+2191, `→` U+2192, `↓` U+2193, `≈` U+2248, `─` U+2500, `└` U+2514, `▶` U+25B6, `◆` U+25C6, `◉` U+25C9, `◌` U+25CC, `●` U+25CF, `⚠` U+26A0, `✓` U+2713, `✕` U+2715;
- added by §13: `×` U+00D7 (replay speed);
- also kept when Spleen has them: Latin-1 Supplement U+00A0-U+00FF (agent and swarm names).

Block elements U+2580-U+259F and braille U+2800-U+28FF are **not** font glyphs: they keep their exact geometric drawing. Note that Task 7's `paintCell` uses `blockShape`, which only knows single-rectangle blocks; this task switches it to `blockRects` (svg.ts) so the quadrant blocks U+2596-U+259F are exact too.

**Files:**
- Create: `scripts/build-font.ts` (dev only, Node allowed: BDF → TypeScript), `src/render/font/spleen8x16.ts` (generated, committed), `src/render/font/extra.ts`, `src/render/font/index.ts`, `src/render/font/LICENSE-spleen.txt`, `src/render/font/README.md`
- Modify: `src/render/raster.ts` (`paintCell`)
- Test: `tests/render/font.test.ts`

**Interfaces:**
- Consumes: Task 7 `paintCell`, `paintGrids`; `blockRects` (svg.ts).
- Produces:

```ts
// src/render/font/index.ts (pure, no Node)
export const FONT_W = 8
export const FONT_H = 16
/** The 16 row bytes of a glyph (bit 7 = leftmost pixel), or null when neither Spleen nor extra.ts has it. */
export function glyphRows(cp: number): Uint8Array | null
/** Every code point the renderer may emit that must have a glyph (the list above). */
export const REQUIRED: readonly number[]
```

The font modules are imported only by `raster.ts`, which only the server (`omnis_export`) and `scripts/preview.ts` import: nothing in `src/mod` reaches them, so the mod's load is unchanged. `tests/core/mod-safe.test.ts`-style rules still apply (pure, no Node) because `src/render/**` must stay pure.

- [ ] **Step 1: Write the failing test**

```ts
// tests/render/font.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { FONT_H, FONT_W, REQUIRED, glyphRows } from '../../src/render/font/index.ts'
import { paintCell } from '../../src/render/raster.ts'

const RENDER = join(import.meta.dirname, '..', '..', 'src', 'render')

test('every required glyph has 16 rows', () => {
  const missing = REQUIRED.filter(cp => glyphRows(cp)?.length !== FONT_H)
  assert.deepEqual(missing.map(cp => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`), [])
})

test('REQUIRED covers every non-ASCII character in the render code outside comments, bar blocks and braille', () => {
  const required = new Set(REQUIRED)
  const found = new Set<number>()
  for (const name of readdirSync(RENDER).filter(f => f.endsWith('.ts'))) {
    const code = readFileSync(join(RENDER, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    for (const ch of code) {
      const cp = ch.codePointAt(0)!
      if (cp > 0x7e && !(cp >= 0x2580 && cp <= 0x259f) && !(cp >= 0x2800 && cp <= 0x28ff)) found.add(cp)
    }
  }
  const gaps = [...found].filter(cp => !required.has(cp))
  assert.deepEqual(gaps.map(cp => String.fromCodePoint(cp)), [])
})

test('a letter is drawn from its bitmap, fg on bg, with no soft bar', () => {
  const rgb = new Uint8Array(FONT_W * FONT_H * 3)
  paintCell(rgb, FONT_W, 0, 0, 'A'.codePointAt(0)!, 0xffffff, 0x000000)
  const rows = glyphRows(0x41)!
  for (let y = 0; y < FONT_H; y++) {
    for (let x = 0; x < FONT_W; x++) {
      const on = (rows[y]! >> (7 - x)) & 1
      assert.equal(rgb[(y * FONT_W + x) * 3], on ? 255 : 0, `pixel ${x},${y}`)
    }
  }
})

test('a glyph the font lacks still gets the soft bar', () => {
  const rgb = new Uint8Array(FONT_W * FONT_H * 3)
  paintCell(rgb, FONT_W, 0, 0, 0x4e00, 0xffffff, 0x000000)
  assert.ok(rgb.some(v => v > 0) && rgb.some(v => v > 0 && v < 255), 'the 0.6 bar blends')
})

test('a quadrant block is exact, not a bar', () => {
  const rgb = new Uint8Array(FONT_W * FONT_H * 3)
  paintCell(rgb, FONT_W, 0, 0, 0x2598, 0xffffff, 0x000000)
  assert.equal(rgb[0], 255)
  assert.equal(rgb[((FONT_H - 1) * FONT_W + FONT_W - 1) * 3], 0)
})

test('the licence ships beside the font', () => {
  const licence = readFileSync(join(RENDER, 'font', 'LICENSE-spleen.txt'), 'utf8')
  assert.match(licence, /Redistribution and use in source and binary forms/)
  assert.match(readFileSync(join(RENDER, 'font', 'spleen8x16.ts'), 'utf8'), /Cambus/)
})
```

(`U+2598` is ▘, upper-left quadrant. If `import.meta.dirname` isn't available on the repo's Node, use `fileURLToPath(new URL('.', import.meta.url))` as `tests/core/mod-safe.test.ts` does.)

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/render/font.test.ts`
Expected: FAIL — `Cannot find module '../../src/render/font/index.ts'`.

- [ ] **Step 3: Fetch the font and write the converter**

Download `spleen-8x16.bdf` and `LICENSE` from the Spleen release into the scratchpad (not the repo). Copy `LICENSE` verbatim to `src/render/font/LICENSE-spleen.txt`. Then:

```ts
// scripts/build-font.ts — node scripts/build-font.ts <path/to/spleen-8x16.bdf>
// Writes src/render/font/spleen8x16.ts: the glyphs REQUIRED needs plus Latin-1, as one base64 string of 16-byte rows.
import { readFileSync, writeFileSync } from 'node:fs'
import { REQUIRED_SOURCE } from '../src/render/font/required.ts'

const bdf = readFileSync(process.argv[2] ?? '', 'utf8')
const wanted = new Set<number>([...REQUIRED_SOURCE])
for (let cp = 0xa0; cp <= 0xff; cp++) wanted.add(cp)
const copyright = /^COPYRIGHT "(.*)"$/m.exec(bdf)?.[1] ?? ''
const version = /^FONT_VERSION "(.*)"$/m.exec(bdf)?.[1] ?? ''
const glyphs = new Map<number, number[]>()
for (const block of bdf.split('STARTCHAR').slice(1)) {
  const cp = Number(/ENCODING (\d+)/.exec(block)?.[1] ?? -1)
  if (!wanted.has(cp)) continue
  const bbx = /BBX (\d+) (\d+) (-?\d+) (-?\d+)/.exec(block)
  if (bbx === null || bbx[1] !== '8' || bbx[2] !== '16') continue
  const rows = block.split('BITMAP')[1]!.split('ENDCHAR')[0]!.trim().split(/\s+/).map(h => parseInt(h, 16))
  if (rows.length === 16) glyphs.set(cp, rows)
}
const cps = [...glyphs.keys()].sort((a, b) => a - b)
const bytes = Buffer.from(cps.flatMap(cp => glyphs.get(cp)!))
writeFileSync('src/render/font/spleen8x16.ts', `/**
 * Spleen 8x16 ${version}, ${copyright}. BSD 2-Clause: see LICENSE-spleen.txt beside this file.
 * Generated by scripts/build-font.ts; do not edit. ${cps.length} glyphs, 16 bytes each (bit 7 = leftmost pixel).
 */
export const SPLEEN_CODEPOINTS: readonly number[] = [${cps.join(', ')}]
export const SPLEEN_ROWS = '${bytes.toString('base64')}'
`)
console.log(`${cps.length} glyphs; missing from Spleen: ${[...REQUIRED_SOURCE].filter(cp => !glyphs.has(cp)).map(cp => `U+${cp.toString(16)}`).join(' ') || 'none'}`)
```

`src/render/font/required.ts` (pure) holds the required list so the script and `index.ts` share it:

```ts
/** The code points the renderer emits that must have a glyph (Task 7f); a test keeps this complete against the code. */
const ascii = Array.from({ length: 0x7f - 0x20 }, (_, i) => 0x20 + i)
export const REQUIRED_SOURCE: readonly number[] = [
  ...ascii,
  0x00b7, 0x00d7, 0x2013, 0x2022, 0x2026, 0x203a, 0x2191, 0x2192, 0x2193, 0x2248,
  0x2500, 0x2514, 0x25b6, 0x25c6, 0x25c9, 0x25cc, 0x25cf, 0x26a0, 0x2713, 0x2715,
]
```

Run: `node scripts/build-font.ts <scratchpad>/spleen-8x16.bdf`. It prints the glyphs Spleen lacks. Expect some of `◉ ◌ ⚠ ✓ ✕ ▶ ◆` to be missing; whatever it prints goes into Step 4.

- [ ] **Step 4: Draw the missing glyphs and write the lookup**

```ts
// src/render/font/extra.ts
/**
 * Our own 8x16 drawings of the glyphs Spleen lacks (Task 7f), in Spleen's weight: '#' on, '.' off, 16 rows of 8.
 * Reviewed by the designer as a PNG. Only the glyphs build-font.ts reported missing belong here.
 */
export const EXTRA: Readonly<Record<number, readonly string[]>> = {
  // ✓ U+2713
  0x2713: [
    '........', '........', '........', '........', '.......#', '......##', '.....##.', '#...##..',
    '##.##...', '.###....', '..#.....', '........', '........', '........', '........', '........',
  ],
}
```

Add one entry per glyph the converter reported, each drawn to sit on Spleen's baseline (row 12) and cap height (row 3) like its neighbours; a drawing of a glyph Spleen has is a review failure.

```ts
// src/render/font/index.ts
/** The 8x16 bitmap font the rasteriser draws text with: Spleen (BSD 2-Clause) plus our extra.ts. Pure, no Node. */
import { EXTRA } from './extra.ts'
import { REQUIRED_SOURCE } from './required.ts'
import { SPLEEN_CODEPOINTS, SPLEEN_ROWS } from './spleen8x16.ts'

export const FONT_W = 8
export const FONT_H = 16
export const REQUIRED = REQUIRED_SOURCE

let table: Map<number, Uint8Array> | null = null

function build(): Map<number, Uint8Array> {
  const bytes = Uint8Array.from(atob(SPLEEN_ROWS), c => c.charCodeAt(0))
  const out = new Map<number, Uint8Array>()
  SPLEEN_CODEPOINTS.forEach((cp, i) => out.set(cp, bytes.subarray(i * FONT_H, (i + 1) * FONT_H)))
  for (const [key, art] of Object.entries(EXTRA)) {
    out.set(Number(key), Uint8Array.from(art, row => [...row].reduce((n, c, x) => n | (c === '#' ? 0x80 >> x : 0), 0)))
  }
  return out
}

export function glyphRows(cp: number): Uint8Array | null {
  table ??= build()
  return table.get(cp) ?? null
}
```

`atob` is a web API the mod-safe rules allow. `src/render/font/README.md`: one paragraph naming Spleen 8x16, its version (from the generated header), the release URL, BSD 2-Clause, and that `extra.ts` is ours.

- [ ] **Step 5: Draw text from the font**

In `raster.ts`'s `paintCell`, keep the order: background; then `blockRects(code)` (every rectangle of the block, at its opacity) for U+2580-U+259F; then braille dots; then, for any other non-space glyph, `glyphRows(code)`: each set bit is a 1×1 pixel of `fg` (no blending), and only when that returns null the old 0.6 soft bar. `fg === DEFAULT` still reads `0xc9d1d9`.

- [ ] **Step 6: Run the gate and check the picture**

Run: `npm run typecheck && npm test && npm run test:mod && node scripts/preview.ts .superpowers/preview-check`
Expected: green. The preview PNGs now show real text (they are development pictures, not goldens; the text goldens don't change). Send the designer the PNGs plus one sheet of every `REQUIRED` glyph drawn by a scratch script, for the weight and baseline check of `extra.ts`.

- [ ] **Step 7: Commit**

```bash
git add scripts/build-font.ts src/render/font src/render/raster.ts tests/render/font.test.ts
git commit -m "Draw real text in the rasterised frames with the Spleen 8x16 font"
```

---

### Task 8: omnis_export renders a swarm to a GIF, with the summary card

**Follows `docs/design/pane.md` §13.4**, with Rob's correction: the card's duration is the swarm's wall-clock duration and row 12's "X of work in Y s" uses that same value for X. Runs after Task 6 (it adds the wordmark to the replay header Task 6 draws), Task 7 and Task 7f (real glyphs: the card and header text must be legible).

**Files:**
- Create: `src/mcp/tools/export.ts`, `src/render/card.ts`
- Modify: `src/render/header.ts`, `src/render/frame.ts` (`Notes.wordmark`), `src/mcp/protocol.ts` (promise handlers), `src/mcp/registry.ts`, `tests/e2e/mcp-server.test.ts` (tool list), `src/mod/guard.test.ts` (the export tool is refused)
- Test: `tests/mcp/export.test.ts`, `tests/mcp/protocol-async.test.ts`, `tests/render/card.test.ts`, golden `tests/render/golden/summary-card.txt`

**Interfaces:**
- Consumes: `retime`, `fitSpeed` (Task 5), `GifWriter`, `cellsOf` (Task 7), `render`, `Notes.replay`, `fmtClock` (Task 6), `planRegions`, `chooseSpotlight`, `markPulses`, `pulsesFrom`, `prunePulses`, `swarmTotals`, `ACCENT`, `TEXT`, `STATUS`, `MODEL`, `CANVAS`, `CANVAS_RAISED`, `EXPORT_TOOL`.
- Produces:
  - `protocol.ts`: `ToolDef.handler: (args: Args) => ToolResult | Promise<ToolResult>`; `handleMessage` returns `RpcReply | null | Promise<RpcReply | null>`.
  - `frame.ts`: `Notes.wordmark?: true` — `OmnisSwarm` right-aligned at the end of row 0 (`Omnis` `ACCENT`, `Swarm` `TEXT.primary`), the gaps marker moved to its left (§13.4).
  - `card.ts`:
    - `swarmDurationMs(state: SwarmState): number` — `(state.swarm.endedAt ?? state.lastAt) - state.swarm.startedAt`, 0 when unknown: **the one duration figure** the card shows twice.
    - `type CardInfo = { durationMs: number; clipMs: number; endedAt: number | null }` (`clipMs` = the replay part's length, the "in Y s").
    - `cardRect(graph: Rect): Rect` — 60×14 centred in the graph region (columns 30-89, rows 7-20 at the full step).
    - `drawCard(top: Grid, graph: Rect, state: SwarmState, totals: SwarmTotals, info: CardInfo, k: number): void` — dims every graph cell outside the card 0.5·k toward `CANVAS` and draws the card mixed k over the dimmed graph (k = 1/3, 2/3, 1 for the fade-in).
  - `export.ts`: `createExportTools(ctx: ToolContext): ToolDef[]`, `renderGif(events: SwarmEvent[], swarm: string, style: 'globe' | 'robot', limits?: { maxFrames: number; maxBytes: number }, yieldEvery?: () => Promise<void>): Promise<{ gif: Uint8Array; speed: number; frames: number }>`, constants `GIF_COLUMNS = 120`, `GIF_ROWS = 44`, `GIF_FPS = 10`, `REPLAY_TARGET_MS = 27_000`, `CARD_MS = 3_000`, `MAX_FRAMES = 600`, `MAX_BYTES = 15 * 1024 * 1024`.

- [ ] **Step 1: Write the failing protocol test**

```ts
// tests/mcp/protocol-async.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { runStdio, type ToolDef } from '../../src/mcp/protocol.ts'

test('a promise handler is answered, and a quick call made meanwhile is answered first', async () => {
  let release: () => void = () => {}
  const slow: ToolDef = { name: 'slow', description: '', inputSchema: { type: 'object' }, handler: () => new Promise(r => { release = () => r({ text: 'slow done' }) }) }
  const quick: ToolDef = { name: 'quick', description: '', inputSchema: { type: 'object' }, handler: () => ({ text: 'quick done' }) }
  const input = new PassThrough()
  const output = new PassThrough()
  const lines: string[] = []
  output.on('data', d => lines.push(...String(d).split('\n').filter(Boolean)))
  const done = runStdio([slow, quick], { name: 't', version: '0' }, input, output)
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'slow', arguments: {} } })}\n`)
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'quick', arguments: {} } })}\n`)
  await new Promise(r => setImmediate(r))
  release()
  await new Promise(r => setImmediate(r))
  input.end()
  await done
  assert.deepEqual(lines.map(l => JSON.parse(l).id), [2, 1])
  assert.equal(JSON.parse(lines[1]!).result.content[0].text, 'slow done')
})

test('a promise handler that rejects is an error result', async () => {
  const bad: ToolDef = { name: 'bad', description: '', inputSchema: { type: 'object' }, handler: () => Promise.reject(new Error('nope')) }
  const input = new PassThrough()
  const output = new PassThrough()
  const lines: string[] = []
  output.on('data', d => lines.push(...String(d).split('\n').filter(Boolean)))
  const done = runStdio([bad], { name: 't', version: '0' }, input, output)
  input.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bad', arguments: {} } })}\n`)
  await new Promise(r => setImmediate(r))
  await done
  assert.equal(JSON.parse(lines[0]!).result.isError, true)
})
```

Delete the existing protocol test that expects `'Tool handlers must be synchronous'` (in `tests/mcp/protocol.test.ts`).

- [ ] **Step 2: Write the failing export and card tests**

```ts
// tests/mcp/export.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendEvent } from '../../src/core/log.ts'
import { createExportTools, renderGif, MAX_FRAMES } from '../../src/mcp/tools/export.ts'
import { Session } from '../../src/mcp/session.ts'
import { fiveAgentEvents, FIVE_SWARM } from '../fixtures/swarm-five.ts'
import { decodeGif } from '../gif/decode.ts'
import { tmpRoot } from '../helpers.ts'

const NOW = new Date('2026-10-22T14:05:00.000Z')

test('omnis_export writes .omnis-swarm/exports/<swarm>-<yyyymmdd-hhmm>.gif and answers its path', async () => {
  const root = tmpRoot()
  for (const e of fiveAgentEvents()) appendEvent(root, e)
  const tool = createExportTools({ root, session: new Session(root), now: () => NOW })[0]!
  const out = await tool.handler({ swarm: FIVE_SWARM, style: 'robot' })
  const rel = `.omnis-swarm/exports/${FIVE_SWARM}-20261022-1405.gif`
  assert.match(out.text, new RegExp(rel.replace(/\./g, '\\.')))
  const gif = decodeGif(new Uint8Array(readFileSync(join(root, rel))))
  assert.equal(gif.width, 960)
  assert.equal(gif.height, 704)
  const total = gif.frames.reduce((n, f) => n + f.delayCs, 0)
  assert.ok(total >= 300 && total <= 3_000, `clip lasts ${total} cs`)
  assert.ok(gif.frames.at(-1)!.delayCs >= 270, 'ends on the held card (3 fade frames, then 2.7 s)')
})

test('the frame cap raises the speed instead of growing the file', async () => {
  const out = await renderGif(fiveAgentEvents(), FIVE_SWARM, 'globe', { maxFrames: 40, maxBytes: 15 * 1024 * 1024 })
  assert.ok(out.frames <= 40)
  assert.ok(MAX_FRAMES === 600)
})

test('the size cap that cannot be met is an error, not a file', async () => {
  await assert.rejects(renderGif(fiveAgentEvents(), FIVE_SWARM, 'globe', { maxFrames: 600, maxBytes: 1_000 }), /too large/)
})

test('a bad swarm or style is refused; an unknown swarm writes nothing', async () => {
  const root = tmpRoot()
  const tool = createExportTools({ root, session: new Session(root), now: () => NOW })[0]!
  await assert.rejects(async () => tool.handler({ swarm: '../x', style: 'globe' }), { name: 'InputError' })
  await assert.rejects(async () => tool.handler({ swarm: 'ok', style: 'neon' }), { name: 'InputError' })
  await assert.rejects(async () => tool.handler({ swarm: 'absent', style: 'globe' }), { name: 'InputError' })
  assert.equal(existsSync(join(root, '.omnis-swarm', 'exports')), false)
})
```

```ts
// tests/render/card.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { foldAll } from '../../src/core/fold.ts'
import { swarmTotals } from '../../src/core/stats.ts'
import { cardRect, drawCard, swarmDurationMs } from '../../src/render/card.ts'
import { render } from '../../src/render/frame.ts'
import { gridText } from '../../src/render/grid.ts'
import { fmtClock } from '../../src/render/header.ts'
import { planRegions } from '../../src/render/regions.ts'
import { emptyView } from '../../src/render/types.ts'
import { fiveAgentEvents, FIVE_SWARM, FIVE_AT } from '../fixtures/swarm-five.ts'

const state = foldAll(FIVE_SWARM, fiveAgentEvents())
const size = { columns: 120, rows: 44 }

test('the card sits at columns 30-89, rows 7-20 at the full step', () => {
  const graph = planRegions(size).graph!
  assert.deepEqual(cardRect(graph), { x: 30, y: 7, w: 60, h: 14 })
})

test('duration is the wall-clock figure, the same value on the figure row and in "of work"', () => {
  const ms = swarmDurationMs(state)
  assert.equal(ms, (state.swarm.endedAt ?? state.lastAt) - state.swarm.startedAt!)
  const top = render(state, emptyView(), FIVE_AT.end, size).top
  drawCard(top, planRegions(size).graph!, state, swarmTotals(state, FIVE_AT.end), { durationMs: ms, clipMs: 24_000, endedAt: state.swarm.endedAt }, 1)
  const text = gridText(top).join('\n')
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.floor((ms % 60_000) / 1000)
  assert.match(text, new RegExp(`${minutes}m ${String(seconds).padStart(2, '0')}s`))
  assert.match(text, new RegExp(`${fmtClock(ms)} of work in 24 s`))
})

test('the summary card matches its golden', () => {
  const top = render(state, emptyView(), FIVE_AT.end, size).top
  drawCard(top, planRegions(size).graph!, state, swarmTotals(state, FIVE_AT.end), { durationMs: swarmDurationMs(state), clipMs: 24_000, endedAt: state.swarm.endedAt }, 1)
  const golden = readFileSync(new URL('./golden/summary-card.txt', import.meta.url), 'utf8')
  assert.equal(gridText(top).join('\n') + '\n', golden)
})

test('the fade dims the graph by half of k and leaves the bottom grid alone', () => {
  const plain = render(state, emptyView(), FIVE_AT.end, size)
  const faded = render(state, emptyView(), FIVE_AT.end, size)
  drawCard(faded.top, planRegions(size).graph!, state, swarmTotals(state, FIVE_AT.end), { durationMs: 1, clipMs: 1, endedAt: null }, 1 / 3)
  assert.notEqual(faded.top.bg(5, 10), plain.top.bg(5, 10))
  assert.deepEqual(gridText(faded.bottom!), gridText(plain.bottom!))
})
```

If `FIVE_AT` has no `end`, use the fixture's last event time (`state.lastAt`). If `planRegions` names the graph area differently, use its name; the card test pins only the resulting rectangle.

Write the golden from the first run after the card matches §13, then have the designer check its PNG (`paintGrids([grid])` through `png()` in a scratch script) before committing it. It is a new golden; no existing golden changes.

- [ ] **Step 3: Run them to verify they fail**

Run: `node --test tests/mcp/protocol-async.test.ts tests/mcp/export.test.ts tests/render/card.test.ts`
Expected: FAIL.

- [ ] **Step 4: Let the protocol await promise handlers**

In `handleMessage`'s `tools/call` branch:

```ts
      const finish = (result: unknown): RpcReply =>
        !isObj(result) || typeof result.text !== 'string'
          ? fail('Tool returned no text')
          : rpcResult(id, { content: [{ type: 'text', text: result.text }], isError: result.isError === true })
      const failWith = (err: unknown): RpcReply => fail(err instanceof Error ? err.message : typeof err === 'string' ? err : 'Tool failed')
      try {
        const result: unknown = tool.handler(args)
        if (isObj(result) && typeof result.then === 'function') return (result as unknown as Promise<unknown>).then(finish, failWith)
        return finish(result)
      } catch (err) {
        return failWith(err)
      }
```

Return type `RpcReply | null | Promise<RpcReply | null>`. In `runStdio.processLine`:

```ts
      try {
        const reply = handleMessage(msg, tools, info)
        if (reply instanceof Promise) reply.then(r => r !== null && send(r), () => send(rpcError(idOf(msg), -32603, 'Internal error')))
        else if (reply !== null) send(reply)
      } catch {
        send(rpcError(idOf(msg), -32603, 'Internal error'))
      }
```

The `finished` flag in `send` already drops a reply that settles after the input ended. `ToolDef.handler` becomes `(args: Args) => ToolResult | Promise<ToolResult>`; the `tools.ts`/`record.ts` wrappers that call `tool.handler(args)` and return its value type-check unchanged.

- [ ] **Step 5: Write the card**

`src/render/card.ts`, per §13.4: `cardRect` centres 60×14 in the graph region. `drawCard` first mixes every graph cell outside the card 0.5·k toward `CANVAS` (fg and bg), then draws the card into a scratch 60×14 grid and mixes each of its cells k over the dimmed cell beneath. Card content (card-relative; background `CANVAS_RAISED`; row 0 is `▀` in `ACCENT` over `CANVAS_RAISED`):

- rows 1-3, columns 3-10: the 8×6-pixel mark from §13.4 (keys `O` `MODEL.opus`, `S` `MODEL.sonnet`, `F` `MODEL.fable`, `A` `ACCENT`), drawn as half-blocks;
- row 1 col 13 `Omnis` `ACCENT` + `Swarm` `TEXT.primary`; row 2 col 13 `swarm replay` `TEXT.dim`;
- row 5 col 3: name `TEXT.primary` · topology `TEXT.dim` · `ended HH:MM` `TEXT.dim` (left out when the swarm never ended), separators `TEXT.faint`;
- rows 7/8, columns 3, 17, 31, 45: agents (non-placeholder, non-lead count), duration `fmtDur(info.durationMs)` (`12m 40s`, `1h 05m` past an hour), cost `fmtUsd(totals.costUsd)` + `+` when partial, messages (Σ `links[].count`), each figure `TEXT.primary` over its label `TEXT.dim`;
- row 10: `✓ n done   ✕ n failed   ◌ n waiting`, zero statuses left out, glyphs in their status colours, words `TEXT.dim`;
- row 11: `● opus n   ● sonnet n …` by answered model family, dots in the model colour;
- row 12: `YYYY-MM-DD · ${fmtClock(info.durationMs)} of work in ${Math.round(info.clipMs / 1000)} s` `TEXT.dim`.

Both duration figures come from `info.durationMs`, which the export sets to `swarmDurationMs(state)`; nothing on the card is computed from the clip's frames. All text goes through `writeParts` and is clipped to the card; a 4-digit cost must still fit (§13.7).

`header.ts` / `frame.ts`: `Notes.wordmark` draws `OmnisSwarm` right-aligned at the end of row 0 with the gaps marker to its left; never set in the pane.

- [ ] **Step 6: Write the export tool**

```ts
// src/mcp/tools/export.ts
/**
 * omnis_export (spec section 4): renders a recorded swarm to a looping GIF in .omnis-swarm/exports and answers its
 * path. Internal (the mod's guard refuses the model). Async: it yields every few frames so the recorder and the pane
 * keep being answered while it renders.
 */
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isValidSwarmId, type SwarmEvent } from '../../core/events.ts'
import { emptyState, fold } from '../../core/fold.ts'
import { isLink, logPaths, readEvents, swarmLogPath } from '../../core/log.ts'
import { EXPORT_TOOL } from '../../core/recording.ts'
import { fitSpeed, logTimeAt, retime } from '../../core/replay-clock.ts'
import { swarmTotals } from '../../core/stats.ts'
import { GifWriter } from '../../gif/encode.ts'
import { drawCard, swarmDurationMs } from '../../render/card.ts'
import { planRegions } from '../../render/regions.ts'
import { render } from '../../render/frame.ts'
import { cellsOf } from '../../render/raster.ts'
import { chooseSpotlight } from '../../render/spotlight.ts'
import { CELL_H, CELL_W } from '../../render/svg.ts'
import type { Spot, Tween } from '../../render/types.ts'
import { markPulses, prunePulses, pulsesFrom } from '../../mod/pane-model.ts'
import type { Args, ToolDef, ToolResult } from '../protocol.ts'
import type { ToolContext } from '../tools.ts'
import { InputError, reqEnum, reqString } from '../validate.ts'

export const GIF_COLUMNS = 120
export const GIF_ROWS = 44
export const GIF_FPS = 10
export const REPLAY_TARGET_MS = 27_000
export const CARD_MS = 3_000
export const MAX_FRAMES = 600
export const MAX_BYTES = 15 * 1024 * 1024
const MIN_SPEED = 1
const TRIES = 4
const MAX_EVENTS = 200_000
const STYLES = ['globe', 'robot'] as const
const FAILED = 'Could not export the swarm (see the server log).'
const nextTick = (): Promise<void> => new Promise(r => setImmediate(r))

/** Every event in the swarm's log, page by page (readEvents reads at most 1 MB a call). */
function allEvents(file: string): SwarmEvent[] {
  const out: SwarmEvent[] = []
  let offset = 0
  for (;;) {
    const read = readEvents(file, offset)
    out.push(...read.events)
    if (read.offset === offset || out.length > MAX_EVENTS) return out
    offset = read.offset
  }
}

async function encodeAt(events: readonly SwarmEvent[], swarm: string, style: 'globe' | 'robot', speed: number, caps: { maxFrames: number; maxBytes: number }, pause: () => Promise<void>): Promise<{ gif: Uint8Array; frames: number } | 'over'> {
  const size = { columns: GIF_COLUMNS, rows: GIF_ROWS }
  const startMs = Date.parse(events[0]!.ts)
  const timed = retime(events, speed, startMs)
  const endMs = startMs + (timed.offsets.at(-1) ?? 0)
  const writer = new GifWriter(GIF_COLUMNS * CELL_W, GIF_ROWS * CELL_H)
  const state = emptyState(swarm)
  let pulses: ReturnType<typeof prunePulses> = []
  let last: Record<string, number> = {}
  let spot: Spot | null = null
  let tween: Tween | null = null
  let prevKey: string | null = null
  let prevPositions: Record<string, { x: number; y: number }> = {}
  let cursor = 0
  const step = 1000 / GIF_FPS
  for (let now = startMs, n = 0; now <= endMs + step; now += step, n++) {
    const due: SwarmEvent[] = []
    while (cursor < timed.events.length && Date.parse(timed.events[cursor]!.ts) <= now) due.push(timed.events[cursor++]!)
    for (const e of due) fold(state, e)
    const marked = markPulses(pulsesFrom(due), last)
    last = marked.lastFlicker
    pulses = prunePulses([...pulses, ...marked.pulses], now)
    spot = chooseSpotlight(spot, null, state, pulses, now)
    const clockMs = logTimeAt(timed.logTs, timed.offsets, now - startMs) - (timed.logTs[0] ?? 0)
    const replay = { speed, clockMs, totalMs: (timed.logTs.at(-1) ?? 0) - (timed.logTs[0] ?? 0), ended: now >= endMs }
    const frame = render(state, { pinned: null, spotlight: spot, pulses, lagMs: 0, tween, style }, now, size, { replay, wordmark: true })
    if (prevKey !== null && frame.nodesKey !== prevKey) tween = { from: prevPositions, at: now }
    prevKey = frame.nodesKey
    prevPositions = frame.positions
    writer.add(cellsOf([frame.top, frame.bottom], GIF_COLUMNS, GIF_ROWS), Math.round(100 / GIF_FPS))
    if (writer.frames > caps.maxFrames || writer.bytes > caps.maxBytes) return 'over'
    if (n % 10 === 9) await pause()
  }
  // The card (§13.4): over the final frame, 3 fade frames at 10 fps, then held for the rest of CARD_MS.
  const totals = swarmTotals(state, endMs)
  const info = { durationMs: swarmDurationMs(state), clipMs: endMs - startMs, endedAt: state.swarm.endedAt }
  const graph = planRegions(size).graph!
  const finalNotes = { replay: { speed, clockMs: info.durationMs, totalMs: info.durationMs, ended: true }, wordmark: true as const }
  for (const [i, k] of [1 / 3, 2 / 3, 1].entries()) {
    const last = render(state, { pinned: null, spotlight: spot, pulses: [], lagMs: 0, tween: null, style, still: true }, endMs, size, finalNotes)
    drawCard(last.top, graph, state, totals, info, k)
    writer.add(cellsOf([last.top, last.bottom], GIF_COLUMNS, GIF_ROWS), i < 2 ? 10 : CARD_MS / 10 - 20)
  }
  const gif = writer.finish()
  return writer.frames > caps.maxFrames || gif.length > caps.maxBytes ? 'over' : { gif, frames: writer.frames }
}

export async function renderGif(events: SwarmEvent[], swarm: string, style: 'globe' | 'robot', caps = { maxFrames: MAX_FRAMES, maxBytes: MAX_BYTES }, pause: () => Promise<void> = nextTick): Promise<{ gif: Uint8Array; speed: number; frames: number }> {
  if (events.length === 0) throw new InputError('That swarm has no events to export.')
  // Whole speeds only: the GIF header says ` REPLAY 24× ` (§13.4).
  let speed = Math.ceil(fitSpeed(events.map(e => Date.parse(e.ts)).sort((a, b) => a - b), REPLAY_TARGET_MS, MIN_SPEED))
  for (let t = 0; t < TRIES; t++) {
    const out = await encodeAt(events, swarm, style, speed, caps, pause)
    if (out !== 'over') return { ...out, speed }
    speed = Math.ceil(speed * 1.5)
  }
  throw new InputError('The GIF would be too large even sped up; nothing was written.')
}

const stamp = (d: Date): string => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13)

export function createExportTools(ctx: ToolContext): ToolDef[] {
  const { root } = ctx
  const clock = ctx.now ?? (() => new Date())
  const tool: ToolDef = {
    name: EXPORT_TOOL,
    description: 'Internal to the OmnisSwarm plugin: renders a recorded swarm to a GIF for /omnis export gif. When the OmnisSwarm mod is loaded it refuses calls from the model.',
    inputSchema: {
      type: 'object',
      properties: {
        swarm: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,63}$' },
        style: { type: 'string', enum: [...STYLES] },
      },
      required: ['swarm', 'style'],
      additionalProperties: false,
    },
    handler: async (args: Args): Promise<ToolResult> => {
      const swarm = reqString(args, 'swarm', 64)
      if (!isValidSwarmId(swarm)) throw new InputError('swarm is not a valid swarm id')
      const style = reqEnum(args, 'style', STYLES)
      const file = swarmLogPath(root, swarm)
      if (!existsSync(file)) throw new InputError(`No swarm ${swarm} here.`)
      try {
        const { gif, speed } = await renderGif(allEvents(file), swarm, style)
        const dir = join(logPaths(root).dir, 'exports')
        if (isLink(dir)) throw new Error('refusing a link for the exports folder')
        mkdirSync(dir, { recursive: true })
        const name = `${swarm}-${stamp(clock())}.gif`
        const target = join(dir, name)
        if (isLink(target)) throw new Error('refusing a link for the export')
        const temp = `${target}.${process.pid}.tmp`
        rmSync(temp, { force: true })
        writeFileSync(temp, gif, { flag: 'wx' })
        renameSync(temp, target)
        return { text: `GIF written to .omnis-swarm/exports/${name} (${Math.round(gif.length / 1024)} KB, ${speed < 10 ? speed.toFixed(1) : Math.round(speed)}× speed).` }
      } catch (err) {
        if (err instanceof InputError) throw err
        process.stderr.write(`omnis: omnis_export failed: ${err instanceof Error ? err.message : String(err)}\n`)
        throw new Error(FAILED)
      }
    },
  }
  return [tool]
}
```

`src/mcp/tools/export.ts` imports `src/mod/pane-model.ts` (mod-safe and Node-free, so the server may import it; if the reviewer prefers, move `markPulses`/`prunePulses`/`pulsesFrom` into `src/render/pulses.ts` in this task and re-export them from `pane-model.ts`). `registry.ts`: add `createExportTools`. `tests/e2e/mcp-server.test.ts`: add `omnis_export` to the tool list. `src/mod/guard.test.ts`: add `...__omnis_export` to the refused names.

- [ ] **Step 7: Run the gate**

Run: `npm run typecheck && npm test && npm run test:mod && git diff --stat tests/render/golden`
Add to `tests/render/card.test.ts`: rasterise the card frame with `paintGrids` and check that the cells of `Omnis` on card row 1 match `glyphRows` bit for bit (fg where a bit is set, background elsewhere), so the card is real text, not bars.

Expected: green; the only golden change is the new `summary-card.txt`. Send the designer a PNG of the card frame (scratch script through `paintGrids`) for §13.7's card check before committing the golden. Time `node --test tests/mcp/export.test.ts`; if the five-agent export takes over 20 s, profile `paintCell` before anything else.

- [ ] **Step 8: Commit**

```bash
git add src/mcp src/render/card.ts src/render/header.ts src/render/frame.ts tests/mcp tests/render/card.test.ts tests/render/golden/summary-card.txt tests/e2e/mcp-server.test.ts src/mod/guard.test.ts
git commit -m "Export a recorded swarm as a looping GIF with a summary card"
```

---

### Task 9: /omnis export gif

**Files:**
- Modify: `src/mod/export-command.ts`, `src/mod/commands.test.ts` (description, hint, usage)
- Test: `src/mod/export-command.test.ts` (kit)

**Interfaces:**
- Consumes: `Sub` (Task 0), `EXPORT_TOOL` (Task 1), `styleAtom`, `styleOf`, `rt`, `hostOf` (Task 0), `replayOffsets`-free: the server picks the speed.
- Produces: `exportSub: Sub` with name `export`.

- [ ] **Step 1: Write the failing kit test**

```ts
// src/mod/export-command.test.ts
import { expect, mock, test } from 'claude-code/testing'
import { registerPane } from './pane.ts'
import { engine, RUN, settle } from './test-engine.ts'

const LOADED = { timeoutMs: 60000 }

test('/omnis export gif answers at once and toasts the path when the server is done', LOADED, async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-22T14:05:00.000Z') })
  const seen = engine(on)
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  registerPane(on, { panel: 'command' })
  await $.session.start({ cwd: '/p', surface: null, isInteractive: true })
  expect((await $.command.run({ command: 'omnis', args: 'export gif alpha', ...RUN })).text).toBe('Rendering alpha to a GIF; the path follows when it is done.')
  await settle()
  const call = seen.calls.find(c => c.tool === 'omnis_export')!
  expect(call.args).toEqual({ swarm: 'alpha', style: 'globe' })
  expect(toasts.length).toBe(1)
})

test('/omnis export with anything but gif answers the usage', LOADED, async ($, on) => {
  engine(on)
  registerPane(on, { panel: 'command' })
  await $.session.start({ cwd: '/p', surface: null, isInteractive: true })
  expect((await $.command.run({ command: 'omnis', args: 'export png', ...RUN })).text).toBe('Usage: /omnis export gif [swarm].')
})
```

The stub engine answers any non-feed call with `{}` text, so the toast is `'{}'`-based; assert only that one toast came. For the default swarm, the command asks `omnis_replay` with `since: 0` for the most recent id first (it answers `kind: 'none'` → "No recorded swarm here yet.").

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:mod`
Expected: FAIL — `exportSub` is null.

- [ ] **Step 3: Implement**

```ts
// src/mod/export-command.ts
/** /omnis export gif [swarm] (spec section 4): asks the server for a GIF and toasts its path when it is written. */
import { EXPORT_TOOL, REPLAY_TOOL } from '../core/recording.ts'
import { isValidSwarmId } from '../core/events.ts'
import { read } from 'claude-code'
import { parseReplayReply } from '../core/replay-reply.ts'
import type { Sub } from './commands.ts'
import { hostOf, rt, styleAtom, styleOf } from './pane-runtime.ts'

const USAGE = 'Usage: /omnis export gif [swarm].'
const TOAST_MS = 12_000

const textOf = (result: { content: ReadonlyArray<{ type: string; text?: unknown }>; isError?: boolean }): string => {
  const block = result.content[0]
  return block !== undefined && block.type === 'text' && typeof block.text === 'string' ? block.text.slice(0, 300) : ''
}

export const exportSub: Sub | null = {
  name: 'export',
  describe: '/omnis export gif [swarm] saves a GIF of a swarm',
  hint: 'export gif [swarm]',
  usage: USAGE,
  run: async ($, words) => {
    if (words[1] !== 'gif' || words.length > 3 || (words[2] !== undefined && !isValidSwarmId(words[2]))) return USAGE
    const host = rt.host ?? hostOf($)
    const server = rt.server ?? (await host.connect().catch(() => null))
    if (server === null) return 'The swarm server is not connected yet; try again in a moment.'
    let swarm = words[2] ?? null
    if (swarm === null) {
      const probe = parseReplayReply(textOf(await host.call(server, REPLAY_TOOL, { since: 0 })))
      if (probe === null || probe.kind === 'none') return 'No recorded swarm here yet.'
      swarm = probe.swarm
    }
    const style = styleOf(await read($, styleAtom).catch(() => null))
    const name = swarm
    // Not awaited: the render takes seconds, and the answer comes as a toast.
    void host.call(server, EXPORT_TOOL, { swarm: name, style }).then(
      result => $.ui.toast(result.isError ? `GIF export failed: ${textOf(result)}` : textOf(result), { timeoutMs: TOAST_MS }),
      () => $.ui.toast('GIF export failed: the server did not answer.', { timeoutMs: TOAST_MS }),
    ).catch(() => undefined)
    return `Rendering ${name} to a GIF; the path follows when it is done.`
  },
}
```

- [ ] **Step 4: Run the gate**

Run: `npm run typecheck && npm test && npm run test:mod`
Expected: green after updating `commands.test.ts` for the export parts.

- [ ] **Step 5: Commit**

```bash
git add src/mod/export-command.ts src/mod/export-command.test.ts src/mod/commands.test.ts
git commit -m "Add /omnis export gif"
```

---

### Task 10: Model badge (requested → answered)

**Follows `docs/design/pane.md` §13.5.** **Starts with a live probe. If the probe shows `usage.model` does not carry the model the gateway answered with, stop, write the finding to `.superpowers/sdd/p3b-task-10-report.md`, and report BLOCKED. Build nothing.**

**Files:**
- Modify: `src/core/events.ts` (`agent.usage.requested?`), `src/core/fold.ts` (`AgentState.requested`, `AgentState.routedDeltaUsd`), `src/core/state-check.ts`, `src/mod/record-events.ts` (`agentUsage(usage, agent, requested)`), `src/mod/recorder.ts` (`turn.step` passes `e.model`), `src/mcp/tools/record.ts`, `src/core/stats.ts` (`AgentStats.requested`, `routedDeltaUsd`), `src/render/spotlight.ts` (rows 0 and 1, compact), `src/render/graph.ts` (label mark), `src/render/tree.ts` (name mark), `src/render/tokens.ts` (`GLYPH.cheaper`/`dearer` if not already there)
- Test: `tests/core/fold-routed.test.ts`, `tests/render/spotlight-routed.test.ts`, one case each in `tests/mod/record-events.test.ts` and `tests/mcp/record.test.ts`

**Interfaces:**
- Produces: `AgentState.requested: string | null`; `AgentState.routedDeltaUsd: number` (signed: Σ over usage events where both models are priced and differ of `costOf(requested) − costOf(model)`; positive = saved); `AgentStats.requested`, `AgentStats.routedDeltaUsd`; `agentUsage(rawUsage: StepUsage, agent: string, requested?: unknown)`; `routedFamilies(s: AgentStats): { asked: string; answered: string } | null` in `spotlight.ts` (null when either is missing or the families match: §13.5 "same family: no badge").

- [ ] **Step 1: Run the live probe (needs Rob or a running OmnisRouter)**

Write `probe-router.ts` in the scratchpad (not the repo):

```ts
// <scratchpad>/probe-router.ts — node probe-router.ts ; then ANTHROPIC_BASE_URL=http://127.0.0.1:8789 claude
import { createServer, request } from 'node:http'
const upstream = new URL(process.env.OMNIS_ROUTER_URL ?? 'http://127.0.0.1:8080')
createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    let asked = '?'
    try { asked = JSON.parse(body.toString('utf8')).model } catch {}
    const agent = req.headers['x-claude-code-agent-id'] ?? 'main'
    const up = request({ host: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers: { ...req.headers, host: upstream.host } }, ur => {
      process.stderr.write(`agent=${agent} asked=${asked} x-omnis-model=${ur.headers['x-omnis-model'] ?? '-'}\n`)
      res.writeHead(ur.statusCode ?? 502, ur.headers)
      ur.pipe(res)
    })
    up.on('error', () => { res.writeHead(502); res.end() })
    up.end(body)
  })
}).listen(8789, '127.0.0.1')
```

With OmnisSwarm loaded in that `claude`, spawn one subagent on a cheap task Router is known to route down. Compare, per request, the proxy's `asked` / `x-omnis-model` with the `agent.usage` `model` lines in `.omnis-swarm/swarms/<swarm>.jsonl`.

Pass: for a request where `asked ≠ x-omnis-model`, the matching `agent.usage.model` equals `x-omnis-model`. Fail: it equals `asked`, or no routed request differed (report that too; it means the probe was inconclusive, not passed).

- [ ] **Step 2: Write the failing tests**

```ts
// tests/core/fold-routed.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldAll, LEAD } from '../../src/core/fold.ts'
import { ev } from '../helpers.ts'

const start = ev('agent.started', { name: 'c', role: 'coder', description: '', parent: LEAD }, { agent: 'a1', atSec: 0 })
const usage = (model: string, requested?: string) =>
  ev('agent.usage', { model, ...(requested !== undefined && { requested }), input: 1_000_000, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, { agent: 'a1', atSec: 1 })

test('a routed call records the requested model and the estimated saving', () => {
  const a = foldAll('s1', [start, usage('claude-haiku-5-5', 'claude-sonnet-5-5')]).agents.a1!
  assert.equal(a.model, 'claude-haiku-5-5')
  assert.equal(a.requested, 'claude-sonnet-5-5')
  assert.equal(Math.round(a.routedDeltaUsd * 100) / 100, 1.9)
})

test('a dearer answer is a negative delta', () => {
  const a = foldAll('s1', [start, usage('claude-sonnet-5-5', 'claude-haiku-5-5')]).agents.a1!
  assert.equal(Math.round(a.routedDeltaUsd * 100) / 100, -1.9)
})

test('no requested model, or the same one, saves nothing', () => {
  assert.equal(foldAll('s1', [start, usage('claude-haiku-5-5')]).agents.a1!.requested, null)
  assert.equal(foldAll('s1', [start, usage('claude-haiku-5-5', 'claude-haiku-5-5')]).agents.a1!.routedDeltaUsd, 0)
})

test('an unpriced model on either side saves nothing but still shows', () => {
  const a = foldAll('s1', [start, usage('gpt-x', 'claude-sonnet-5-5')]).agents.a1!
  assert.equal(a.requested, 'claude-sonnet-5-5')
  assert.equal(a.routedDeltaUsd, 0)
})
```

```ts
// tests/render/spotlight-routed.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldAll, LEAD } from '../../src/core/fold.ts'
import { render } from '../../src/render/frame.ts'
import { gridText } from '../../src/render/grid.ts'
import { emptyView } from '../../src/render/types.ts'
import { at, ev } from '../helpers.ts'

const routed = (model: string, requested: string) => foldAll('s1', [
  ev('agent.started', { name: 'coder-1', role: 'coder', description: '', parent: LEAD }, { agent: 'a1', atSec: 0 }),
  ev('agent.usage', { model, requested, input: 1_000_000, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, { agent: 'a1', atSec: 1 }),
])
const frame = (model: string, requested: string, rows = 44) => render(routed(model, requested), { ...emptyView(), pinned: 'a1' }, at(2), { columns: 120, rows })

test('spotlight row 0 shows sonnet → haiku; row 1 says what it saved vs requested', () => {
  const lines = gridText(frame('claude-haiku-5-5', 'claude-sonnet-5-5').bottom!)
  const all = lines.join('\n')
  assert.match(all, /sonnet → haiku/)
  assert.match(all, /≈\$0\.10 · saves ≈\$1\.90 vs requested/)
})

test('a dearer answer says costs … more vs requested', () => {
  assert.match(gridText(frame('claude-sonnet-5-5', 'claude-haiku-5-5').bottom!).join('\n'), /costs ≈\$1\.90 more vs requested/)
})

test('the graph label carries ↓ for cheaper and ↑ for dearer', () => {
  assert.match(gridText(frame('claude-haiku-5-5', 'claude-sonnet-5-5').top).join('\n'), /coder-1 ↓/)
  assert.match(gridText(frame('claude-sonnet-5-5', 'claude-haiku-5-5').top).join('\n'), /coder-1 ↑/)
})

test('two versions of one family show no badge', () => {
  const all = gridText(frame('claude-sonnet-5-5', 'claude-sonnet-5').bottom!).join('\n')
  assert.doesNotMatch(all, /→|vs requested/)
})
```

Colours (§13.5) are checked by reading the cells: `sonnet` `TEXT.dim`, ` → ` `TEXT.faint`, `haiku` `MODEL.haiku`; the saved figure `STATUS.running`, the dearer one `STATUS.warn`; `↓` `TEXT.dim`, `↑` `STATUS.warn`. Add a compact-spotlight case (the 1-row spotlight size step) asserting ` · sonnet → haiku` after the name and no saving, and a tree case asserting the mark follows the name.

- [ ] **Step 3: Run them to verify they fail**

Run: `node --test tests/core/fold-routed.test.ts tests/render/spotlight-routed.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement**

- `events.ts`: `'agent.usage'` gains `requested?: string`.
- `record-events.ts`: `agentUsage(rawUsage, agent, requested?: unknown)` adds `...(cleanText(requested, 80) !== '' && { requested: cleanText(requested, 80) })`.
- `recorder.ts` `turn.step`: `void record($, agentUsage(result.usage, agent, e.model))`.
- `record.ts` `agent.usage` case: `...(d.requested !== undefined && { requested: text(d, 'requested', 80) })`.
- `fold.ts`: `requested: null, routedDeltaUsd: 0` in `agentOf`; in `agent.usage`:

```ts
      const requested = text(d.requested, 80)
      if (requested !== '') a.requested = requested
      if (requested !== '' && a.model !== null && requested !== a.model) {
        const asked = costOf(requested, usage)
        if (asked !== null && usd !== null) a.routedDeltaUsd += asked - usd
      }
```

  (after `usd` is computed).
- `state-check.ts`: add `'requested', 'routedDeltaUsd'` to the agent keys with `nstr(x.requested, 80) && typeof x.routedDeltaUsd === 'number' && Number.isFinite(x.routedDeltaUsd)` (it may be negative, so not `num`).
- `stats.ts`: `AgentStats` gains `requested: string | null; routedDeltaUsd: number`, copied from the agent.
- `spotlight.ts`:

```ts
/** §13.5: a badge only when both models are known and their families differ. */
export function routedFamilies(s: AgentStats): { asked: string; answered: string } | null {
  if (s.requested === null || s.model === null) return null
  const asked = modelFamily(s.requested)
  const answered = modelFamily(s.model)
  return asked === answered || asked === 'other' || answered === 'other' ? null : { asked, answered }
}
```

  Row 0 (line ~93), in place of the model id when `routedFamilies(s)` is set: `[asked, TEXT.dim], [' → ', TEXT.faint], [answered, modelColor(s.model)]`. Row 1, right side, whole or absent and never cutting `vs requested`: `[fmtUsd(s.costUsd), TEXT.primary]` then, for a positive delta, `[' · saves ', TEXT.dim], [\`≈$${d.toFixed(2)}\`, STATUS.running], [' vs requested', TEXT.dim]`; for a negative one, `[' · costs ', TEXT.dim], [\`≈$${(-d).toFixed(2)}\`, STATUS.warn], [' more vs requested', TEXT.dim]`; nothing for 0. Compact spotlight: ` · asked → answered` after the name, no saving.
- `graph.ts` label: after the name, `' ↓'` in `TEXT.dim` when `routedDeltaUsd > 0`, `' ↑'` in `STATUS.warn` when `< 0`, only when `routedFamilies` is set; dropped in the glyph-only fallback. `tree.ts`: the same mark after the name.
- Every other model colour in the pane stays the **answered** model (§13.5): no change to globe fill, robot glow, chips or timeline.

- [ ] **Step 5: Run the gate**

Run: `npm run typecheck && npm test && npm run test:mod && git diff --stat tests/render/golden`
Expected: green; golden diff empty (no fixture has `requested`). Send the designer the spotlight PNG for §13.7's badge check.

- [ ] **Step 6: Commit**

```bash
git add src tests
git commit -m "Show the requested and answered model per agent when a router rewrites it"
```

---

## Self-review notes

- Spec coverage: §2.1 limits/defaults (T2), once-per-stage and re-arm (T1 fold + T2 `fires`), session-cost baseline (T2 `swarmCost`, T3 `enter`); §2.2 warn/nudge/block (T3), undelivered recorded not retried (T3 test); §2.3 userConfig (T3), init budget (T2), `/omnis budget` (T3b), boundary validation (T1 record, T2 parse); §2.4 runs in the mod, ≤ every 15 s, no timer without a running agent (T3), events through `omnis_record` (T1); §3 replay (T5, T6); §4 GIF (T7, T8, T9); §5 badge with probe gate (T10); §6 events (T1, T10); §7 tests per feature (each task); §8 constraints (Global Constraints, T0 split).
- §13 follow-through: 13.1 tokens (T4a), 13.2 drop/flash/drip (T4a), guard words and BLOCKED header (T4b, wired by T3b), 13.3 replay header (T6), 13.4 GIF header mark and card (T8), 13.5 model badge (T10), 13.7 golden checks (designer PNG reviews in T4a, T8, T10).
- Known limits written into the code comments: a hot reload of the mod forgets which guard stages fired (may warn once more); replay durations read in replay time; GIF and preview text is drawn from Spleen 8×16 (BSD 2-Clause, `src/render/font/LICENSE-spleen.txt`) plus our own `extra.ts` drawings; only a code point outside both (CJK in an agent name, say) falls back to the soft bar. Blocks (now including quadrants) and braille stay exact.
