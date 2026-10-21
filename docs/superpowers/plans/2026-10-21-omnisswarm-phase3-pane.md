# OmnisSwarm Phase 3 (Live Swarm Pane) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build OmnisSwarm's live, read-only swarm pane: an `omnis_feed` server tool, pure render units that draw a true-colour animated picture of the swarm into a cell grid, and a mod that pulls the feed while the pane is shown and paints it as a terminal `Raster` (an `Svg` on the desktop).

**Architecture:** The MCP server already holds each swarm's folded `SwarmState`. A new internal tool, `omnis_feed({ since, swarm })`, answers the whole state or the events appended since an offset. The pane mod (`src/mod/pane.ts`) pulls it at most 4 times a second while the pane is shown, folds incoming events with `core/fold.ts`, and calls a pure `render(state, view, nowMs, size) → Frame` in `src/render/`. `render` draws a half-block pixel canvas plus a braille dot layer (nodes, glow, link comets, pulses, clashes), then text panels (header, spotlight, timeline, feed), into two `Grid`s that become two `Raster`s with a row of pin chips (`Button`s) between them. Animation repaints with `$.ui.blit`; a full redraw happens only when the tree's shape changes.

**Tech Stack:** Node 24 (type stripping, `node:test`), TypeScript 7 type-check only, Claude Code 2.1.306 mod API (`claude-code`, `claude-code/testing`), no runtime npm dependencies.

**Branch:** `phase3-pane` (worktrees branch off it as `wt/p3-t<N>`).

**Spec:** `docs/superpowers/specs/2026-10-21-omnisswarm-design.md` (§9 stats, §10 pane, §11 errors, §12 testing, §14 phases, §15 assumptions). **Mod API facts:** `docs/spikes/2026-10-21-mod-api.md`. **Authoritative API:** the engine's `claude-code.d.ts` written by the `plugin-authoring` skill (load the skill; it names the path).

## Global Constraints

- Node `>=24`, no build step, no runtime npm dependencies, no new dev dependencies.
- Erasable TypeScript only: no `enum`, `namespace` or constructor parameter properties. Relative imports end in `.ts`. Type-only imports use `import type` or inline `type`.
- No file over 500 lines.
- **Mod-safe files** (`src/render/**`, `src/mod/pane*.ts`, `src/core/feed-reply.ts`, and everything they import): no `node:*` import, no `Buffer`, `process`, `require`, `module`, `__dirname`, `fetch`, `queueMicrotask`, `setImmediate`. Web APIs only (`TextEncoder`, `Uint8Array`, `Date.now()`, `Math`, `setTimeout`). The static check in Task 4 greps for these words, so **do not write the words `fetch`, `Buffer` or `process.` even in comments** of those files.
- A `Raster` is at most 512 columns by 256 rows. Every glyph written to a grid goes through `safeGlyph` (printable, width 1, BMP), or the engine refuses the whole tree.
- Colour pair budget per frame: top grid ≤ 700 distinct fg/bg pairs, bottom grid ≤ 300 (the terminal paints 1024 at once).
- `omnis_feed` is pulled at most 4 times a second (`PULL_MS = 250`), only while the pane is placed and shown, one call in flight.
- The pane is informational only: no Button, timer or hook in it sends a prompt, runs a tool other than `omnis_feed`, or writes to the swarm. Pin chips change only what the pane shows.
- Never change `src/core/fold.ts`, `src/core/stats.ts`, `src/mcp/tools.ts`, `src/mcp/session.ts` or `src/mcp/server.ts`. New core file `src/core/feed-reply.ts` is the only core addition (the server/pane contract, kept mod-safe so the pane can import it).
- Shared files are integrator-owned and touched only in Task 15: `src/mcp/registry.ts`, `src/mod/register.ts`, `.claude-plugin/plugin.json`, `tests/e2e/mcp-server.test.ts` . Phase 3 never edits `package.json`, the lockfile or `.gitignore`.
- Every untrusted string (agent names, summaries, paths, task titles from the log) is drawn only through `Grid.text`/`writeParts` (which use `safeGlyph`) and is clipped to its cell budget.
- Gate before every commit: `npm run check` green. After phase 2's scaffold lands, `check` also runs `claude plugin validate .` and the mod tests.
- Commit as `Fortitude Omnis <dev@fortitude-omnis.group>`, plain developer English, British spelling. No `Co-Authored-By`, no "Generated with", no AI attribution of any kind.
- Windows is the dev platform. Every command works in Git Bash and PowerShell.

## Shared scaffold owned by phase 2 (consumed here, never edited here)

Phase 2's Task 1 put this on `master` (commits `02c6eb0` and `ed7c49a`); checked against the files, not only its plan:

- `src/mod/register.ts`: the single hooks module (`hooks/hooks.json` names `../src/mod/register.ts`), `export const register: Register = (on, _options) => { registerGuard(on); registerRecorder(on) }`. Task 15 renames `_options` to `options` and adds `import { registerPane } from './pane.ts'` and `registerPane(on, options)`.
- `src/mod/server.ts`: `connectServer($: EngineInterface): Promise<string | null>`. `$.mcp.connect` is idempotent, so the pane calls it itself.
- `src/core/recording.ts`: `INTERNAL_TOOL = /^mcp__plugin_.+__omnis_(record|feed)$/`. Phase 2's guard (`tool.check` origin check with a fail-closed `.catch`, `tool.describe` with `isDeferred`) and the recorder's `tool.call` skip both use it, so `omnis_feed` is covered from the start.
- `types/index.d.ts`: `PluginState['omnis-swarm'] = { seen: string[]; dropped: number; paneOpen: boolean; panePinned: string | null }`. The pane uses `panePinned`.
- `tsconfig.mod.json` (types `[]`, lib es2024, JSX factory `h`) includes `src/mod/**` and `src/render/**`. The main `tsconfig.json` excludes `src/mod/**` and includes `scripts/**`, so `scripts/preview.ts` is type-checked. `npm run typecheck` runs both.
- `npm run test:mod` (`scripts/test-mod.ts`): `claude plugin validate .`, then `claude plugin test` on a staged copy of `.claude-plugin`, `hooks`, `types`, `src` and `tests/fixtures`. The engine collects every `*.test.ts` in the folder it is given, so the node suites in `tests/**` stay out of the copy. Skipped with a message when `claude` is not on PATH; non-zero then only under `CI`. `npm run check` = typecheck + `npm test` + `npm run test:mod`.
- Phase 2's Task 5 makes a recorder event's `data.dropped` add to `state.gaps`, so the pane's gap marker covers dropped recorder events with no pane change.

The pane-mod tasks (16, 17) start after Task 15. Task 15 is the phase's integrator task for every shared-file edit (the `registerPane` lines, the `omnis_feed` registry line, the `panel` option, the e2e tool list). It runs before Tasks 16 and 17 rather than last, because `claude plugin test` only loads the pane through `register.ts`, so the pane's kit tests need the wiring first. It wires a stub, so nothing it adds can break the gate. Kit facts from planner-p2's probes: a plugin's `$.mcp.call` goes straight to the test's `on('mcp.call')` hook and raises no `tool.call`/`tool.check` there; the vendored d.ts declares no `setTimeout` or `console` for mods (timers go through `$.clock`; no render or pane file uses either); fire-and-forget calls can settle after the next awaited call, so the pane awaits its auto-open after `next(e)` and the tests never assert the order of unawaited work.

## File Structure

```
docs/design/pane.md                 design direction: palette, glyphs, motion, layouts, size steps (Task 1)
src/core/feed-reply.ts              FeedReply type + parseFeedReply (server/pane contract, mod-safe) (Task 3)
src/mcp/tools/feed.ts               omnis_feed tool factory, createFeedTools (Task 3)
src/render/types.ts                 Point, Rect, Size, SizeStep, Pulse, Spot, Tween, View, Chip, Frame (Task 4)
src/render/tokens.ts                design tokens copied from docs/design/pane.md (Task 4)
src/render/color.ts                 mix, scale, add, desaturate, hex, contrast, quantise (Task 4)
src/render/grid.ts                  Grid, safeGlyph, base64, decodeCells, gridText, pairCount, limitPairs, writeParts (Task 4)
src/render/format.ts                fmtTokens, fmtUsd, fmtDuration, fmtAge, fmtPercent, clipText (Task 4)
src/render/canvas.ts                Pixels (half-block canvas), Dots (braille), compose (Task 5)
src/render/fx.ts                    fades, glow, comets, flashes, tween (Task 5)
src/render/regions.ts               sizeStep, planRegions (Task 6)
src/render/layout.ts                orderAgents, parentsOf (cycle guard), layoutNodes, structuralEdges, nodesKey (Task 6)
src/render/spotlight.ts             busiest, chooseSpotlight, sparkline, drawSpotlight (Task 7)
src/render/header.ts                drawHeader, drawSummary (Task 8)
src/render/tree.ts                  drawTree (Task 8)
src/render/timeline.ts              drawTimeline (Task 8)
src/render/feed.ts                  drawFeed (Task 8)
src/render/svg.ts                   gridToSvg (Task 9)
src/mod/pane-model.ts               PaneModel, feedArgs, applyReply, pulsesFrom, prunePulses (Task 10)
src/mod/pane.ts                     stub in Task 15, the pane mod in Task 16
src/render/graph.ts                 drawGraph, nodeRadius, nodeColor, clashActive (Task 11)
src/render/frame.ts                 render, targetFps, frameInterval (Task 12)
scripts/preview.ts                  golden cases to PNG + SVG for design review (Task 12)
commands/watch.md                   /omnis-swarm:watch, the alias (Task 16)
src/mod/pane.test.ts                mod tests, run by `claude plugin test` (Task 16)
src/mod/pane-e2e.test.ts            headless five-agent pane e2e through the engine (Task 17)
tests/fixtures/swarm-five.ts        scripted five-agent swarm (mod-safe) (Task 4)
tests/render/*.test.ts              unit + golden tests; tests/render/golden/*.txt (Tasks 4-12)
tests/mcp/feed.test.ts, tests/core/feed-reply.test.ts (Task 3)
tests/mod/pane-model.test.ts (Task 10), tests/core/stats-boundaries.test.ts (Task 7)
tests/e2e/pane-render.test.ts       server → feed → pane model → render, headless (Task 12)
```

## Execution Waves (fan-out)

Parallel tasks run as separate agents, each in its own git worktree off the phase 3 branch, and touch only the files their task lists. The integrator merges each wave before the next starts.

| Wave | Tasks | Runs | Depends on |
|---|---|---|---|
| 0 | 1 (design doc), 2 (Raster probe, needs Rob), 3 (omnis_feed) | **parallel** (3 agents) | phase 1 on master |
| 1 | 4 (render foundations) | serial | 1 (token values); 2 if back (FPS and pair budget) |
| 2 | 5, 6, 7, 8, 9, 10 | **parallel** (6 agents) | 4 (10 also needs 3) |
| 3 | 11 (graph) | serial | 5, 6 |
| 4 | 12 (frame, goldens, preview, render e2e) | serial | 7, 8, 9, 10, 11 |
| 5 | 13 (design review) then 14 (apply review) | serial | 12 |
| 6 | 15 (integrator wiring) | serial | 14 **and phase 2's scaffold on master** |
| 7 | 16 (pane mod) then 17 (mod e2e) | serial (same mod files) | 15 |
| 8 | 18 (integrator: merge + full gate) | serial | 17 |
| 9 | 19 (interactive acceptance with Rob) | serial, manual | 18 |

Waves 0-5 need nothing from phase 2 and can run while phase 2 is still in flight. Task 2 is the only task that needs a person (an interactive terminal); nothing waits on it except two token values, which have defaults.

Reviews per task: `omnis-reviewer` for every task. `omnis-security-reviewer` also for Task 3 (MCP arguments), Task 4 (`safeGlyph`, untrusted text into a terminal) and Task 16 (server replies parsed in the mod, Buttons). `omnis-designer` reviews Tasks 12-14 output.

---
### Task 1: Pane design direction  *(wave 0, parallel; omnis-designer)*

**Files:**
- Create: `docs/design/pane.md`

**Interfaces:**
- Consumes: spec §9, §10, §11; `docs/spikes/2026-10-21-mod-api.md` (Q6: Raster limits); the token names in Task 4's `src/render/tokens.ts` (listed below, the interface every render task codes against).
- Produces: `docs/design/pane.md` with a **Tokens** table whose rows use exactly these names: `CANVAS`, `CANVAS_RAISED`, `TEXT.primary`, `TEXT.dim`, `TEXT.faint`, `ACCENT`, `MODEL.fable|opus|sonnet|haiku|other`, `STATUS.running|waiting|done|failed|warn`, `KIND.read|edit|bash|search|web|agent|other`, `LINK.idle|active|comet|clash`, `FEED_COLOR.agent|message|memory|task`, `FEED_MARK.*`, `GLYPH.*`, `MOTION.*`, `FPS.*`, `GRAPH.*`, `SIZE.*`, `SPOTLIGHT_HOLD_MS`, `PULL_MS`, `PAIR_BUDGET.top|bottom`. Task 4 copies the values from that table. Names are fixed; values are the designer's call.

The designer writes direction, not code. The starting values below are the plan's proposal; change any value, keep every name.

- [ ] **Step 1: Read the inputs**

Read spec §10 in full, the spike's Q6 row and "Not verified" section, `.claude/agents/omnis/omnis-designer.md`, and RuFlo's cell art for what already works in this terminal: `C:\Users\Rob\.claude\plugins\cache\ruflo\ruflo-console\0.44.6\hooks\gfx\neon.ts` (glow as background light), `raster.ts` (braille, sparklines), `flow.ts` (status rings).

- [ ] **Step 2: Write `docs/design/pane.md`**

It must have these sections, in this order, each concrete enough that a developer can implement it without asking:

1. **Principles.** Motion explains (comet = a message moved, glow = work is happening, flicker = a tool ran, red pulse = an error, ghost = finished). Status never relies on colour alone. The pane paints its own dark canvas so it reads the same on dark and light terminal themes.
2. **Canvas and theme.** `CANVAS`, `CANVAS_RAISED`; why a self-painted canvas; what stays on the terminal's default colours (nothing inside the Rasters; the chip row's Buttons use the terminal theme).
3. **Tokens.** One table: token, value, use, contrast ratio on `CANVAS`. Proposed starting values:

| Token | Proposed value |
|---|---|
| `CANVAS` / `CANVAS_RAISED` | `#0b0f17` / `#131a26` |
| `TEXT.primary` / `.dim` / `.faint` | `#e6edf3` / `#9aa4b2` / `#4a5363` |
| `ACCENT` | `#b48cff` |
| `MODEL.fable` / `.opus` / `.sonnet` / `.haiku` / `.other` | `#cc79a7` / `#56b4e9` / `#2ec4a0` / `#f0e442` / `#a7b0be` (Okabe-Ito based) |
| `STATUS.running` / `.waiting` / `.done` / `.failed` / `.warn` | `#7ee787` / `#9aa4b2` / `#8b98a9` / `#ff6b4a` / `#e69f00` |
| `KIND.read` / `edit` / `bash` / `search` / `web` / `agent` / `other` | `#7fdbff` / `#ffd166` / `#c3a6ff` / `#8be9c9` / `#9ecbff` / `#ff9ec7` / `#d0d7de` |
| `LINK.idle` / `.active` / `.comet` / `.clash` | `#2b3546` / `#9ecbff` / `#f5fbff` / `#ff6b4a` |
| `FEED_COLOR.agent` / `.message` / `.memory` / `.task` | `#9aa4b2` / `#9ecbff` / `#d2a8ff` / `#ffb86b` |
| `FEED_MARK.agent` / `.message` / `.memory` / `.task` | `•` / `›` / `+` / `#` |
| `GLYPH.running` / `waiting` / `done` / `failed` / `lead` / `unknown` / `stuck` / `clash` / `gap` / `dot` / `pinned` | `▶` `◌` `✓` `✕` `◆` `?` `!` `!` `⚠` `●` `◉` |
| `MOTION.fadeInMs` / `ghostMs` / `glowPeriodMs` / `cometMs` / `trailMs` / `trailDots` / `linkFadeMs` / `pulseMs` / `errorPulseMs` / `clashFlashMs` / `clashBlinkMs` / `tweenMs` | 600 / 1500 / 1600 / 900 / 450 / 6 / 3000 / 350 / 900 / 4000 / 250 / 400 |
| `FPS.busy` / `glow` / `min` | 30 / 12 / 4 |
| `GRAPH.minRadius` / `maxRadius` / `glowPx` / `ringPx` / `linkThick` / `linkBend` | 1.6 / 6 / 2.5 / 1.2 / [5, 20] / 0.18 (pixels; a half-block pixel is about square; `linkBend` bows each message link to the left of its direction by that share of its length, so a link never lies on a parent edge, its reverse curves the other way, and same-row links clear the nodes between) |
| `SIZE.summaryBelowRows` / `summaryBelowColumns` / `treeBelowRows` / `treeBelowColumns` / `compactBelowRows` / `noTimelineBelowRows` / `graphShare` / `minGraphRows` / `spotlightRows` / `timelineMaxRows` / `minFeedRows` | 6 / 30 / 14 / 48 / 22 / 30 / 0.55 / 8 / 6 / 8 / 2 |
| `SPOTLIGHT_HOLD_MS` / `PULL_MS` | 5000 / 250 |
| `PAIR_BUDGET.top` / `.bottom` | 700 / 300 |

4. **Status encoding.** For each of running, waiting, done, failed, stuck, placeholder (unknown name): node fill, glyph, label colour, motion. Proposed: running = model colour + pulsing glow halo + `▶`; waiting = model colour at 72% brightness, no glow, `◌`; done = fades over `ghostMs` to a desaturated ghost + `✓`; failed = `STATUS.failed` fill that stays + `✕`; stuck = amber rim pulse + `!` after the label; placeholder = small `TEXT.faint` node + `?`.
5. **Glyphs.** Every glyph with its code point, and a note that each is printable, width 1 and in the BMP (no emoji presentation, nothing East Asian Wide). Half-blocks (`▀` U+2580) give two pixels a cell; braille (U+2800-28FF) gives 2x4 dots for fine lines and particles; eighth blocks for bars and sparklines.
6. **Motion.** Each `MOTION.*` value: what it shows, its easing (fade-in ease-out cubic, comet ease-in-out, ghost linear), and when the frame loop may stop. Frame rate policy: `FPS.busy` while comets, fades, pulses, tweens or a clash flash are live; `FPS.glow` while only glows or stuck pulses move; stop when nothing moves; double the frame interval when a frame takes more than 60% of it, down to `FPS.min`.
7. **Layouts per topology.** ASCII sketches: hierarchical = tree, lead at the top, layers by depth; mesh = ring, lead at 12 o'clock; star = lead in the centre, spokes on a ring. Links: structural edges as faint dotted braille; message links brighten for `linkFadeMs` after a message and thicken at the `linkThick` counts; comets run along the link with a fading trail; a file clash draws a dashed `LINK.clash` line and blinks both nodes' rims.
8. **Size steps.** ASCII mock of each step at its threshold size: full (120x44), no timeline (100x29), compact spotlight (80x21), tree (60x13), one-line summary (40x5). Row budget per region.
9. **Spotlight card, timeline, feed, header, chips.** Row by row: what each row shows and its colours (Tasks 7 and 8 carry the proposed rows).
10. **Pair budget and the Svg surface.** Ramps are quantised (fades in 8 steps, glow in 5, ghost in 6, link recency in 5) so a frame stays under `PAIR_BUDGET`; on the desktop the same grid becomes a static SVG.
11. **Accessibility checklist** that Task 13 reviews against: text tokens ≥ 4.5:1 on `CANVAS`; model, status, kind and feed colours ≥ 3:1; every status distinguishable in greyscale by glyph or motion; model colours distinguishable under deuteranopia and protanopia.

- [ ] **Step 3: Check the contrast numbers in the table**

Run (Git Bash or PowerShell), editing the list to match the final table:

```bash
node -e "const L=c=>{const f=v=>{v/=255;return v<=0.03928?v/12.92:((v+0.055)/1.055)**2.4};return 0.2126*f(c>>16&255)+0.7152*f(c>>8&255)+0.0722*f(c&255)};const C=(a,b)=>{const x=L(a),y=L(b);return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05)};const bg=0x0b0f17;for(const [n,c] of Object.entries({primary:0xe6edf3,dim:0x9aa4b2,fable:0xcc79a7,opus:0x56b4e9,sonnet:0x2ec4a0,haiku:0xf0e442,other:0xa7b0be,running:0x7ee787,failed:0xff6b4a,warn:0xe69f00}))console.log(n,C(c,bg).toFixed(2))"
```

Expected: every text token ≥ 4.50, every other listed colour ≥ 3.00. Put the printed ratios in the table.

- [ ] **Step 4: Commit**

```bash
git add docs/design/pane.md
git commit -m "Add the swarm pane design direction: palette, glyphs, motion, layouts and size steps"
```

---

### Task 2: Raster probe in an interactive terminal  *(wave 0, parallel; omnis-researcher with Rob)*

Spec §10 says phase 3 first checks, in an interactive session, the two `Raster` facts the spike could only read in the docs: how many blits a second actually land, and what happens past 1024 colour pairs (is the budget per Raster or per screen?). Headless runs can't show either. This task builds a throwaway probe mod outside the repo, Rob runs it, and the researcher writes up the numbers. Its only effect on code is two token values in Task 4 (`FPS.busy`, `PAIR_BUDGET`), which have safe defaults, so nothing waits on it.

**Files:**
- Create (outside the repo, in the session scratchpad, written `$SCRATCH` below): `$SCRATCH/raster-probe/.claude-plugin/plugin.json`, `$SCRATCH/raster-probe/hooks/hooks.json`, `$SCRATCH/raster-probe/hooks/register.ts`
- Create: `docs/spikes/2026-10-21-raster-probe.md`

**Interfaces:**
- Consumes: the `claude-code.d.ts` API (`$.ui.open`, `ui.render` on `Pane`, `Raster`, `$.ui.blit`, `$.clock.every`, `$.command.register`, `$.ui.log`).
- Produces: measured blit rate at 30 and 60 fps asked; whether 1024, 1500 and 2048 distinct pairs in one Raster, and 2 x 700 across two Rasters, show banding or snapping; recommended `FPS.busy` and `PAIR_BUDGET` for Task 4.

- [ ] **Step 1: Write the probe mod**

`$SCRATCH/raster-probe/.claude-plugin/plugin.json`:

```json
{ "name": "raster-probe", "version": "0.0.1", "description": "Measures Raster blit rate and the colour-pair palette in a real terminal" }
```

`$SCRATCH/raster-probe/hooks/hooks.json`:

```json
{ "modules": ["./register.ts"] }
```

`$SCRATCH/raster-probe/hooks/register.ts`:

```ts
import type { Register } from 'claude-code'

const PANE = 'raster-probe'
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function toBase64(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!
  }
  if (bytes.length - i === 1) {
    const n = bytes[i]! << 16
    out += `${B64[(n >> 18) & 63]}${B64[(n >> 12) & 63]}==`
  } else if (bytes.length - i === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8)
    out += `${B64[(n >> 18) & 63]}${B64[(n >> 12) & 63]}${B64[(n >> 6) & 63]}=`
  }
  return out
}

function hsv(h: number, s: number, v: number): number {
  const f = (n: number) => {
    const k = (n + h * 6) % 6
    return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))))
  }
  return (f(5) << 16) | (f(3) << 8) | f(1)
}

/** One frame: `pairs` distinct fg/bg pairs cycling across the cells, drifting with time. */
function frame(columns: number, rows: number, pairs: number, t: number): string {
  const cells = new Uint32Array(columns * rows * 3)
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const i = (y * columns + x) * 3
      const k = (x + y * columns) % pairs
      const phase = (k / pairs + t / 4000) % 1
      cells[i] = 0x2580
      cells[i + 1] = hsv(phase, 0.8, 1)
      cells[i + 2] = hsv((phase + 0.5) % 1, 0.6, 0.3)
    }
  }
  return toBase64(new Uint8Array(cells.buffer))
}

type Run = { fps: number; pairs: number; split: boolean; startedAt: number; sent: number; landed: number; denied: number; waits: number[] }
let run: Run | null = null
let size = { columns: 80, rows: 24 }
let ticker: { cancel: () => void } | null = null

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'raster-probe', description: 'Raster probe: /raster-probe <fps> <pairs> [split]', argumentHint: '<fps> <pairs> [split]' })
    return next(e)
  })

  on('command.run', { command: 'raster-probe' }, async ($, e) => {
    const [fpsText = '30', pairsText = '1024', mode = ''] = e.args.trim().split(/\s+/)
    const fps = Math.max(1, Math.min(120, Number(fpsText) || 30))
    const pairs = Math.max(1, Math.min(4096, Number(pairsText) || 1024))
    run = { fps, pairs, split: mode === 'split', startedAt: Date.now(), sent: 0, landed: 0, denied: 0, waits: [] }
    await $.ui.open({ id: PANE, title: 'Raster probe' })
    $.ui.invalidate('ui.render')
    ticker?.cancel()
    ticker = $.clock.every(Math.round(1000 / fps), () => {
      const r = run
      if (r === null) return
      const keys = r.split ? ['a', 'b'] : ['a']
      const rows = r.split ? Math.max(1, Math.floor(size.rows / 2)) : size.rows
      for (const key of keys) {
        const asked = Date.now()
        r.sent++
        void $.ui.blit({ requestId: PANE, key, cells: frame(size.columns, rows, r.pairs, asked + (key === 'b' ? 2000 : 0)), columns: size.columns, rows }).then(result => {
          if ('deny' in result && result.deny !== undefined) r.denied++
          else r.landed++
          r.waits.push(Date.now() - asked)
        })
      }
      if (Date.now() - r.startedAt >= 10_000) {
        ticker?.cancel()
        ticker = null
        const waits = [...r.waits].sort((a, b) => a - b)
        const median = waits[Math.floor(waits.length / 2)] ?? 0
        $.ui.log(`raster-probe: asked ${r.fps} fps, ${r.pairs} pairs${r.split ? ' x2 rasters' : ''}, size ${size.columns}x${size.rows}: sent ${r.sent}, landed ${r.landed} (${(r.landed / 10).toFixed(1)}/s), denied ${r.denied}, median wait ${median} ms`)
        run = null
      }
    })
    return { text: `Probe running for 10 s at ${fps} fps with ${pairs} pairs${mode === 'split' ? ' in two rasters' : ''}.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => {
    if (e.surface !== 'terminal') {
      const { Text } = $.ui.resolve(e)
      return Text({ children: 'The Raster probe needs the terminal.' })
    }
    const { Box, Raster } = $.ui.resolve(e)
    size = { columns: Math.max(1, Math.min(512, Math.floor(e.props.bodyColumns))), rows: Math.max(2, Math.min(256, Math.floor(e.props.scroll.bodyRows))) }
    const pairs = run?.pairs ?? 1024
    if (run?.split === true) {
      const rows = Math.floor(size.rows / 2)
      return Box({ flexDirection: 'column', children: [
        Raster({ key: 'a', columns: size.columns, rows, cells: frame(size.columns, rows, pairs, 0) }),
        Raster({ key: 'b', columns: size.columns, rows, cells: frame(size.columns, rows, pairs, 2000) }),
      ] })
    }
    return Raster({ key: 'a', columns: size.columns, rows: size.rows, cells: frame(size.columns, size.rows, pairs, 0) })
  })
}
```

- [ ] **Step 2: Validate it**

Run: `claude plugin validate "$SCRATCH/raster-probe"`
Expected: no errors; it lists hooks on `session.start`, `command.run` and `ui.render`. Fix anything it refuses against the `claude-code.d.ts` types.

- [ ] **Step 3: Rob runs it in a real terminal (fullscreen layout, at least 120 columns)**

Ask Rob to start, in a new terminal, `claude --plugin-dir "<full scratch path>/raster-probe"`, then run these one after another, waiting for each `raster-probe:` log line:

```
/raster-probe 30 512
/raster-probe 30 1024
/raster-probe 60 1024
/raster-probe 30 1500
/raster-probe 30 2048
/raster-probe 30 700 split
```

and say for each whether it looked smooth or stuttering, and whether colours visibly snapped or banded compared with the 512 run. Rob pastes the six log lines into the chat.

- [ ] **Step 4: Write `docs/spikes/2026-10-21-raster-probe.md`**

A table: run, landed blits per second, denied, median wait, what Rob saw. Then two recommendations with the reason: `FPS.busy` (the highest asked rate that landed in full and looked smooth, at most 30) and `PAIR_BUDGET` (keep `top + bottom ≤ 1024` if the split run snapped; if it didn't, the budget is per Raster and each can be up to 1000). Say what was measured and what was only seen.

- [ ] **Step 5: Commit**

```bash
git add docs/spikes/2026-10-21-raster-probe.md
git commit -m "Record how fast Raster blits land and how the colour-pair palette behaves in a real terminal"
```

Message the two recommended values to the lead, who passes them to the Task 4 developer (or to Task 14 if Task 4 has already merged).

---
### Task 3: The omnis_feed tool and the feed reply contract  *(wave 0, parallel)*

**Files:**
- Create: `src/core/feed-reply.ts`, `src/mcp/tools/feed.ts`
- Test: `tests/core/feed-reply.test.ts`, `tests/mcp/feed.test.ts`

**Interfaces:**
- Consumes: `Session` (`src/mcp/session.ts`): `mySwarm(adopt?: boolean): string | null`, `hasEnded(id): boolean`, `state(id): Loaded` with `Loaded = { state: SwarmState; offset: number; sinceSnapshot: number }` (`src/core/snapshot.ts`). `ToolContext = { root: string; now?: () => Date; session: Session }` (`src/mcp/tools.ts`) and `ToolDef`, `Args` (`src/mcp/protocol.ts`). From `core/log.ts`: `readCurrent(root)`, `readEvents(file, offset): ReadResult` (`{ events, offset, bad, skipped, reset }`), `sortEvents(events)`, `swarmLogPath(root, id)`. `isValidSwarmId`, `parseLine` (`core/events.ts`). `isSwarmState(x, id)` (`core/state-check.ts`, Node-free). `InputError`, `optString` (`src/mcp/validate.ts`).
- Produces:
  - `src/core/feed-reply.ts` (mod-safe): `FEED_VERSION = 1`, `FEED_MAX_EVENTS = 500`, `type FeedReply = { v: 1; kind: 'none' } | { v: 1; kind: 'state'; swarm: string; offset: number; state: SwarmState } | { v: 1; kind: 'events'; swarm: string; offset: number; events: SwarmEvent[]; bad: number }`, `parseFeedReply(text: string): FeedReply | null`.
  - `src/mcp/tools/feed.ts`: `createFeedTools(ctx: ToolContext): ToolDef[]`, one tool `omnis_feed`, input `{ since?: integer ≥ 0, swarm?: swarm id }`, answering `JSON.stringify(FeedReply)`. Task 15 adds `createFeedTools` to `toolFactories` in `src/mcp/registry.ts`.

How it answers (spec §10, with one simplification listed in Open questions): `since` 0 or absent, a missing or different `swarm`, an offset past the end, a replaced log, or more than 500 events waiting → a fresh `state`. Otherwise the events appended after `since`, sorted, with the new offset. Which swarm: this server's live swarm, else the live `current` swarm, else the swarm named by `swarm` if its log exists (so an ended swarm stays on screen), else an ended `current`, else `none`. It only reads and never adopts a swarm (`mySwarm(false)`), so pulling can't change which swarm the session owns. The guard (origin check at `tool.check`, `isDeferred`) lives in phase 2's mod and covers `omnis_feed` too.

- [ ] **Step 1: Write the failing tests**

`tests/core/feed-reply.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseFeedReply } from '../../src/core/feed-reply.ts'
import { emptyState } from '../../src/core/fold.ts'
import { ev } from '../helpers.ts'

const started = () => ev('agent.started', { name: 'a', role: 'r', description: '', parent: 'lead' }, { agent: 'a1' })

test('none, state and events replies parse', () => {
  assert.deepEqual(parseFeedReply('{"v":1,"kind":"none"}'), { v: 1, kind: 'none' })
  const s = parseFeedReply(JSON.stringify({ v: 1, kind: 'state', swarm: 's1', offset: 10, state: emptyState('s1') }))
  assert.equal(s?.kind, 'state')
  const r = parseFeedReply(JSON.stringify({ v: 1, kind: 'events', swarm: 's1', offset: 99, events: [started()], bad: 0 }))
  assert.ok(r !== null && r.kind === 'events')
  assert.equal(r.events.length, 1)
  assert.equal(r.offset, 99)
})

test('malformed replies are refused', () => {
  const state = emptyState('s1')
  const e = started()
  for (const bad of [
    'not json',
    '[]',
    '{"v":2,"kind":"none"}',
    '{"v":1,"kind":"other","swarm":"s1","offset":0}',
    JSON.stringify({ v: 1, kind: 'state', swarm: 's1', offset: -1, state }),
    JSON.stringify({ v: 1, kind: 'state', swarm: 's2', offset: 0, state }),
    JSON.stringify({ v: 1, kind: 'state', swarm: 'nul', offset: 0, state: emptyState('nul') }),
    JSON.stringify({ v: 1, kind: 'state', swarm: 's1', offset: 0, state: { ...state, agents: [] } }),
    JSON.stringify({ v: 1, kind: 'events', swarm: 's1', offset: 1, events: [{ ...e, swarm: 's2' }], bad: 0 }),
    JSON.stringify({ v: 1, kind: 'events', swarm: 's1', offset: 1, events: [{ ...e, v: 9 }], bad: 0 }),
    JSON.stringify({ v: 1, kind: 'events', swarm: 's1', offset: 1, events: [], bad: 1.5 }),
    JSON.stringify({ v: 1, kind: 'events', swarm: 's1', offset: 1, events: new Array(501).fill(e), bad: 0 }),
  ]) assert.equal(parseFeedReply(bad), null, bad.slice(0, 60))
})
```

`tests/mcp/feed.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { appendEvent, swarmLogPath, writeCurrent } from '../../src/core/log.ts'
import { parseFeedReply, type FeedReply } from '../../src/core/feed-reply.ts'
import { Session } from '../../src/mcp/session.ts'
import { createFeedTools } from '../../src/mcp/tools/feed.ts'
import { createTools } from '../../src/mcp/tools.ts'
import { InputError } from '../../src/mcp/validate.ts'
import { ev, tmpRoot } from '../helpers.ts'

const NOW = new Date('2026-10-21T10:00:00.000Z')

function setup(makeSession?: (root: string) => Session) {
  const root = tmpRoot()
  const session = makeSession === undefined ? new Session(root) : makeSession(root)
  const feed = createFeedTools({ root, session, now: () => NOW })[0]!
  const tools = createTools({ root, session, now: () => NOW })
  const call = (name: string, args: Record<string, unknown> = {}) => tools.find(t => t.name === name)!.handler(args)
  const pull = (args: Record<string, unknown> = {}): FeedReply => {
    const reply = parseFeedReply(feed.handler(args).text)
    assert.ok(reply !== null, 'the reply parses')
    return reply
  }
  const started = (sec: number, agent: string) =>
    ev('agent.started', { name: agent, role: 'coder', description: '', parent: 'lead' }, { swarm: 'feed', agent, atSec: sec })
  return { root, feed, call, pull, started }
}

test('one omnis_feed tool, marked internal, with an object schema', () => {
  const { feed } = setup()
  assert.equal(feed.name, 'omnis_feed')
  assert.equal(feed.inputSchema.type, 'object')
  assert.match(feed.description, /Internal/)
})

test('with no swarm the feed answers none', () => {
  const { pull } = setup()
  assert.deepEqual(pull(), { v: 1, kind: 'none' })
})

test('since 0 answers the folded state and the offset it reflects', () => {
  const { root, call, pull } = setup()
  call('omnis_swarm_init', { name: 'Feed', topology: 'mesh' })
  const r = pull()
  assert.ok(r.kind === 'state')
  assert.equal(r.swarm, 'feed')
  assert.equal(r.state.swarm.topology, 'mesh')
  assert.equal(r.offset, statSync(swarmLogPath(root, 'feed')).size)
})

test('the offset it gave answers no events', () => {
  const { call, pull } = setup()
  call('omnis_swarm_init', { name: 'Feed', topology: 'mesh' })
  const first = pull()
  assert.ok(first.kind === 'state')
  assert.deepEqual(pull({ since: first.offset, swarm: 'feed' }), { v: 1, kind: 'events', swarm: 'feed', offset: first.offset, events: [], bad: 0 })
})

test('events appended after the offset come back sorted, with the new offset', () => {
  const { root, call, pull, started } = setup()
  call('omnis_swarm_init', { name: 'Feed', topology: 'mesh' })
  const first = pull()
  assert.ok(first.kind === 'state')
  appendEvent(root, started(5, 'late'))
  appendEvent(root, started(3, 'early'))
  const r = pull({ since: first.offset, swarm: 'feed' })
  assert.ok(r.kind === 'events')
  assert.deepEqual(r.events.map(e => e.agent), ['early', 'late'])
  assert.equal(r.offset, statSync(swarmLogPath(root, 'feed')).size)
})

test('a missing or different swarm hint answers a fresh state', () => {
  const { call, pull } = setup()
  call('omnis_swarm_init', { name: 'Feed', topology: 'mesh' })
  const first = pull()
  assert.ok(first.kind === 'state')
  assert.equal(pull({ since: first.offset }).kind, 'state')
  assert.equal(pull({ since: first.offset, swarm: 'other' }).kind, 'state')
})

test('an offset past the end answers a fresh state', () => {
  const { call, pull } = setup()
  call('omnis_swarm_init', { name: 'Feed', topology: 'mesh' })
  assert.equal(pull({ since: 1_000_000, swarm: 'feed' }).kind, 'state')
})

test('more than 500 waiting events answers a fresh state', () => {
  const { root, call, pull, started } = setup()
  call('omnis_swarm_init', { name: 'Feed', topology: 'mesh' })
  const first = pull()
  assert.ok(first.kind === 'state')
  for (let i = 0; i < 501; i++) appendEvent(root, started(1 + i / 1000, `a${i}`))
  const r = pull({ since: first.offset, swarm: 'feed' })
  assert.ok(r.kind === 'state')
  assert.ok(Object.keys(r.state.agents).length >= 501)
})

test('a replaced, shorter log answers a fresh state', () => {
  const { root, call, pull, started } = setup()
  call('omnis_swarm_init', { name: 'Feed', topology: 'mesh' })
  for (let i = 0; i < 5; i++) appendEvent(root, started(1 + i, `a${i}`))
  const first = pull()
  assert.ok(first.kind === 'state')
  const file = swarmLogPath(root, 'feed')
  writeFileSync(file, `${readFileSync(file, 'utf8').split('\n')[0]}\n`)
  assert.equal(pull({ since: first.offset, swarm: 'feed' }).kind, 'state')
})

test('an ended swarm stays readable by its hint', () => {
  const { call, pull } = setup()
  call('omnis_swarm_init', { name: 'Feed', topology: 'mesh' })
  call('omnis_swarm_end', { outcome: 'done' })
  assert.deepEqual(pull(), { v: 1, kind: 'none' })
  const r = pull({ swarm: 'feed' })
  assert.ok(r.kind === 'state')
  assert.notEqual(r.state.swarm.endedAt, null)
})

test('bad input is refused with an InputError', () => {
  const { feed } = setup()
  for (const args of [{ since: -1 }, { since: 1.5 }, { since: '3' }, { swarm: 'Bad!' }, { swarm: 'nul' }, { swarm: 'x'.repeat(65) }]) {
    assert.throws(() => feed.handler(args), InputError, JSON.stringify(args))
  }
})

test('a failure inside answers a fixed message that names no path', () => {
  const { root, feed } = setup(r => new Session(r, () => { throw new Error('C:\\secret\\path') }))
  writeCurrent(root, 'x')
  assert.throws(() => feed.handler({}), (err: unknown) =>
    err instanceof Error && !(err instanceof InputError) && /Could not read the swarm files/.test(err.message) && !/secret/.test(err.message))
})
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test tests/core/feed-reply.test.ts tests/mcp/feed.test.ts`
Expected: FAIL with `Cannot find module` for `src/core/feed-reply.ts`.

- [ ] **Step 3: Write `src/core/feed-reply.ts`**

```ts
/** The omnis_feed reply: what the MCP server sends the pane, and the pane's check of it. Pure and mod-safe. */
import { isValidSwarmId, parseLine, type SwarmEvent } from './events.ts'
import type { SwarmState } from './fold.ts'
import { isSwarmState } from './state-check.ts'

export const FEED_VERSION = 1
/** The most events one reply carries; further behind than this, the server answers a fresh state. */
export const FEED_MAX_EVENTS = 500

export type FeedReply =
  | { v: 1; kind: 'none' }
  | { v: 1; kind: 'state'; swarm: string; offset: number; state: SwarmState }
  | { v: 1; kind: 'events'; swarm: string; offset: number; events: SwarmEvent[]; bad: number }

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const isCount = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0

/** Null unless `text` is a well-formed reply. Every event is checked again as a log line would be. */
export function parseFeedReply(text: string): FeedReply | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObj(raw) || raw.v !== FEED_VERSION) return null
  if (raw.kind === 'none') return { v: 1, kind: 'none' }
  if (typeof raw.swarm !== 'string' || !isValidSwarmId(raw.swarm) || !isCount(raw.offset)) return null
  const swarm = raw.swarm
  if (raw.kind === 'state') {
    return isSwarmState(raw.state, swarm) ? { v: 1, kind: 'state', swarm, offset: raw.offset, state: raw.state } : null
  }
  if (raw.kind !== 'events' || !Array.isArray(raw.events) || raw.events.length > FEED_MAX_EVENTS || !isCount(raw.bad)) return null
  const events: SwarmEvent[] = []
  for (const item of raw.events) {
    const parsed = parseLine(JSON.stringify(item))
    if (!parsed.ok || parsed.event.swarm !== swarm) return null
    events.push(parsed.event)
  }
  return { v: 1, kind: 'events', swarm, offset: raw.offset, events, bad: raw.bad }
}
```

- [ ] **Step 4: Write `src/mcp/tools/feed.ts`**

```ts
/**
 * omnis_feed: how the pane reads the swarm. Internal: the mod refuses the model's calls at tool.check and defers the
 * tool. It only reads and never adopts a swarm, so pulling it cannot change which swarm this session owns.
 */
import { existsSync } from 'node:fs'
import { isValidSwarmId } from '../../core/events.ts'
import { FEED_MAX_EVENTS, type FeedReply } from '../../core/feed-reply.ts'
import { readCurrent, readEvents, sortEvents, swarmLogPath } from '../../core/log.ts'
import type { Loaded } from '../../core/snapshot.ts'
import type { Args, ToolDef } from '../protocol.ts'
import type { ToolContext } from '../tools.ts'
import { InputError, optString } from '../validate.ts'

const SWARM_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const FAILED = 'Could not read the swarm files in .omnis-swarm/ (see the server log).'

function optOffset(args: Args, key: string): number | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new InputError(`${key} must be a whole number of at least 0`)
  return value
}

export function createFeedTools(ctx: ToolContext): ToolDef[] {
  const { root, session } = ctx

  /** This server's live swarm, else the live current one, else the hinted one if its log exists, else an ended current. */
  const pick = (hint: string | undefined): string | null => {
    const live = session.mySwarm(false)
    if (live !== null) return live
    const current = readCurrent(root)
    if (current !== null && !session.hasEnded(current)) return current
    if (hint !== undefined && existsSync(swarmLogPath(root, hint))) return hint
    return current
  }
  const answer = (reply: FeedReply) => ({ text: JSON.stringify(reply) })
  const fresh = (id: string, held: Loaded) => answer({ v: 1, kind: 'state', swarm: id, offset: held.offset, state: held.state })

  const tool: ToolDef = {
    name: 'omnis_feed',
    description: 'Internal to the OmnisSwarm pane, which reads swarm state with it. Not for the model: calls from the model are refused.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'integer', minimum: 0, description: 'The offset from the last reply; 0 for the whole state.' },
        swarm: { type: 'string', pattern: SWARM_ID.source, description: 'The swarm the last reply was about.' },
      },
      additionalProperties: false,
    },
    handler: args => {
      const since = optOffset(args, 'since') ?? 0
      const hint = optString(args, 'swarm', 64, SWARM_ID)
      if (hint !== undefined && !isValidSwarmId(hint)) throw new InputError('swarm is not a valid swarm id')
      try {
        const id = pick(hint)
        if (id === null) return answer({ v: 1, kind: 'none' })
        const held = session.state(id)
        if (hint !== id || since === 0 || since > held.offset) return fresh(id, held)
        if (since === held.offset) return answer({ v: 1, kind: 'events', swarm: id, offset: since, events: [], bad: 0 })
        const read = readEvents(swarmLogPath(root, id), since)
        if (read.reset || read.events.length > FEED_MAX_EVENTS || read.offset < held.offset) return fresh(id, session.state(id))
        return answer({ v: 1, kind: 'events', swarm: id, offset: read.offset, events: sortEvents(read.events), bad: read.bad })
      } catch (err) {
        // The detail may hold paths, so it goes to stderr only.
        process.stderr.write(`omnis: omnis_feed failed: ${err instanceof Error ? err.message : String(err)}\n`)
        throw new Error(FAILED)
      }
    },
  }
  return [tool]
}
```

- [ ] **Step 5: Run the tests to make sure they pass**

Run: `node --test tests/core/feed-reply.test.ts tests/mcp/feed.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 6: Run the gate**

Run: `npm run check`
Expected: both typechecks clean and every test passes (14 more than before this task).

- [ ] **Step 7: Commit**

```bash
git add src/core/feed-reply.ts src/mcp/tools/feed.ts tests/core/feed-reply.test.ts tests/mcp/feed.test.ts
git commit -m "Add omnis_feed, the pane's read of the folded swarm state, and the reply check the pane uses"
```

---
### Task 4: Render foundations: tokens, colour, grid, formatting, fixture, mod-safe check  *(wave 1, serial)*

**Files:**
- Create: `src/render/types.ts`, `src/render/tokens.ts`, `src/render/color.ts`, `src/render/grid.ts`, `src/render/format.ts`, `tests/fixtures/swarm-five.ts`
- Test: `tests/render/tokens.test.ts`, `tests/render/color.test.ts`, `tests/render/grid.test.ts`, `tests/render/format.test.ts`, `tests/render/mod-safe.test.ts`

**Interfaces:**
- Consumes: `docs/design/pane.md` Tokens table (Task 1) for every value in `tokens.ts`; Task 2's recommendation for `FPS.busy` and `PAIR_BUDGET` if it has arrived. Where `pane.md` gives a value that differs from the code below, **use `pane.md`'s value**; never rename a token. `ToolKind`, `makeEvent`, `SwarmEvent`, `EventData`, `EventType`, `Topology` from `core/events.ts`; `AgentStatus` from `core/stats.ts`.
- Produces (every later task codes against these names):
  - `types.ts`: `Point { x; y }`, `Rect { x; y; w; h }`, `Size { columns; rows }`, `SizeStep = 'full' | 'noTimeline' | 'compactSpotlight' | 'tree' | 'summary'`, `Pulse { agent; kind: ToolKind; at; isError }`, `Spot { id; since }`, `Tween { from: Readonly<Record<string, Point>>; at }`, `View { pinned: string | null; spotlight: Spot | null; pulses: readonly Pulse[]; lagMs: number; tween: Tween | null }`, `Chip { id; label; color; pinned }`, `Frame { step; top: Grid; bottom: Grid | null; chips: Chip[]; treeKey: string; nodesKey: string; positions: Record<string, Point>; fps: number; spotlight: string | null; alt: string }`, `emptyView(): View`, `rect(x, y, w, h): Rect`.
  - `tokens.ts`: `CANVAS`, `CANVAS_RAISED`, `TEXT`, `ACCENT`, `MODEL`, `ModelFamily`, `STATUS`, `KIND`, `KIND_LETTER`, `LINK`, `FEED_COLOR`, `FEED_MARK`, `GLYPH`, `MOTION`, `FPS`, `GRAPH`, `SIZE`, `SPOTLIGHT_HOLD_MS`, `PULL_MS`, `RASTER_MAX`, `PAIR_BUDGET`, `modelFamily(model: string | null): ModelFamily`, `modelColor(model: string | null): number`, `statusGlyph(status: AgentStatus, placeholder?: boolean): string`, `contextColor(fill: number): number`.
  - `color.ts`: `DEFAULT = 0x01000000`, `clamp01(t)`, `rgb(r, g, b)`, `mix(a, b, t)`, `scale(c, k)`, `add(base, light, k)`, `desaturate(c, k)`, `hex(c): string`, `luminance(c)`, `contrast(a, b)`, `quantise(t, steps)`.
  - `grid.ts`: `class Grid { columns; rows; cells: Uint32Array; constructor(columns, rows, bg?, fg?); set(x, y, cp, fg, bg?); glyph(x, y); fg(x, y); bg(x, y); fill(x, y, w, h, bg); text(x, y, s, fg, bg?, max?): number; encode(): string; toRaster(key) }`, `safeGlyph(cp): number`, `toBase64(bytes)`, `fromBase64(text)`, `decodeCells(b64, columns, rows): Grid`, `gridText(grid): string[]`, `pairCount(grid): number`, `limitPairs(grid, max): number`, `type Part = readonly [string, number]`, `writeParts(grid, x, y, parts, maxX, bg?): number`, `writeRight(grid, y, parts, minX, maxX, bg?): number`, `cp(ch: string): number`.
  - `format.ts`: `fmtTokens(n)`, `fmtUsd(x: number | null)`, `fmtDuration(ms)`, `fmtAge(ms)`, `fmtPercent(fraction: number | null)`, `clipText(s, max)`.
  - `tests/fixtures/swarm-five.ts`: `FIVE_T0`, `FIVE_SWARM = 'auth-refactor'`, `FIVE_AT = { mid, idle }`, `fiveAgentEvents(topology?: Topology): SwarmEvent[]`, `quietEvents(): SwarmEvent[]`.

- [ ] **Step 1: Write the failing tests**

`tests/render/color.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { add, clamp01, contrast, desaturate, hex, mix, quantise, rgb, scale } from '../../src/render/color.ts'

test('mix blends channel by channel and clamps t', () => {
  assert.equal(mix(0x000000, 0xffffff, 0.5), 0x808080)
  assert.equal(mix(0x123456, 0xabcdef, 0), 0x123456)
  assert.equal(mix(0x123456, 0xabcdef, 1), 0xabcdef)
  assert.equal(mix(0x000000, 0xff0000, 2), 0xff0000)
})

test('scale, add and desaturate', () => {
  assert.equal(scale(0x808080, 0.5), 0x404040)
  assert.equal(add(0x101010, 0xffffff, 1), 0xffffff)
  assert.equal(add(0x101010, 0x204060, 0.5), 0x203040)
  assert.equal(desaturate(0xff0000, 1), 0x4c4c4c)
  assert.equal(rgb(300, -5, 127.6), 0xff0080)
})

test('hex, contrast, quantise and clamp01', () => {
  assert.equal(hex(0x0b0f17), '#0b0f17')
  assert.ok(Math.abs(contrast(0xffffff, 0x000000) - 21) < 0.01)
  assert.equal(contrast(0x000000, 0xffffff), contrast(0xffffff, 0x000000))
  assert.equal(quantise(0.49, 3), 0.5)
  assert.equal(quantise(0.2, 3), 0)
  assert.equal(clamp01(Number.NaN), 0)
  assert.equal(clamp01(7), 1)
})
```

`tests/render/grid.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT } from '../../src/render/color.ts'
import {
  Grid, decodeCells, fromBase64, gridText, limitPairs, pairCount, safeGlyph, toBase64, writeParts, writeRight,
} from '../../src/render/grid.ts'

test('a new grid is blank, in the terminal colours unless told otherwise', () => {
  const g = new Grid(3, 2)
  assert.deepEqual(gridText(g), ['   ', '   '])
  assert.equal(g.fg(0, 0), DEFAULT)
  assert.equal(new Grid(2, 1, 0x112233).bg(1, 0), 0x112233)
})

test('set writes inside the grid and ignores anything outside it', () => {
  const g = new Grid(2, 2)
  g.set(1, 1, 0x41, 0xff0000, 0x00ff00)
  g.set(5, 5, 0x42, 0xff0000)
  g.set(-1, 0, 0x42, 0xff0000)
  assert.equal(g.glyph(1, 1), 0x41)
  assert.equal(g.fg(1, 1), 0xff0000)
  assert.equal(g.bg(1, 1), 0x00ff00)
  assert.deepEqual(gridText(g), ['  ', ' A'])
})

test('safeGlyph keeps printable width-1 BMP characters and replaces the rest with ?', () => {
  for (const ok of [0x41, 0x20, 0x2580, 0x28ff, 0x25b6, 0x2713, 0x2715, 0x25cc, 0x26a0, 0x2588]) assert.equal(safeGlyph(ok), ok, ok.toString(16))
  for (const bad of [0x07, 0x7f, 0x9b, 0x0301, 0x200b, 0x202e, 0xd800, 0xe000, 0x4e2d, 0xac00, 0xff21, 0x26a1, 0x231a, 0xfe0f, 0x1f600, -1, 1.5]) {
    assert.equal(safeGlyph(bad), 0x3f, bad.toString(16))
  }
})

test('text writes code points, clips at the edge and at max, and makes unsafe ones ?', () => {
  const g = new Grid(6, 1)
  assert.equal(g.text(0, 0, 'ab😀c\u0007d', 0xffffff), 6)
  assert.deepEqual(gridText(g), ['ab?c?d'])
  const h = new Grid(4, 1)
  assert.equal(h.text(1, 0, 'hello', 0xffffff), 3)
  assert.equal(h.text(0, 0, 'xyz', 0xffffff, undefined, 2), 2)
  assert.deepEqual(gridText(h), ['xyel'])
})

test('base64 matches the standard alphabet and round-trips', () => {
  assert.equal(toBase64(Uint8Array.of(0x4d, 0x61, 0x6e)), 'TWFu')
  assert.equal(toBase64(Uint8Array.of(0x4d)), 'TQ==')
  assert.equal(toBase64(Uint8Array.of(0x4d, 0x61)), 'TWE=')
  assert.deepEqual([...fromBase64('TWE=')], [0x4d, 0x61])
  const bytes = Uint8Array.from({ length: 257 }, (_, i) => (i * 37) & 255)
  assert.equal(toBase64(bytes), Buffer.from(bytes).toString('base64'))
  assert.deepEqual([...fromBase64(toBase64(bytes))], [...bytes])
})

test('encode packs little-endian [codePoint, fg, bg] triplets as the Raster expects', () => {
  const g = new Grid(1, 1)
  g.set(0, 0, 0x2588, 0xff8800, DEFAULT)
  const expected = Buffer.from(new Uint8Array(Uint32Array.of(0x2588, 0xff8800, 0x01000000).buffer)).toString('base64')
  assert.equal(g.encode(), expected)
  assert.deepEqual(g.toRaster('k'), { key: 'k', columns: 1, rows: 1, cells: expected })
})

test('decodeCells rebuilds the grid and refuses the wrong size', () => {
  const g = new Grid(3, 2, 0x101010)
  g.text(0, 1, 'hi▀', 0xabcdef)
  const back = decodeCells(g.encode(), 3, 2)
  assert.deepEqual([...back.cells], [...g.cells])
  assert.throws(() => decodeCells(g.encode(), 2, 2), RangeError)
})

test('pairCount counts distinct fg/bg pairs and limitPairs brings a grid under budget', () => {
  const g = new Grid(2, 1)
  g.set(1, 0, 0x41, 0xff0000, 0x000000)
  assert.equal(pairCount(g), 2)
  assert.equal(limitPairs(g, 10), 0)
  const big = new Grid(40, 40, 0x0b0f17)
  for (let i = 0; i < 1600; i++) big.set(i % 40, Math.floor(i / 40), 0x2580, (i * 9973) & 0xffffff)
  assert.ok(pairCount(big) > 1000)
  assert.ok(limitPairs(big, 1000) > 0)
  assert.ok(pairCount(big) <= 1000)
})

test('writeParts writes coloured runs left to right, writeRight aligns them to the right', () => {
  const g = new Grid(10, 1)
  const next = writeParts(g, 0, 0, [['ab', 0xff0000], ['cd', 0x00ff00]], 10)
  assert.equal(next, 4)
  assert.equal(g.fg(2, 0), 0x00ff00)
  writeRight(g, 0, [['xy', 0x0000ff]], 0, 10)
  assert.deepEqual(gridText(g), ['abcd    xy'])
  assert.equal(writeParts(g, 8, 0, [['longer', 0xffffff]], 10), 10)
})
```

`tests/render/format.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clipText, fmtAge, fmtDuration, fmtPercent, fmtTokens, fmtUsd } from '../../src/render/format.ts'

test('fmtTokens', () => {
  assert.equal(fmtTokens(0), '0')
  assert.equal(fmtTokens(950), '950')
  assert.equal(fmtTokens(1234), '1.2k')
  assert.equal(fmtTokens(34_000), '34k')
  assert.equal(fmtTokens(1_200_000), '1.2M')
  assert.equal(fmtTokens(34_000_000), '34M')
  assert.equal(fmtTokens(Number.NaN), '0')
})

test('fmtUsd is always approximate and shows unknown as a dash', () => {
  assert.equal(fmtUsd(null), '–')
  assert.equal(fmtUsd(0.0042), '≈$0.004')
  assert.equal(fmtUsd(1.234), '≈$1.23')
  assert.equal(fmtUsd(250.4), '≈$250')
})

test('fmtDuration, fmtAge and fmtPercent', () => {
  assert.equal(fmtDuration(45_000), '45s')
  assert.equal(fmtDuration(185_000), '3m05s')
  assert.equal(fmtDuration(3_720_000), '1h02m')
  assert.equal(fmtAge(500), '0s')
  assert.equal(fmtAge(12_000), '12s')
  assert.equal(fmtAge(120_000), '2m')
  assert.equal(fmtAge(7_200_000), '2h')
  assert.equal(fmtPercent(null), '–')
  assert.equal(fmtPercent(0.344), '34%')
})

test('clipText cuts by code point and ends in an ellipsis', () => {
  assert.equal(clipText('abcdef', 4), 'abc…')
  assert.equal(clipText('ab', 4), 'ab')
  assert.equal(clipText('abc', 0), '')
  assert.equal(clipText('😀😀😀', 2), '😀…')
})
```

`tests/render/tokens.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contrast } from '../../src/render/color.ts'
import { safeGlyph } from '../../src/render/grid.ts'
import {
  CANVAS, FEED_COLOR, FEED_MARK, GLYPH, KIND, MODEL, MOTION, PAIR_BUDGET, PULL_MS, STATUS, TEXT, contextColor, modelColor,
  modelFamily, statusGlyph,
} from '../../src/render/tokens.ts'

test('text tokens read at 4.5:1 on the canvas, and every signal colour at 3:1', () => {
  for (const c of [TEXT.primary, TEXT.dim]) assert.ok(contrast(c, CANVAS) >= 4.5, c.toString(16))
  for (const c of [...Object.values(MODEL), ...Object.values(STATUS), ...Object.values(KIND), ...Object.values(FEED_COLOR)]) {
    assert.ok(contrast(c, CANVAS) >= 3, c.toString(16))
  }
})

test('every glyph is one code point the Raster accepts', () => {
  for (const g of [...Object.values(GLYPH), ...Object.values(FEED_MARK)]) {
    assert.equal([...g].length, 1, g)
    assert.equal(safeGlyph(g.codePointAt(0)!), g.codePointAt(0), g)
  }
})

test('model families and colours', () => {
  assert.equal(modelFamily('claude-opus-5-5'), 'opus')
  assert.equal(modelFamily('claude-sonnet-4-6'), 'sonnet')
  assert.equal(modelFamily('claude-haiku-5-5'), 'haiku')
  assert.equal(modelFamily('claude-fable-5-1'), 'fable')
  assert.equal(modelFamily('claude-mythos-5-1'), 'fable')
  assert.equal(modelFamily('gpt-x'), 'other')
  assert.equal(modelFamily(null), 'other')
  assert.equal(modelColor('claude-opus-5-5'), MODEL.opus)
})

test('status glyphs, context colours, timings and budgets', () => {
  assert.equal(statusGlyph('running'), GLYPH.running)
  assert.equal(statusGlyph('failed'), GLYPH.failed)
  assert.equal(statusGlyph('waiting', true), GLYPH.unknown)
  assert.equal(contextColor(0.95), STATUS.failed)
  assert.equal(contextColor(0.75), STATUS.warn)
  assert.equal(contextColor(0.3), TEXT.dim)
  for (const v of Object.values(MOTION)) assert.ok(v > 0)
  assert.ok(PULL_MS >= 250, 'at most 4 pulls a second')
  assert.ok(PAIR_BUDGET.top + PAIR_BUDGET.bottom <= 1024 || (PAIR_BUDGET.top <= 1024 && PAIR_BUDGET.bottom <= 1024))
})
```

`tests/render/mod-safe.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// The pane runs inside Claude Code's mod sandbox: web APIs only. This walks every render and pane file and
// everything they import, and fails on anything that sandbox does not have.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BANNED: Array<[string, RegExp]> = [
  ["from 'node:", /from\s+['"]node:/],
  ['require(', /\brequire\s*\(/],
  ['Buffer', /\bBuffer\b/],
  ['process.', /\bprocess\./],
  ['__dirname', /__dirname/],
  ['fetch', /\bfetch\b/],
  ['queueMicrotask', /\bqueueMicrotask\b/],
  ['setImmediate', /\bsetImmediate\b/],
  ['import(', /\bimport\s*\(/],
]

function entries(): string[] {
  const out: string[] = []
  const add = (dir: string, keep: (name: string) => boolean) => {
    const full = join(ROOT, dir)
    if (!existsSync(full)) return
    for (const name of readdirSync(full)) if (name.endsWith('.ts') && !name.endsWith('.test.ts') && keep(name)) out.push(join(full, name))
  }
  add('src/render', () => true)
  add('src/mod', name => name.startsWith('pane'))
  return out
}

test('render and pane files, and everything they import, are mod-safe', () => {
  const queue = entries()
  assert.ok(queue.length > 0, 'found the render files')
  const seen = new Set<string>()
  while (queue.length > 0) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    const name = relative(ROOT, file)
    const text = readFileSync(file, 'utf8')
    for (const [label, re] of BANNED) assert.equal(re.test(text), false, `${name} contains ${label}`)
    for (const m of text.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)) {
      const spec = m[1]!
      if (spec === 'claude-code') {
        assert.ok(name.startsWith(`src${sep}mod${sep}`), `${name} imports claude-code, which only mod files may`)
        continue
      }
      assert.ok(spec.startsWith('./') || spec.startsWith('../'), `${name} imports '${spec}'; only relative imports are allowed`)
      const target = resolve(dirname(file), spec)
      assert.ok(existsSync(target), `${name} imports '${spec}', which does not exist`)
      assert.ok(!relative(ROOT, target).startsWith('..'), `${name} imports '${spec}' from outside the plugin`)
      queue.push(target)
    }
  }
})
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test tests/render/color.test.ts tests/render/grid.test.ts tests/render/format.test.ts tests/render/tokens.test.ts tests/render/mod-safe.test.ts`
Expected: FAIL, `Cannot find module` for the `src/render` files (mod-safe fails with "found the render files").

- [ ] **Step 3: Write `src/render/types.ts`**

```ts
/** Shapes shared by the render units and the pane. Pure types, plus two tiny constructors. */
import type { ToolKind } from '../core/events.ts'
import type { Grid } from './grid.ts'

/** A position on the graph's pixel canvas: one pixel is one cell wide and half a cell tall. */
export type Point = { x: number; y: number }
/** A box of cells. */
export type Rect = { x: number; y: number; w: number; h: number }
export type Size = { columns: number; rows: number }
export type SizeStep = 'full' | 'noTimeline' | 'compactSpotlight' | 'tree' | 'summary'
/** A tool start, or a tool end that failed, as the pane saw it arrive. */
export type Pulse = { agent: string; kind: ToolKind; at: number; isError: boolean }
/** Who the spotlight is on, and since when (it holds each agent for SPOTLIGHT_HOLD_MS). */
export type Spot = { id: string; since: number }
/** Node positions to glide from, after the layout changed at `at`. */
export type Tween = { from: Readonly<Record<string, Point>>; at: number }

/** What the pane knows beyond the swarm state: the pin, the spotlight, recent pulses, how late events arrive, the glide. */
export type View = {
  pinned: string | null
  spotlight: Spot | null
  pulses: readonly Pulse[]
  lagMs: number
  tween: Tween | null
}

export type Chip = { id: string; label: string; color: number; pinned: boolean }

/**
 * One drawn frame. `top` is the header and graph, `bottom` the spotlight, timeline and feed, with the chip row between.
 * `treeKey` changes only when the element tree must be redrawn; `nodesKey` when the node set or layout changed.
 */
export type Frame = {
  step: SizeStep
  top: Grid
  bottom: Grid | null
  chips: Chip[]
  treeKey: string
  nodesKey: string
  positions: Record<string, Point>
  fps: number
  spotlight: string | null
  /** The one-line summary: the Svg's words for readers that cannot see it. */
  alt: string
}

export const emptyView = (): View => ({ pinned: null, spotlight: null, pulses: [], lagMs: 0, tween: null })

export const rect = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w: Math.max(0, w), h: Math.max(0, h) })
```

- [ ] **Step 4: Write `src/render/color.ts`**

```ts
/** Colour maths on 0xRRGGBB numbers. There is no alpha in a terminal cell: fades blend toward the canvas. Pure. */

/** The terminal's own colour (foreground or background), as the Raster encodes it. Never blend it. */
export const DEFAULT = 0x01000000

export const clamp01 = (t: number): number => (Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0)

const byte = (v: number): number => Math.max(0, Math.min(255, Math.round(v)))
const ch = (c: number, shift: number): number => (c >>> shift) & 255

export const rgb = (r: number, g: number, b: number): number => ((byte(r) << 16) | (byte(g) << 8) | byte(b)) >>> 0

export function mix(a: number, b: number, t: number): number {
  const k = clamp01(t)
  return rgb(ch(a, 16) * (1 - k) + ch(b, 16) * k, ch(a, 8) * (1 - k) + ch(b, 8) * k, ch(a, 0) * (1 - k) + ch(b, 0) * k)
}

export const scale = (c: number, k: number): number => rgb(ch(c, 16) * k, ch(c, 8) * k, ch(c, 0) * k)

/** Light adds: the base keeps its colour and the light is laid over it, so a glow stays bright rather than muddy. */
export const add = (base: number, light: number, k: number): number =>
  rgb(ch(base, 16) + ch(light, 16) * k, ch(base, 8) + ch(light, 8) * k, ch(base, 0) + ch(light, 0) * k)

export function desaturate(c: number, k: number): number {
  const grey = 0.299 * ch(c, 16) + 0.587 * ch(c, 8) + 0.114 * ch(c, 0)
  return mix(c, rgb(grey, grey, grey), k)
}

export const hex = (c: number): string => `#${(c & 0xffffff).toString(16).padStart(6, '0')}`

export function luminance(c: number): number {
  const lin = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(ch(c, 16)) + 0.7152 * lin(ch(c, 8)) + 0.0722 * lin(ch(c, 0))
}

/** WCAG contrast ratio, 1 to 21. */
export function contrast(a: number, b: number): number {
  const x = luminance(a)
  const y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

/** Snaps t to one of `steps` levels, so ramps reuse a few colours and a frame stays under its pair budget. */
export const quantise = (t: number, steps: number): number =>
  steps <= 1 ? clamp01(t) : Math.round(clamp01(t) * (steps - 1)) / (steps - 1)
```

- [ ] **Step 5: Write `src/render/grid.ts`**

```ts
/**
 * A cell grid for the terminal's Raster: per cell a glyph, a 24-bit foreground and a background, packed as base64 of
 * little-endian u32 triplets [codePoint, fg, bg], row-major. Every glyph passes safeGlyph, because one bad cell makes
 * the engine refuse the whole tree. Base64 is done by hand so this runs in a mod and in Node alike. Pure.
 */
import { DEFAULT, rgb } from './color.ts'

const SPACE = 0x20
const REPLACEMENT = 0x3f
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** East Asian Wide and Fullwidth ranges in the BMP, and the BMP characters drawn as emoji by default. */
const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0x303e],
  [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
]
/** Marks (zero width), controls, format characters, surrogates, private use, unassigned, line and paragraph separators. */
const NOT_A_CELL = /[\p{M}\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u

/** The code point if the Raster accepts it (printable, one cell wide, in the BMP), otherwise '?'. */
export function safeGlyph(cp: number): number {
  if (!Number.isInteger(cp) || cp < SPACE || cp > 0xffff) return REPLACEMENT
  if (cp >= 0xd800 && cp <= 0xdfff) return REPLACEMENT
  if (NOT_A_CELL.test(String.fromCharCode(cp))) return REPLACEMENT
  for (const [lo, hi] of WIDE) if (cp >= lo && cp <= hi) return REPLACEMENT
  return cp
}

/** The first code point of `ch`. */
export const cp = (ch: string): number => ch.codePointAt(0) ?? SPACE

export class Grid {
  readonly columns: number
  readonly rows: number
  readonly cells: Uint32Array

  constructor(columns: number, rows: number, bg: number = DEFAULT, fg: number = DEFAULT) {
    this.columns = Math.max(1, Math.floor(columns))
    this.rows = Math.max(1, Math.floor(rows))
    this.cells = new Uint32Array(this.columns * this.rows * 3)
    for (let i = 0; i < this.columns * this.rows; i++) {
      this.cells[i * 3] = SPACE
      this.cells[i * 3 + 1] = fg >>> 0
      this.cells[i * 3 + 2] = bg >>> 0
    }
  }

  #at(x: number, y: number): number {
    const cx = Math.floor(x)
    const cy = Math.floor(y)
    return cx < 0 || cy < 0 || cx >= this.columns || cy >= this.rows ? -1 : (cy * this.columns + cx) * 3
  }

  /** Writes one cell. Leaves the background as it is when `bg` is not given. */
  set(x: number, y: number, codePoint: number, fg: number, bg?: number): void {
    const at = this.#at(x, y)
    if (at < 0) return
    this.cells[at] = safeGlyph(codePoint)
    this.cells[at + 1] = fg >>> 0
    if (bg !== undefined) this.cells[at + 2] = bg >>> 0
  }

  glyph(x: number, y: number): number {
    const at = this.#at(x, y)
    return at < 0 ? SPACE : this.cells[at]!
  }

  fg(x: number, y: number): number {
    const at = this.#at(x, y)
    return at < 0 ? DEFAULT : this.cells[at + 1]!
  }

  bg(x: number, y: number): number {
    const at = this.#at(x, y)
    return at < 0 ? DEFAULT : this.cells[at + 2]!
  }

  /** Blanks a box of cells to `bg`. */
  fill(x: number, y: number, w: number, h: number, bg: number): void {
    for (let cy = y; cy < y + h; cy++) for (let cx = x; cx < x + w; cx++) this.set(cx, cy, SPACE, bg, bg)
  }

  /** Writes text left to right from (x, y): at most `max` cells and never past the edge. Returns the cells written. */
  text(x: number, y: number, s: string, fg: number, bg?: number, max = Number.POSITIVE_INFINITY): number {
    let n = 0
    for (const ch of s) {
      if (n >= max || x + n >= this.columns) break
      this.set(x + n, y, cp(ch), fg, bg)
      n++
    }
    return n
  }

  /** The cells as the Raster's base64. Uint32Array is little-endian on every platform Claude Code runs on. */
  encode(): string {
    return toBase64(new Uint8Array(this.cells.buffer, this.cells.byteOffset, this.cells.byteLength))
  }

  toRaster(key: string): { key: string; columns: number; rows: number; cells: string } {
    return { key, columns: this.columns, rows: this.rows, cells: this.encode() }
  }
}

export function toBase64(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!
  }
  if (bytes.length - i === 1) {
    const n = bytes[i]! << 16
    out += `${B64[(n >> 18) & 63]}${B64[(n >> 12) & 63]}==`
  } else if (bytes.length - i === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8)
    out += `${B64[(n >> 18) & 63]}${B64[(n >> 12) & 63]}${B64[(n >> 6) & 63]}=`
  }
  return out
}

export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let acc = 0
  let bits = 0
  let o = 0
  for (const ch of clean) {
    const v = B64.indexOf(ch)
    if (v < 0) throw new RangeError('not base64')
    acc = ((acc << 6) | v) & 0x3fff
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (acc >> bits) & 255
    }
  }
  return out.subarray(0, o)
}

/** A grid from a Raster's cells, for tests and previews. Throws RangeError when the size does not match. */
export function decodeCells(b64: string, columns: number, rows: number): Grid {
  const bytes = fromBase64(b64)
  if (bytes.length !== columns * rows * 12) throw new RangeError(`cells hold ${bytes.length} bytes, not ${columns * rows * 12}`)
  const words = new Uint32Array(bytes.slice().buffer)
  const grid = new Grid(columns, rows)
  grid.cells.set(words)
  return grid
}

/** Each row's glyphs as a string. */
export function gridText(grid: Grid): string[] {
  const rows: string[] = []
  for (let y = 0; y < grid.rows; y++) {
    let line = ''
    for (let x = 0; x < grid.columns; x++) line += String.fromCodePoint(grid.glyph(x, y))
    rows.push(line)
  }
  return rows
}

export function pairCount(grid: Grid): number {
  const pairs = new Set<number>()
  for (let i = 0; i < grid.columns * grid.rows; i++) pairs.add(grid.cells[i * 3 + 1]! * 0x2000000 + grid.cells[i * 3 + 2]!)
  return pairs.size
}

/**
 * Coarsens colours, one more low bit per channel each round, until the grid holds at most `max` fg/bg pairs.
 * Returns how many bits it dropped (0 when the grid was already under budget). At 7 bits there are at most 9 colours.
 */
export function limitPairs(grid: Grid, max: number): number {
  for (let drop = 0; drop <= 7; drop++) {
    if (drop > 0) {
      const step = 1 << drop
      const snap = (v: number) => Math.min(255, Math.round(v / step) * step)
      for (let i = 0; i < grid.columns * grid.rows; i++) {
        for (const slot of [i * 3 + 1, i * 3 + 2]) {
          const c = grid.cells[slot]!
          if (c !== DEFAULT) grid.cells[slot] = rgb(snap((c >>> 16) & 255), snap((c >>> 8) & 255), snap(c & 255))
        }
      }
    }
    if (pairCount(grid) <= max) return drop
  }
  return 7
}

/** One coloured run of text. */
export type Part = readonly [text: string, fg: number]

/** Writes parts left to right from x, stopping before maxX. Returns the next free column. */
export function writeParts(grid: Grid, x: number, y: number, parts: readonly Part[], maxX: number, bg?: number): number {
  let cx = x
  for (const [text, fg] of parts) {
    if (cx >= maxX) break
    cx += grid.text(cx, y, text, fg, bg, maxX - cx)
  }
  return cx
}

/** Writes parts so they end just before maxX, never starting left of minX. Returns the column it started at. */
export function writeRight(grid: Grid, y: number, parts: readonly Part[], minX: number, maxX: number, bg?: number): number {
  const width = parts.reduce((n, [text]) => n + [...text].length, 0)
  const start = Math.max(minX, maxX - width)
  writeParts(grid, start, y, parts, maxX, bg)
  return start
}
```

- [ ] **Step 6: Write `src/render/format.ts`**

```ts
/** Short, fixed-width number formats for the pane. Every money figure is approximate and says so. Pure. */

export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  const r = Math.round(n)
  if (r < 1000) return String(r)
  if (r < 10_000) return `${(r / 1000).toFixed(1)}k`
  if (r < 1_000_000) return `${Math.round(r / 1000)}k`
  if (r < 10_000_000) return `${(r / 1_000_000).toFixed(1)}M`
  return `${Math.round(r / 1_000_000)}M`
}

export function fmtUsd(x: number | null): string {
  if (x === null || !Number.isFinite(x)) return '–'
  if (x < 0.01) return `≈$${x.toFixed(3)}`
  if (x < 100) return `≈$${x.toFixed(2)}`
  return `≈$${Math.round(x)}`
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${pad2(s % 60)}s`
  return `${Math.floor(m / 60)}h${pad2(m % 60)}m`
}

/** How long ago, in one unit. */
export function fmtAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`
}

/** A 0..1 fraction as a whole percentage. */
export const fmtPercent = (fraction: number | null): string =>
  fraction === null || !Number.isFinite(fraction) ? '–' : `${Math.round(fraction * 100)}%`

/** At most `max` code points, the last one an ellipsis when cut. */
export function clipText(s: string, max: number): string {
  const chars = Array.from(s)
  if (chars.length <= max) return s
  if (max <= 0) return ''
  return `${chars.slice(0, max - 1).join('')}…`
}
```

- [ ] **Step 7: Write `src/render/tokens.ts` (values from `docs/design/pane.md`)**

```ts
/**
 * Design tokens for the swarm pane: colours, glyphs, motion and size steps. docs/design/pane.md is where these are
 * decided; this file copies its Tokens table. Change a value there first, then here. Pure and mod-safe.
 */
import type { ToolKind } from '../core/events.ts'
import type { AgentStatus } from '../core/stats.ts'

/** The pane paints its own dark canvas, so every colour here is checked against it, on dark and light terminals alike. */
export const CANVAS = 0x0b0f17
export const CANVAS_RAISED = 0x131a26

export const TEXT = { primary: 0xe6edf3, dim: 0x9aa4b2, faint: 0x4a5363 } as const
export const ACCENT = 0xb48cff

/** Model families, Okabe-Ito based, so they stay apart under the common colour-vision deficiencies. */
export const MODEL = { fable: 0xcc79a7, opus: 0x56b4e9, sonnet: 0x2ec4a0, haiku: 0xf0e442, other: 0xa7b0be } as const
export type ModelFamily = keyof typeof MODEL

/** Status colours. Status is never shown by colour alone: each pairs with a GLYPH and a motion. */
export const STATUS = { running: 0x7ee787, waiting: 0x9aa4b2, done: 0x8b98a9, failed: 0xff6b4a, warn: 0xe69f00 } as const

export const KIND: Readonly<Record<ToolKind, number>> = {
  read: 0x7fdbff, edit: 0xffd166, bash: 0xc3a6ff, search: 0x8be9c9, web: 0x9ecbff, agent: 0xff9ec7, other: 0xd0d7de,
}
export const KIND_LETTER: Readonly<Record<ToolKind, string>> = { read: 'r', edit: 'e', bash: 'b', search: 's', web: 'w', agent: 'a', other: 'o' }

export const LINK = { idle: 0x2b3546, active: 0x9ecbff, comet: 0xf5fbff, clash: 0xff6b4a } as const
export const FEED_COLOR = { agent: 0x9aa4b2, message: 0x9ecbff, memory: 0xd2a8ff, task: 0xffb86b } as const
export const FEED_MARK = { agent: '•', message: '›', memory: '+', task: '#' } as const

export const GLYPH = {
  running: '▶', waiting: '◌', done: '✓', failed: '✕', lead: '◆', unknown: '?', stuck: '!', clash: '!', gap: '⚠', dot: '●', pinned: '◉',
} as const

export const MOTION = {
  fadeInMs: 600, ghostMs: 1500, glowPeriodMs: 1600, cometMs: 900, trailMs: 450, trailDots: 6, linkFadeMs: 3000,
  pulseMs: 350, errorPulseMs: 900, clashFlashMs: 4000, clashBlinkMs: 250, tweenMs: 400,
} as const

export const FPS = { busy: 30, glow: 12, min: 4 } as const

/** Graph geometry in canvas pixels (a half-block pixel is about square). */
export const GRAPH = { minRadius: 1.6, maxRadius: 6, glowPx: 2.5, ringPx: 1.2, linkThick: [5, 20], linkBend: 0.18 } as const

export const SIZE = {
  summaryBelowRows: 6, summaryBelowColumns: 30, treeBelowRows: 14, treeBelowColumns: 48, compactBelowRows: 22,
  noTimelineBelowRows: 30, graphShare: 0.55, minGraphRows: 8, spotlightRows: 6, timelineMaxRows: 8, minFeedRows: 2,
} as const

export const SPOTLIGHT_HOLD_MS = 5_000
/** omnis_feed is pulled at most 4 times a second. */
export const PULL_MS = 250
export const RASTER_MAX = { columns: 512, rows: 256 } as const
/** Distinct fg/bg pairs per grid; the terminal paints 1024 at once. */
export const PAIR_BUDGET = { top: 700, bottom: 300 } as const

export function modelFamily(model: string | null): ModelFamily {
  if (model === null) return 'other'
  const m = model.toLowerCase()
  if (m.includes('fable') || m.includes('mythos')) return 'fable'
  if (m.includes('opus')) return 'opus'
  if (m.includes('sonnet')) return 'sonnet'
  if (m.includes('haiku')) return 'haiku'
  return 'other'
}

export const modelColor = (model: string | null): number => MODEL[modelFamily(model)]

export const statusGlyph = (status: AgentStatus, placeholder = false): string => (placeholder ? GLYPH.unknown : GLYPH[status])

/** The context ring and bar: amber from 70%, red from 90%. */
export const contextColor = (fill: number): number => (fill >= 0.9 ? STATUS.failed : fill >= 0.7 ? STATUS.warn : TEXT.dim)
```

- [ ] **Step 8: Write the fixture `tests/fixtures/swarm-five.ts`**

It imports only `src/core/events.ts`, so it stays mod-safe for Task 17's engine test. `tests/fixtures/swarm-five.ts`:

```ts
/**
 * A scripted five-agent swarm (plus the lead and one unknown name) for the render goldens and the pane e2e tests.
 * Mod-safe: it imports only core/events.ts. Times are seconds after FIVE_T0.
 */
import { makeEvent, type EventData, type EventType, type SwarmEvent, type ToolKind, type Topology } from '../../src/core/events.ts'

export const FIVE_T0 = Date.parse('2026-10-21T10:00:00.000Z')
export const FIVE_SWARM = 'auth-refactor'
/** mid: comets in flight and a tool flicker; idle: everything has settled. */
export const FIVE_AT = { mid: FIVE_T0 + 30_000, idle: FIVE_T0 + 400_000 } as const

const MCP_TYPES: readonly string[] = ['swarm.started', 'memory.put', 'task.created', 'task.updated']

function e<K extends EventType>(sec: number, type: K, data: EventData[K], agent?: string): SwarmEvent<K> {
  return makeEvent({
    type, data, swarm: FIVE_SWARM, src: MCP_TYPES.includes(type) ? 'mcp' : 'recorder',
    ...(agent !== undefined && { agent }), now: new Date(FIVE_T0 + Math.round(sec * 1000)),
  })
}
const use = (sec: number, agent: string | undefined, model: string, input: number, output: number, cacheRead = 0, cacheWrite5m = 0) =>
  e(sec, 'agent.usage', { model, input, output, cacheRead, cacheWrite5m, cacheWrite1h: 0 }, agent)
const tool = (sec: number, agent: string, phase: 'start' | 'end', kind: ToolKind, name: string, subject: string, isError = false) =>
  e(sec, 'agent.tool', { phase, tool: name, kind, subject, isError }, agent)
const start = (sec: number, agent: string, name: string, role: string, parent: string, description: string) =>
  e(sec, 'agent.started', { name, role, description, parent }, agent)
const say = (sec: number, from: string | undefined, to: string, summary: string) => e(sec, 'message.sent', { to, summary }, from)

const OPUS = 'claude-opus-5-5'
const SONNET = 'claude-sonnet-5-5'
const HAIKU = 'claude-haiku-5-5'

export function fiveAgentEvents(topology: Topology = 'hierarchical'): SwarmEvent[] {
  return [
    e(0, 'swarm.started', { name: 'auth refactor', topology, goal: 'move sessions to signed tokens', implicit: false }),
    use(0.5, undefined, OPUS, 2000, 400, 0, 30_000),
    start(1, 'a-arch', 'architect', 'system-architect', 'lead', 'Design the token flow'),
    say(1.2, undefined, 'architect', 'design the token flow'),
    use(2, 'a-arch', OPUS, 4000, 900, 0, 42_000),
    tool(3, 'a-arch', 'start', 'read', 'Read', 'src/auth/session.ts'),
    tool(3.4, 'a-arch', 'end', 'read', 'Read', 'src/auth/session.ts'),
    start(5, 'a-cod1', 'coder-1', 'coder', 'a-arch', 'Implement the token issuer'),
    start(5.2, 'a-cod2', 'coder-2', 'coder', 'a-arch', 'Implement the token verifier'),
    say(6, 'a-arch', 'coder-1', 'implement the issuer'),
    say(6.3, 'a-arch', 'coder-2', 'implement the verifier'),
    use(7, 'a-cod1', SONNET, 3000, 1500, 20_000, 8000),
    use(7.5, 'a-cod2', SONNET, 2500, 1200, 20_000, 6000),
    tool(8, 'a-cod1', 'start', 'edit', 'Edit', 'src/auth/token.ts'),
    tool(8.5, 'a-cod1', 'end', 'edit', 'Edit', 'src/auth/token.ts'),
    tool(9, 'a-cod2', 'start', 'edit', 'Edit', 'src/auth/token.ts'),
    tool(9.4, 'a-cod2', 'end', 'edit', 'Edit', 'src/auth/token.ts'),
    start(10, 'a-test', 'tester', 'tester', 'lead', 'Write and run the auth tests'),
    use(10.5, 'a-test', HAIKU, 1500, 600, 0, 4000),
    start(11, 'a-rev', 'reviewer', 'reviewer', 'lead', 'Review the change'),
    use(11.5, 'a-rev', 'claude-mystery-1', 1000, 300),
    tool(12, 'a-test', 'start', 'bash', 'Bash', 'npm test'),
    tool(12.3, 'a-test', 'end', 'bash', 'Bash', 'npm test', true),
    tool(13, 'a-test', 'start', 'bash', 'Bash', 'npm test'),
    tool(13.3, 'a-test', 'end', 'bash', 'Bash', 'npm test', true),
    tool(14, 'a-test', 'start', 'bash', 'Bash', 'npm test'),
    tool(14.3, 'a-test', 'end', 'bash', 'Bash', 'npm test', true),
    e(15, 'memory.put', { key: 'design/auth', bytes: 512, preview: 'tokens signed with ed25519' }, 'architect'),
    e(16, 'task.created', { id: 't1', title: 'Issue tokens', assignee: 'coder-1' }),
    e(16.1, 'task.created', { id: 't2', title: 'Verify tokens', assignee: 'coder-2' }),
    e(17, 'task.updated', { id: 't1', state: 'active' }),
    use(20, 'a-cod2', SONNET, 1000, 800, 30_000, 0),
    say(21, 'a-cod2', 'architect', 'verifier done'),
    e(22, 'agent.finished', { outcome: 'answer', reason: 'answer' }, 'a-cod2'),
    e(23, 'agent.finished', { outcome: 'failed', reason: 'error' }, 'a-rev'),
    say(24, 'a-cod1', 'tester', 'issuer ready for tests'),
    e(25, 'session.measure', { contextTokens: 340_000, contextWindow: 1_000_000, contextPercent: 34, costUsd: 1.2 }),
    say(26, 'a-test', 'main', 'tests are flaky on CI'),
    use(27, 'a-arch', OPUS, 3000, 700, 42_000, 0),
    tool(28, 'a-cod1', 'start', 'edit', 'Edit', 'src/auth/issuer.ts'),
    use(28.5, 'a-cod1', SONNET, 2000, 2200, 28_000, 0),
    say(29.4, 'a-arch', 'coder-1', 'use ed25519 keys'),
    say(29.6, undefined, 'tester', 'rerun with a fixed seed'),
    tool(29.8, 'a-test', 'start', 'read', 'Read', 'tests/auth.test.ts'),
    say(29.9, 'a-arch', 'ghost', 'are you there'),
    e(30, 'task.updated', { id: 't2', state: 'done' }),
  ]
}

/** A small swarm whose last event is at 3.4 s: by FIVE_AT.idle nothing in it moves. */
export const quietEvents = (): SwarmEvent[] => fiveAgentEvents().slice(0, 7)
```

- [ ] **Step 9: Run the tests to make sure they pass**

Run: `node --test tests/render/color.test.ts tests/render/grid.test.ts tests/render/format.test.ts tests/render/tokens.test.ts tests/render/mod-safe.test.ts`
Expected: PASS, 21 tests. If a contrast check fails after copying `pane.md`'s values, stop and ask the designer (the doc's own table must already meet it).

- [ ] **Step 10: Run the gate**

Run: `npm run check`
Expected: typecheck clean, every test passes.

- [ ] **Step 11: Commit**

```bash
git add src/render/types.ts src/render/tokens.ts src/render/color.ts src/render/grid.ts src/render/format.ts tests/fixtures/swarm-five.ts tests/render/color.test.ts tests/render/grid.test.ts tests/render/format.test.ts tests/render/tokens.test.ts tests/render/mod-safe.test.ts
git commit -m "Add the pane's render foundations: design tokens, colour maths, the Raster cell grid, number formats and a five-agent fixture"
```

---
### Task 5: Pixel canvas, braille dots and motion maths  *(wave 2, parallel)*

**Files:**
- Create: `src/render/canvas.ts`, `src/render/fx.ts`
- Test: `tests/render/canvas.test.ts`, `tests/render/fx.test.ts`

**Interfaces:**
- Consumes: `mix`, `add`, `clamp01` (`color.ts`); `Grid` (`grid.ts`); `Point`, `Rect`, `Tween` (`types.ts`); `MOTION` (`tokens.ts`).
- Produces:
  - `canvas.ts`: `class Pixels { width; height; data: Uint32Array; constructor(width, height, bg); get(x, y): number; set(x, y, c); blend(x, y, c, t); light(x, y, c, k); line(a: Point, b: Point, c, t?) }`, `class Dots { columns; rows; bits: Uint8Array; colors: Uint32Array; constructor(columns, rows); width; height; dot(x, y, c); line(a: Point, b: Point, c, dash?) }`, `toDots(p: Point): Point`, `compose(grid: Grid, area: Rect, pixels: Pixels, dots: Dots): void`.
  - `fx.ts`: `easeOutCubic(t)`, `easeInOut(t)`, `fadeIn(startedAt, now)`, `ghost(finishedAt: number | null, now)`, `glow(now, seed)`, `flash(at, now, ms)`, `blink(now, ms): boolean`, `hashUnit(s): number`, `lerpPoint(a, b, t)`, `arc(a, b, bend): (t: number) => Point`, `type Spark = { p: Point; k: number }`, `comet(path: (t: number) => Point, at, now): Spark[]`, `tween(target, t: Tween | null, now): Record<string, Point>`.

Coordinates: the graph canvas is in **pixels**, one pixel one cell wide and half a cell tall (half-blocks). Pixel `(px, py)` covers `[px, px+1) x [py, py+1)`. The dot layer is 2x4 dots a cell, so a pixel-space point maps to dot space by `toDots` (x2, y2).

- [ ] **Step 1: Write the failing tests**

`tests/render/canvas.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Dots, Pixels, compose, toDots } from '../../src/render/canvas.ts'
import { Grid, gridText } from '../../src/render/grid.ts'
import { rect } from '../../src/render/types.ts'

test('pixels read, write, blend and light by floored position, and ignore the outside', () => {
  const p = new Pixels(4, 4, 0x111111)
  assert.equal(p.get(0, 0), 0x111111)
  p.set(1, 1, 0xff0000)
  assert.equal(p.get(1.7, 1.2), 0xff0000)
  assert.equal(p.get(9, 9), 0)
  p.set(9, 9, 0xffffff)
  p.blend(1, 1, 0x000000, 0.5)
  assert.equal(p.get(1, 1), 0x800000)
  p.light(0, 0, 0x101010, 1)
  assert.equal(p.get(0, 0), 0x212121)
  p.line({ x: 0, y: 3 }, { x: 3, y: 3 }, 0x00ff00)
  for (let x = 0; x < 4; x++) assert.equal(p.get(x, 3), 0x00ff00)
})

test('dots set the braille bit for their place in the cell', () => {
  const d = new Dots(2, 1)
  assert.equal(d.width, 4)
  assert.equal(d.height, 4)
  d.dot(0, 0, 1)
  d.dot(1, 0, 1)
  d.dot(0, 3, 1)
  d.dot(1, 3, 1)
  d.dot(2, 0, 7)
  d.dot(4, 0, 1)
  assert.equal(d.bits[0], 0xc9)
  assert.equal(d.bits[1], 0x01)
  assert.equal(d.colors[1], 7)
})

test('a dashed dot line leaves every other run out', () => {
  const d = new Dots(4, 1)
  d.line({ x: 0, y: 0 }, { x: 7, y: 0 }, 1, 2)
  assert.deepEqual([...d.bits], [0x09, 0, 0x09, 0])
})

test('compose draws half-blocks, flat cells and braille over the mean of the two pixels', () => {
  const g = new Grid(2, 1)
  const p = new Pixels(2, 2, 0)
  p.set(0, 0, 0xff0000)
  p.set(0, 1, 0x0000ff)
  p.set(1, 0, 0x00ff00)
  p.set(1, 1, 0x00ff00)
  const d = new Dots(2, 1)
  compose(g, rect(0, 0, 2, 1), p, d)
  assert.equal(g.glyph(0, 0), 0x2580)
  assert.equal(g.fg(0, 0), 0xff0000)
  assert.equal(g.bg(0, 0), 0x0000ff)
  assert.deepEqual(gridText(g)[0]![1], ' ')
  assert.equal(g.bg(1, 0), 0x00ff00)
  d.dot(2, 0, 0xffffff)
  compose(g, rect(0, 0, 2, 1), p, d)
  assert.equal(g.glyph(1, 0), 0x2801)
  assert.equal(g.fg(1, 0), 0xffffff)
  assert.equal(g.bg(1, 0), 0x00ff00)
})

test('toDots doubles both axes', () => {
  assert.deepEqual(toDots({ x: 1.5, y: 2 }), { x: 3, y: 4 })
})
```

`tests/render/fx.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { arc, blink, comet, easeInOut, fadeIn, flash, ghost, glow, hashUnit, lerpPoint, tween } from '../../src/render/fx.ts'
import { MOTION } from '../../src/render/tokens.ts'

test('fadeIn and ghost run from 0 to 1 over their durations', () => {
  assert.equal(fadeIn(0, 0), 0)
  assert.equal(fadeIn(0, -100), 0)
  assert.equal(fadeIn(0, MOTION.fadeInMs), 1)
  const mid = fadeIn(0, MOTION.fadeInMs / 2)
  assert.ok(mid > 0.5 && mid < 1)
  assert.equal(ghost(null, 99), 0)
  assert.equal(ghost(0, MOTION.ghostMs / 2), 0.5)
  assert.equal(ghost(0, MOTION.ghostMs * 3), 1)
})

test('glow stays in 0..1 and repeats every period', () => {
  for (let t = 0; t < 4000; t += 97) {
    const g = glow(t, 0.3)
    assert.ok(g >= 0 && g <= 1)
  }
  assert.ok(Math.abs(glow(0, 0) - glow(MOTION.glowPeriodMs, 0)) < 1e-9)
})

test('flash falls from 1 to 0 and is 0 before it starts; blink alternates', () => {
  assert.equal(flash(0, 0, 100), 1)
  assert.equal(flash(0, 50, 100), 0.5)
  assert.equal(flash(0, 150, 100), 0)
  assert.equal(flash(100, 50, 100), 0)
  assert.equal(blink(0, 250), true)
  assert.equal(blink(260, 250), false)
})

test('a comet starts at the sender, is halfway at half time, leaves a fading trail, then is gone', () => {
  const path = (t: number) => lerpPoint({ x: 0, y: 0 }, { x: 100, y: 0 }, t)
  assert.deepEqual(comet(path, 0, 0)[0], { p: { x: 0, y: 0 }, k: 1 })
  const half = comet(path, 0, MOTION.cometMs / 2)
  assert.equal(half[0]!.k, 1)
  assert.ok(Math.abs(half[0]!.p.x - 50) < 1e-9)
  assert.ok(half.length > 1)
  for (let i = 1; i < half.length; i++) assert.ok(half[i]!.k < half[i - 1]!.k && half[i]!.p.x < half[i - 1]!.p.x)
  const landed = comet(path, 0, MOTION.cometMs + 10)
  assert.ok(landed.length > 0 && landed.every(s => s.k < 1))
  assert.deepEqual(comet(path, 0, MOTION.cometMs + MOTION.trailMs + 1), [])
  assert.deepEqual(comet(path, 100, 0), [])
})

test('an arc runs from a to b, bowed to the left of travel; the reverse bows the other way', () => {
  const a = { x: 0, y: 0 }
  const b = { x: 100, y: 0 }
  assert.deepEqual(arc(a, b, 0.25)(0), a)
  assert.deepEqual(arc(a, b, 0.25)(1), b)
  assert.deepEqual(arc(a, b, 0.25)(0.5), { x: 50, y: 12.5 })
  assert.deepEqual(arc(b, a, 0.25)(0.5), { x: 50, y: -12.5 })
  assert.deepEqual(arc(a, b, 0)(0.5), { x: 50, y: 0 })
})

test('easeInOut, hashUnit and lerpPoint', () => {
  assert.equal(easeInOut(0.5), 0.5)
  assert.equal(hashUnit('a-arch'), hashUnit('a-arch'))
  assert.ok(hashUnit('x') >= 0 && hashUnit('x') < 1)
  assert.notEqual(hashUnit('a'), hashUnit('b'))
  assert.deepEqual(lerpPoint({ x: 0, y: 10 }, { x: 10, y: 20 }, 0.5), { x: 5, y: 15 })
})

test('tween glides from the old positions to the new ones', () => {
  const target = { a: { x: 10, y: 10 }, b: { x: 0, y: 0 } }
  assert.deepEqual(tween(target, null, 0), target)
  const t = { from: { a: { x: 0, y: 0 } }, at: 1000 }
  assert.deepEqual(tween(target, t, 1000).a, { x: 0, y: 0 })
  assert.deepEqual(tween(target, t, 1000).b, { x: 0, y: 0 })
  assert.deepEqual(tween(target, t, 1000 + MOTION.tweenMs).a, { x: 10, y: 10 })
  const mid = tween(target, t, 1000 + MOTION.tweenMs / 2).a!
  assert.ok(mid.x > 5 && mid.x < 10)
})
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test tests/render/canvas.test.ts tests/render/fx.test.ts`
Expected: FAIL, `Cannot find module` for `src/render/canvas.ts`.

- [ ] **Step 3: Write `src/render/canvas.ts`**

```ts
/**
 * The graph's two layers: a half-block pixel canvas (two pixels a cell, one above the other) for nodes, glow and thick
 * links, and braille dots (2x4 a cell) for fine lines and particles. compose() paints both into cells. Pure.
 */
import { add, mix } from './color.ts'
import type { Grid } from './grid.ts'
import type { Point, Rect } from './types.ts'

const UPPER_HALF = 0x2580
const SPACE = 0x20
const BRAILLE = 0x2800
/** Braille dot bits by [row][column] within one cell. */
const BIT: ReadonlyArray<readonly [number, number]> = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]]

export class Pixels {
  readonly width: number
  readonly height: number
  readonly data: Uint32Array

  constructor(width: number, height: number, bg: number) {
    this.width = Math.max(1, Math.floor(width))
    this.height = Math.max(1, Math.floor(height))
    this.data = new Uint32Array(this.width * this.height).fill(bg >>> 0)
  }

  #at(x: number, y: number): number {
    const px = Math.floor(x)
    const py = Math.floor(y)
    return px < 0 || py < 0 || px >= this.width || py >= this.height ? -1 : py * this.width + px
  }

  get(x: number, y: number): number {
    const i = this.#at(x, y)
    return i < 0 ? 0 : this.data[i]!
  }

  set(x: number, y: number, c: number): void {
    const i = this.#at(x, y)
    if (i >= 0) this.data[i] = c >>> 0
  }

  blend(x: number, y: number, c: number, t: number): void {
    const i = this.#at(x, y)
    if (i >= 0) this.data[i] = mix(this.data[i]!, c, t)
  }

  light(x: number, y: number, c: number, k: number): void {
    const i = this.#at(x, y)
    if (i >= 0) this.data[i] = add(this.data[i]!, c, k)
  }

  line(a: Point, b: Point, c: number, t = 1): void {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y))))
    for (let i = 0; i <= steps; i++) this.blend(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps, c, t)
  }
}

export class Dots {
  readonly columns: number
  readonly rows: number
  readonly bits: Uint8Array
  readonly colors: Uint32Array

  constructor(columns: number, rows: number) {
    this.columns = Math.max(1, Math.floor(columns))
    this.rows = Math.max(1, Math.floor(rows))
    this.bits = new Uint8Array(this.columns * this.rows)
    this.colors = new Uint32Array(this.columns * this.rows)
  }

  get width(): number {
    return this.columns * 2
  }

  get height(): number {
    return this.rows * 4
  }

  /** Lights the dot under (x, y), in dot space. A cell takes the colour of the last dot drawn in it. */
  dot(x: number, y: number, c: number): void {
    const dx = Math.floor(x)
    const dy = Math.floor(y)
    if (dx < 0 || dy < 0 || dx >= this.width || dy >= this.height) return
    const cell = Math.floor(dy / 4) * this.columns + Math.floor(dx / 2)
    this.bits[cell] = this.bits[cell]! | BIT[dy % 4]![dx % 2]!
    this.colors[cell] = c >>> 0
  }

  /** A line of dots from a to b in dot space. With `dash`, every other run of `dash` dots is left out. */
  line(a: Point, b: Point, c: number, dash = 0): void {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y))))
    for (let i = 0; i <= steps; i++) {
      if (dash > 0 && Math.floor(i / dash) % 2 === 1) continue
      this.dot(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps, c)
    }
  }
}

/** Pixel space to dot space: a pixel is one cell wide and half a cell tall, a dot half a cell wide and a quarter tall. */
export const toDots = (p: Point): Point => ({ x: p.x * 2, y: p.y * 2 })

/** Paints both layers into `grid` at `area`. A cell with dots shows braille over the mean of its two pixels. */
export function compose(grid: Grid, area: Rect, pixels: Pixels, dots: Dots): void {
  const w = Math.min(area.w, pixels.width, dots.columns)
  const h = Math.min(area.h, Math.floor(pixels.height / 2), dots.rows)
  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) {
      const top = pixels.get(cx, cy * 2)
      const bottom = pixels.get(cx, cy * 2 + 1)
      const i = cy * dots.columns + cx
      const bits = dots.bits[i]!
      if (bits !== 0) grid.set(area.x + cx, area.y + cy, BRAILLE + bits, dots.colors[i]!, mix(top, bottom, 0.5))
      else if (top === bottom) grid.set(area.x + cx, area.y + cy, SPACE, top, top)
      else grid.set(area.x + cx, area.y + cy, UPPER_HALF, top, bottom)
    }
  }
}
```

- [ ] **Step 4: Write `src/render/fx.ts`**

```ts
/** Motion maths at a given time: fades, glow, flashes, comets and the layout glide. Deterministic: no randomness. Pure. */
import { clamp01 } from './color.ts'
import { MOTION } from './tokens.ts'
import type { Point, Tween } from './types.ts'

export const easeOutCubic = (t: number): number => 1 - (1 - clamp01(t)) ** 3

export const easeInOut = (t: number): number => {
  const k = clamp01(t)
  return k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2
}

/** 0 at start, 1 once MOTION.fadeInMs has passed. */
export const fadeIn = (startedAt: number, now: number): number => easeOutCubic((now - startedAt) / MOTION.fadeInMs)

/** 0 while running, rising to 1 over MOTION.ghostMs after finishing. */
export const ghost = (finishedAt: number | null, now: number): number =>
  finishedAt === null ? 0 : clamp01((now - finishedAt) / MOTION.ghostMs)

/** A slow 0..1 breath, offset per agent by `seed` so neighbours don't pulse in step. */
export const glow = (now: number, seed: number): number => 0.5 + 0.5 * Math.sin(2 * Math.PI * (now / MOTION.glowPeriodMs + seed))

/** 1 at `at`, falling to 0 over `ms`; 0 before `at`. */
export function flash(at: number, now: number, ms: number): number {
  const age = now - at
  return age < 0 || age > ms ? 0 : 1 - age / ms
}

export const blink = (now: number, ms: number): boolean => Math.floor(now / ms) % 2 === 0

/** A stable 0..1 number for a string (FNV-1a). */
export function hashUnit(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h / 0x100000000
}

export const lerpPoint = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })

/**
 * A gentle curve from a to b (a quadratic Bezier), bowed to the left of the direction of travel by `bend` times the
 * distance. The reverse direction bows the other way, so a pair of links reads as two.
 */
export function arc(a: Point, b: Point, bend: number): (t: number) => Point {
  const cx = (a.x + b.x) / 2 - (b.y - a.y) * bend
  const cy = (a.y + b.y) / 2 + (b.x - a.x) * bend
  return t => {
    const u = 1 - t
    return { x: u * u * a.x + 2 * u * t * cx + t * t * b.x, y: u * u * a.y + 2 * u * t * cy + t * t * b.y }
  }
}

export type Spark = { p: Point; k: number }

/**
 * A message's comet along `path` (t from 0 at the sender to 1 at the receiver): the head (k = 1) runs the path over
 * MOTION.cometMs, and MOTION.trailDots dots trail it over MOTION.trailMs with falling k. After the head lands the trail
 * sweeps in; then nothing is left.
 */
export function comet(path: (t: number) => Point, at: number, now: number): Spark[] {
  const age = now - at
  if (age < 0 || age > MOTION.cometMs + MOTION.trailMs) return []
  const head = age / MOTION.cometMs
  const gap = MOTION.trailMs / MOTION.cometMs / MOTION.trailDots
  const out: Spark[] = []
  for (let i = 0; i <= MOTION.trailDots; i++) {
    const t = head - i * gap
    if (t < 0 || t > 1) continue
    out.push({ p: path(easeInOut(t)), k: i === 0 ? 1 : 1 - i / (MOTION.trailDots + 1) })
  }
  return out
}

/** Positions part way from `t.from` to `target`, eased over MOTION.tweenMs. A node with no old position starts where it ends. */
export function tween(target: Readonly<Record<string, Point>>, t: Tween | null, now: number): Record<string, Point> {
  const k = t === null ? 1 : easeOutCubic((now - t.at) / MOTION.tweenMs)
  const out: Record<string, Point> = {}
  for (const [id, p] of Object.entries(target)) {
    const from = t !== null && Object.hasOwn(t.from, id) ? t.from[id]! : p
    out[id] = k >= 1 ? p : lerpPoint(from, p, k)
  }
  return out
}
```

- [ ] **Step 5: Run the tests to make sure they pass**

Run: `node --test tests/render/canvas.test.ts tests/render/fx.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 6: Run the gate, then commit**

Run: `npm run check` (expected: green), then:

```bash
git add src/render/canvas.ts src/render/fx.ts tests/render/canvas.test.ts tests/render/fx.test.ts
git commit -m "Add the graph's half-block pixel canvas, braille dot layer and the motion maths for fades, glow and comets"
```

---

### Task 6: Size steps, regions and node layout per topology  *(wave 2, parallel)*

**Files:**
- Create: `src/render/regions.ts`, `src/render/layout.ts`
- Test: `tests/render/regions.test.ts`, `tests/render/layout.test.ts`

**Interfaces:**
- Consumes: `SIZE`, `RASTER_MAX` (`tokens.ts`); `rect`, `Rect`, `Size`, `SizeStep`, `Point` (`types.ts`); `LEAD`, `AgentState`, `SwarmState` (`core/fold.ts`); `Topology` (`core/events.ts`).
- Produces:
  - `regions.ts`: `sizeStep(size: Size): SizeStep`; `type Regions = { step: SizeStep; top: Size; bottom: Size | null; header: Rect; graph: Rect | null; tree: Rect | null; chips: boolean; spotlight: Rect | null; timeline: Rect | null; feed: Rect | null }`; `planRegions(size: Size, agents: number): Regions`. `header`, `graph`, `tree` are in top-grid cells; `spotlight`, `timeline`, `feed` in bottom-grid cells. The chip row is one terminal row between the two grids, so `top.rows + 1 + bottom.rows ≤ size.rows` (each grid also capped at 256 rows and 512 columns).
  - `layout.ts`: `type Edge = { from: string; to: string }`, `MARGIN`, `orderAgents(state): AgentState[]` (lead first, then by start time and id, placeholders last), `parentsOf(state): Map<string, string | null>` (**parent-cycle guard**: any agent on a parent loop hangs off the lead; ledger item from phase 1), `depthsOf(parents): Map<string, number>`, `layoutNodes(state, topology, width, height): Record<string, Point>` (pixel space), `structuralEdges(state, topology): Edge[]`, `nodesKey(state): string`.

- [ ] **Step 1: Write the failing tests**

`tests/render/regions.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planRegions, sizeStep } from '../../src/render/regions.ts'
import { rect } from '../../src/render/types.ts'

test('size steps drop the timeline, then the spotlight, then the graph, then everything but a line', () => {
  assert.equal(sizeStep({ columns: 120, rows: 44 }), 'full')
  assert.equal(sizeStep({ columns: 100, rows: 29 }), 'noTimeline')
  assert.equal(sizeStep({ columns: 80, rows: 21 }), 'compactSpotlight')
  assert.equal(sizeStep({ columns: 60, rows: 13 }), 'tree')
  assert.equal(sizeStep({ columns: 47, rows: 30 }), 'tree')
  assert.equal(sizeStep({ columns: 40, rows: 5 }), 'summary')
  assert.equal(sizeStep({ columns: 29, rows: 40 }), 'summary')
})

test('full: header, graph, chips, spotlight, timeline and feed fill the pane exactly', () => {
  const r = planRegions({ columns: 120, rows: 44 }, 6)
  assert.equal(r.step, 'full')
  assert.deepEqual(r.top, { columns: 120, rows: 26 })
  assert.deepEqual(r.bottom, { columns: 120, rows: 17 })
  assert.deepEqual(r.header, rect(0, 0, 120, 2))
  assert.deepEqual(r.graph, rect(0, 2, 120, 24))
  assert.deepEqual(r.spotlight, rect(0, 0, 120, 6))
  assert.deepEqual(r.timeline, rect(0, 6, 120, 7))
  assert.deepEqual(r.feed, rect(0, 13, 120, 4))
  assert.equal(r.chips, true)
  assert.equal(r.top.rows + 1 + r.bottom!.rows, 44)
})

test('no timeline and compact spotlight', () => {
  const a = planRegions({ columns: 100, rows: 29 }, 6)
  assert.deepEqual([a.top.rows, a.bottom!.rows, a.timeline, a.feed], [18, 10, null, rect(0, 6, 100, 4)])
  const b = planRegions({ columns: 80, rows: 21 }, 6)
  assert.deepEqual([b.top.rows, b.bottom!.rows, b.spotlight, b.feed], [14, 6, rect(0, 0, 80, 1), rect(0, 1, 80, 5)])
})

test('tree and summary have no chips and no bottom grid', () => {
  const t = planRegions({ columns: 60, rows: 13 }, 6)
  assert.deepEqual([t.top, t.tree, t.bottom, t.chips, t.graph], [{ columns: 60, rows: 13 }, rect(0, 1, 60, 12), null, false, null])
  const s = planRegions({ columns: 40, rows: 5 }, 6)
  assert.deepEqual([s.top, s.header, s.bottom, s.chips], [{ columns: 40, rows: 1 }, rect(0, 0, 40, 1), null, false])
})

test('a huge pane is held to the Raster limits', () => {
  const r = planRegions({ columns: 600, rows: 600 }, 3)
  assert.equal(r.top.columns, 512)
  assert.equal(r.top.rows, 256)
  assert.equal(r.bottom!.rows, 256)
  assert.equal(r.graph!.h, 254)
})
```

`tests/render/layout.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldAll, type SwarmState } from '../../src/core/fold.ts'
import { MARGIN, depthsOf, layoutNodes, nodesKey, orderAgents, parentsOf, structuralEdges } from '../../src/render/layout.ts'
import { ev } from '../helpers.ts'

const leadUse = (sec = 0) => ev('agent.usage', { model: 'claude-opus-5-5', input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, { atSec: sec })
const start = (id: string, parent: string, sec: number) => ev('agent.started', { name: id, role: 'coder', description: '', parent }, { agent: id, atSec: sec })
const state = (...events: Parameters<typeof foldAll>[1]): SwarmState => foldAll('s1', events)

test('drawing order: the lead first, then by start time, placeholders last', () => {
  const s = state(leadUse(), start('b', 'lead', 2), start('a', 'lead', 1), ev('message.sent', { to: 'zz', summary: 'hi' }, { agent: 'a', atSec: 3 }))
  assert.deepEqual(orderAgents(s).map(a => a.id), ['lead', 'a', 'b', '?zz'])
})

test('parents follow the chain, and a missing parent falls back to the lead', () => {
  const s = state(leadUse(), start('a', 'lead', 1), start('b', 'a', 2), start('c', 'nobody', 3))
  const p = parentsOf(s)
  assert.deepEqual([p.get('lead'), p.get('a'), p.get('b'), p.get('c')], [null, 'lead', 'a', 'lead'])
  assert.deepEqual([...depthsOf(p)].sort(), [['a', 1], ['b', 2], ['c', 1], ['lead', 0]])
})

test('agents on a parent loop hang off the lead; agents below the loop keep their parent', () => {
  const two = parentsOf(state(leadUse(), start('a', 'b', 1), start('b', 'a', 2), start('c', 'a', 3)))
  assert.deepEqual([two.get('a'), two.get('b'), two.get('c')], ['lead', 'lead', 'a'])
  const three = parentsOf(state(leadUse(), start('a', 'b', 1), start('b', 'c', 2), start('c', 'a', 3)))
  assert.deepEqual([three.get('a'), three.get('b'), three.get('c')], ['lead', 'lead', 'lead'])
  const leaderless = parentsOf(state(start('a', 'b', 1), start('b', 'a', 2)))
  assert.deepEqual([leaderless.get('a'), leaderless.get('b')], [null, null])
})

test('a long loop of fifty agents still lays out', () => {
  const events = [leadUse(), ...Array.from({ length: 50 }, (_, i) => start(`n${i}`, `n${(i + 1) % 50}`, i + 1))]
  const pos = layoutNodes(state(...events), 'hierarchical', 200, 60)
  assert.equal(Object.keys(pos).length, 51)
  for (const p of Object.values(pos)) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y))
})

test('hierarchical: the lead on top, layers by depth, spread evenly', () => {
  const pos = layoutNodes(state(leadUse(), start('a', 'lead', 1), start('b', 'a', 2)), 'hierarchical', 100, 40)
  assert.deepEqual(pos.lead, { x: 50, y: MARGIN.top })
  assert.deepEqual(pos.a, { x: 50, y: MARGIN.top + (40 - MARGIN.bottom - MARGIN.top) / 2 })
  assert.deepEqual(pos.b, { x: 50, y: 40 - MARGIN.bottom })
})

test('mesh: a ring with the lead at twelve o\'clock; star: the lead in the centre', () => {
  const s = state(leadUse(), start('a', 'lead', 1), start('b', 'lead', 2), start('c', 'lead', 3))
  const ring = layoutNodes(s, 'mesh', 100, 40)
  assert.ok(Math.abs(ring.lead!.x - 50) < 1e-9)
  assert.ok(Math.abs(ring.lead!.y - MARGIN.top) < 1e-9)
  const cx = 50
  const cy = (MARGIN.top + 40 - MARGIN.bottom) / 2
  const rx = 50 - MARGIN.x
  const ry = (40 - MARGIN.bottom - MARGIN.top) / 2
  for (const p of Object.values(ring)) assert.ok(Math.abs(((p.x - cx) / rx) ** 2 + ((p.y - cy) / ry) ** 2 - 1) < 1e-9)
  const star = layoutNodes(s, 'star', 100, 40)
  assert.deepEqual(star.lead, { x: cx, y: cy })
  for (const p of [star.a!, star.b!, star.c!]) assert.ok(Math.abs(((p.x - cx) / rx) ** 2 + ((p.y - cy) / ry) ** 2 - 1) < 1e-9)
})

test('every node sits inside the canvas, and a lone node sits in the middle', () => {
  const pos = layoutNodes(state(leadUse(), start('a', 'lead', 1), start('b', 'lead', 2)), 'mesh', 30, 12)
  for (const p of Object.values(pos)) assert.ok(p.x >= 0 && p.x <= 30 && p.y >= 0 && p.y <= 12)
  const lone = layoutNodes(state(leadUse()), 'mesh', 100, 40)
  assert.deepEqual(lone.lead, { x: 50, y: (MARGIN.top + 40 - MARGIN.bottom) / 2 })
  assert.deepEqual(layoutNodes(state(), 'mesh', 100, 40), {})
})

test('structural edges: parent links for a tree, spokes for a star, none for a mesh', () => {
  const s = state(leadUse(), start('a', 'lead', 1), start('b', 'a', 2))
  assert.deepEqual(structuralEdges(s, 'hierarchical'), [{ from: 'lead', to: 'a' }, { from: 'a', to: 'b' }])
  assert.deepEqual(structuralEdges(s, 'star'), [{ from: 'lead', to: 'a' }, { from: 'lead', to: 'b' }])
  assert.deepEqual(structuralEdges(s, 'mesh'), [])
})

test('nodesKey changes when an agent joins and not otherwise', () => {
  const a = state(leadUse(), start('a', 'lead', 1))
  const b = state(leadUse(), start('a', 'lead', 1))
  const c = state(leadUse(), start('a', 'lead', 1), start('b', 'lead', 2))
  assert.equal(nodesKey(a), nodesKey(b))
  assert.notEqual(nodesKey(a), nodesKey(c))
})
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test tests/render/regions.test.ts tests/render/layout.test.ts`
Expected: FAIL, `Cannot find module` for `src/render/regions.ts`.

- [ ] **Step 3: Write `src/render/regions.ts`**

```ts
/** Which size step the pane is at, and the box of cells each part gets. Pure. */
import { RASTER_MAX, SIZE } from './tokens.ts'
import { rect, type Rect, type Size, type SizeStep } from './types.ts'

export type Regions = {
  step: SizeStep
  top: Size
  bottom: Size | null
  header: Rect
  graph: Rect | null
  tree: Rect | null
  chips: boolean
  spotlight: Rect | null
  timeline: Rect | null
  feed: Rect | null
}

/** As the pane shrinks: drop the timeline, then cut the spotlight to one line, then swap the graph for a tree, then one line. */
export function sizeStep(size: Size): SizeStep {
  const { columns, rows } = size
  if (rows < SIZE.summaryBelowRows || columns < SIZE.summaryBelowColumns) return 'summary'
  if (rows < SIZE.treeBelowRows || columns < SIZE.treeBelowColumns) return 'tree'
  if (rows < SIZE.compactBelowRows) return 'compactSpotlight'
  if (rows < SIZE.noTimelineBelowRows) return 'noTimeline'
  return 'full'
}

const HEADER_ROWS = 2
const CHIP_ROWS = 1

export function planRegions(size: Size, agents: number): Regions {
  const step = sizeStep(size)
  const columns = Math.max(1, Math.min(RASTER_MAX.columns, Math.floor(size.columns)))
  const rows = Math.max(1, Math.floor(size.rows))
  const none = { bottom: null, graph: null, tree: null, chips: false, spotlight: null, timeline: null, feed: null }
  if (step === 'summary') return { ...none, step, top: { columns, rows: 1 }, header: rect(0, 0, columns, 1) }
  if (step === 'tree') {
    const h = Math.min(RASTER_MAX.rows, rows)
    return { ...none, step, top: { columns, rows: h }, header: rect(0, 0, columns, 1), tree: rect(0, 1, columns, h - 1) }
  }
  const spotRows = step === 'compactSpotlight' ? 1 : SIZE.spotlightRows
  const timelineRows = step === 'full' ? Math.min(SIZE.timelineMaxRows, Math.max(1, agents)) + 1 : 0
  const fixed = HEADER_ROWS + CHIP_ROWS + spotRows + timelineRows
  const wanted = Math.max(SIZE.minGraphRows, Math.round(rows * SIZE.graphShare))
  const graphRows = Math.max(SIZE.minGraphRows, Math.min(wanted, rows - fixed - SIZE.minFeedRows))
  const feedRows = Math.max(0, rows - fixed - graphRows)
  const topRows = Math.min(RASTER_MAX.rows, HEADER_ROWS + graphRows)
  const bottomRows = Math.min(RASTER_MAX.rows, spotRows + timelineRows + feedRows)
  return {
    step,
    top: { columns, rows: topRows },
    bottom: { columns, rows: bottomRows },
    header: rect(0, 0, columns, HEADER_ROWS),
    graph: rect(0, HEADER_ROWS, columns, topRows - HEADER_ROWS),
    tree: null,
    chips: true,
    spotlight: rect(0, 0, columns, spotRows),
    timeline: timelineRows > 0 ? rect(0, spotRows, columns, timelineRows) : null,
    feed: feedRows > 0 ? rect(0, spotRows + timelineRows, columns, Math.min(feedRows, bottomRows - spotRows - timelineRows)) : null,
  }
}
```

- [ ] **Step 4: Write `src/render/layout.ts`**

```ts
/** Where each agent sits on the graph canvas, by topology: a tree, a ring, or a hub with spokes. Pure. */
import type { Topology } from '../core/events.ts'
import { LEAD, type AgentState, type SwarmState } from '../core/fold.ts'
import type { Point } from './types.ts'

export type Edge = { from: string; to: string }

/** Pixels kept clear at the canvas edges: room for a node's glow above it and its label row below it. */
export const MARGIN = { x: 6, top: 6, bottom: 8 } as const

type Box = { x0: number; x1: number; y0: number; y1: number }

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const rank = (a: AgentState): number => (a.id === LEAD ? 0 : a.placeholder ? 2 : 1)

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key)
  if (list === undefined) map.set(key, [value])
  else list.push(value)
}

export function orderAgents(state: SwarmState): AgentState[] {
  return Object.values(state.agents).sort((a, b) => rank(a) - rank(b) || a.startedAt - b.startedAt || byId(a.id, b.id))
}

/**
 * Each agent's parent within the swarm, or null for a root. The log is untrusted, so parents can loop: every agent on
 * a loop hangs off the lead instead (or becomes a root when there is no lead). Agents below a loop keep their parent.
 */
export function parentsOf(state: SwarmState): Map<string, string | null> {
  const ids = new Set(Object.keys(state.agents))
  const root = ids.has(LEAD) ? LEAD : null
  const direct = (id: string): string | null => {
    if (id === LEAD) return null
    const p = state.agents[id]?.parent ?? ''
    return p !== '' && p !== id && ids.has(p) ? p : root
  }
  const looped = new Set<string>()
  for (const id of ids) {
    const seen = new Set<string>()
    let cur = direct(id)
    while (cur !== null && !seen.has(cur)) {
      if (cur === id) {
        looped.add(id)
        break
      }
      seen.add(cur)
      cur = direct(cur)
    }
  }
  const out = new Map<string, string | null>()
  for (const id of ids) out.set(id, looped.has(id) ? (id === root ? null : root) : direct(id))
  return out
}

/** Steps from each agent up to its root. Bounded, so a loop that slipped through still ends. */
export function depthsOf(parents: Map<string, string | null>): Map<string, number> {
  const out = new Map<string, number>()
  for (const id of parents.keys()) {
    let d = 0
    let cur = parents.get(id) ?? null
    const seen = new Set<string>([id])
    while (cur !== null && !seen.has(cur)) {
      seen.add(cur)
      d++
      cur = parents.get(cur) ?? null
    }
    out.set(id, d)
  }
  return out
}

function treeLayout(state: SwarmState, agents: readonly AgentState[], box: Box): Record<string, Point> {
  const parents = parentsOf(state)
  const depths = depthsOf(parents)
  const kids = new Map<string, string[]>()
  const roots: string[] = []
  for (const a of agents) {
    const p = parents.get(a.id) ?? null
    if (p === null) roots.push(a.id)
    else push(kids, p, a.id)
  }
  const order: string[] = []
  const seen = new Set<string>()
  const walk = (id: string): void => {
    if (seen.has(id)) return
    seen.add(id)
    order.push(id)
    for (const k of kids.get(id) ?? []) walk(k)
  }
  for (const r of roots) walk(r)
  for (const a of agents) walk(a.id)
  const layers = new Map<number, string[]>()
  for (const id of order) push(layers, depths.get(id) ?? 0, id)
  const maxDepth = Math.max(0, ...layers.keys())
  const out: Record<string, Point> = {}
  for (const [d, ids] of layers) {
    ids.forEach((id, i) => {
      out[id] = {
        x: box.x0 + ((i + 1) / (ids.length + 1)) * (box.x1 - box.x0),
        y: maxDepth === 0 ? (box.y0 + box.y1) / 2 : box.y0 + (d / maxDepth) * (box.y1 - box.y0),
      }
    })
  }
  return out
}

function ringLayout(agents: readonly AgentState[], box: Box, out: Record<string, Point> = {}): Record<string, Point> {
  const cx = (box.x0 + box.x1) / 2
  const cy = (box.y0 + box.y1) / 2
  const rx = (box.x1 - box.x0) / 2
  const ry = (box.y1 - box.y0) / 2
  if (agents.length === 1) out[agents[0]!.id] = { x: cx, y: cy }
  else {
    agents.forEach((a, i) => {
      const angle = -Math.PI / 2 + (2 * Math.PI * i) / agents.length
      out[a.id] = { x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) }
    })
  }
  return out
}

/** Node centres in canvas pixels for a canvas `width` x `height` pixels. */
export function layoutNodes(state: SwarmState, topology: Topology, width: number, height: number): Record<string, Point> {
  const agents = orderAgents(state)
  if (agents.length === 0) return {}
  const box: Box = { x0: MARGIN.x, x1: Math.max(MARGIN.x, width - MARGIN.x), y0: MARGIN.top, y1: Math.max(MARGIN.top, height - MARGIN.bottom) }
  if (topology === 'hierarchical') return treeLayout(state, agents, box)
  if (topology === 'star' && agents.length > 1) {
    const out: Record<string, Point> = { [agents[0]!.id]: { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 } }
    return ringLayout(agents.slice(1), box, out)
  }
  return ringLayout(agents, box)
}

/** The faint lines that show the swarm's shape: parent links in a tree, spokes in a star, none in a mesh. */
export function structuralEdges(state: SwarmState, topology: Topology): Edge[] {
  const agents = orderAgents(state)
  if (topology === 'mesh' || agents.length < 2) return []
  if (topology === 'star') return agents.slice(1).map(a => ({ from: agents[0]!.id, to: a.id }))
  const parents = parentsOf(state)
  const edges: Edge[] = []
  for (const a of agents) {
    const p = parents.get(a.id) ?? null
    if (p !== null) edges.push({ from: p, to: a.id })
  }
  return edges
}

/** Changes exactly when the node set, their order or the tree's shape changes: the pane glides nodes when it does. */
export function nodesKey(state: SwarmState): string {
  const parents = parentsOf(state)
  return `${state.swarm.topology}|${orderAgents(state).map(a => `${a.id}<${parents.get(a.id) ?? ''}`).join(',')}`
}
```

- [ ] **Step 5: Run the tests to make sure they pass**

Run: `node --test tests/render/regions.test.ts tests/render/layout.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 6: Run the gate, then commit**

Run: `npm run check` (expected: green), then:

```bash
git add src/render/regions.ts src/render/layout.ts tests/render/regions.test.ts tests/render/layout.test.ts
git commit -m "Add the pane's size steps and region plan, and node layout per topology with a guard against parent loops"
```

---

### Task 7: The spotlight: who to show, and the card  *(wave 2, parallel)*

**Files:**
- Create: `src/render/spotlight.ts`
- Test: `tests/render/spotlight.test.ts`, `tests/core/stats-boundaries.test.ts`

**Interfaces:**
- Consumes: `agentStatus`, `AgentStats` (`core/stats.ts`); `AgentState`, `SwarmState` (`core/fold.ts`); `TOOL_KINDS` (`core/events.ts`); `mix`, `quantise` (`color.ts`); `Grid`, `Part`, `writeParts`, `writeRight` (`grid.ts`); `fmt*`, `clipText` (`format.ts`); tokens; `Pulse`, `Rect`, `Spot` (`types.ts`). Fixture `fiveAgentEvents`, `FIVE_AT`, `FIVE_SWARM` in tests.
- Produces: `busiest(state, pulses, now): string | null`, `chooseSpotlight(prev: Spot | null, pinned: string | null, state, pulses, now): Spot | null`, `sparkline(grid, x, y, width, values, color, bg?)`, `drawSpotlight(grid, area: Rect, s: AgentStats, a: AgentState, now, compact: boolean)`.

Busiest = most output tokens in the last 30 s, plus 50 per tool pulse in the last 10 s, plus 1 if running; ties go to the most recently active. Placeholders never. The spotlight holds an agent for `SPOTLIGHT_HOLD_MS` before switching (spec §10); a valid pin always wins and pressing the pinned chip again unpins (the pane handles the press, Task 16).

Card rows (full, 6 rows on `CANVAS_RAISED`):
0. `● name · role · model` … right: `▶ running · 25s` (status glyph and word in its status colour, lifetime)
1. `tokens in 7k  out 3.7k  cache r 48k w 8k  = 67k` … right: `≈$0.12`
2. `context ██████░░░░ 6%  cache hit 71%` (bar coloured by `contextColor`)
3. `speed ≈ 42 tok/s ▁▂▅█  tokens ▁▃█` (two 16-cell sparklines)
4. `tools r 0  e 2  b 0  s 0  w 0  a 0  o 0   errors 0` (+ `! stuck` in `STATUS.warn`)
5. `files 2  src/auth/token.ts, src/auth/issuer.ts` … right: `msgs ↓2 ↑1  ! clash src/auth/token.ts`

Compact (1 row): `● name ▶ running · 25s · 67k tok · ≈$0.12 · ctx 6%`.

- [ ] **Step 1: Write the failing tests**

`tests/render/spotlight.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldAll } from '../../src/core/fold.ts'
import { agentStats } from '../../src/core/stats.ts'
import { Grid, gridText } from '../../src/render/grid.ts'
import { busiest, chooseSpotlight, drawSpotlight, sparkline } from '../../src/render/spotlight.ts'
import { CANVAS, SPOTLIGHT_HOLD_MS } from '../../src/render/tokens.ts'
import { rect, type Pulse } from '../../src/render/types.ts'
import { FIVE_AT, FIVE_SWARM, fiveAgentEvents } from '../fixtures/swarm-five.ts'

const state = () => foldAll(FIVE_SWARM, fiveAgentEvents())
const mid = FIVE_AT.mid

test('busiest is the agent with the most recent output, and pulses count', () => {
  const s = state()
  assert.equal(busiest(s, [], mid), 'a-cod1')
  const pulses: Pulse[] = Array.from({ length: 100 }, () => ({ agent: 'a-test', kind: 'bash', at: mid - 1000, isError: false }))
  assert.equal(busiest(s, pulses, mid), 'a-test')
  assert.equal(busiest(foldAll('s1', []), [], mid), null)
})

test('the spotlight holds an agent for the hold time, then follows the busiest', () => {
  const s = state()
  const held = { id: 'a-arch', since: mid - (SPOTLIGHT_HOLD_MS - 1) }
  assert.equal(chooseSpotlight(held, null, s, [], mid), held)
  assert.deepEqual(chooseSpotlight({ id: 'a-arch', since: mid - SPOTLIGHT_HOLD_MS }, null, s, [], mid), { id: 'a-cod1', since: mid })
  const same = { id: 'a-cod1', since: mid - 99_999 }
  assert.equal(chooseSpotlight(same, null, s, [], mid), same)
  assert.deepEqual(chooseSpotlight({ id: 'gone', since: mid }, null, s, [], mid), { id: 'a-cod1', since: mid })
  assert.deepEqual(chooseSpotlight(null, null, s, [], mid), { id: 'a-cod1', since: mid })
})

test('a pin always wins; an unknown or placeholder pin is ignored', () => {
  const s = state()
  assert.deepEqual(chooseSpotlight(null, 'a-test', s, [], mid), { id: 'a-test', since: mid })
  const pinned = { id: 'a-test', since: 5 }
  assert.equal(chooseSpotlight(pinned, 'a-test', s, [], mid), pinned)
  assert.deepEqual(chooseSpotlight(null, 'zzz', s, [], mid), { id: 'a-cod1', since: mid })
  assert.deepEqual(chooseSpotlight(null, '?ghost', s, [], mid), { id: 'a-cod1', since: mid })
})

test('sparkline scales to its own maximum, newest on the right', () => {
  const g = new Grid(5, 1)
  sparkline(g, 0, 0, 5, [0, 1, 2, 4, 8], 0xffffff)
  assert.deepEqual(gridText(g), ['▁▁▂▄█'])
  const h = new Grid(3, 1)
  sparkline(h, 0, 0, 3, [0, 1, 2, 4, 8], 0xffffff)
  assert.deepEqual(gridText(h), ['▂▄█'])
  const k = new Grid(3, 1)
  sparkline(k, 0, 0, 3, [8], 0xffffff)
  assert.deepEqual(gridText(k), ['▁▁█'])
})

test('the full card shows every per-agent stat', () => {
  const s = state()
  const g = new Grid(110, 6, CANVAS)
  drawSpotlight(g, rect(0, 0, 110, 6), agentStats(s, 'a-cod1', mid)!, s.agents['a-cod1']!, mid, false)
  const rows = gridText(g)
  assert.match(rows[0]!, /coder-1 · coder · claude-sonnet-5-5/)
  assert.match(rows[0]!, /▶ running · 25s/)
  assert.match(rows[1]!, /tokens in .* out .* cache r .* w .* = /)
  assert.match(rows[1]!, /≈\$/)
  assert.match(rows[2]!, /context .*%.*cache hit \d+%/)
  assert.match(rows[3]!, /speed ≈ /)
  assert.match(rows[4]!, /tools r 0 {2}e 2 /)
  assert.match(rows[4]!, /errors 0/)
  assert.match(rows[5]!, /files 2/)
  assert.match(rows[5]!, /msgs ↓2 ↑1/)
  assert.match(rows[5]!, /! clash/)
})

test('a stuck agent says so, and the compact card is one line', () => {
  const s = state()
  const g = new Grid(110, 6, CANVAS)
  drawSpotlight(g, rect(0, 0, 110, 6), agentStats(s, 'a-test', mid)!, s.agents['a-test']!, mid, false)
  assert.match(gridText(g)[4]!, /! stuck/)
  const c = new Grid(90, 1, CANVAS)
  drawSpotlight(c, rect(0, 0, 90, 1), agentStats(s, 'a-cod1', mid)!, s.agents['a-cod1']!, mid, true)
  assert.match(gridText(c)[0]!, /coder-1 ▶ running · 25s · .* tok · ≈\$.* · ctx /)
})
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test tests/render/spotlight.test.ts`
Expected: FAIL, `Cannot find module` for `src/render/spotlight.ts`.

- [ ] **Step 3: Write `src/render/spotlight.ts`**

```ts
/** The spotlight: who to show (the busiest agent, held for a while, or the pinned one) and the card drawn for them. Pure. */
import { TOOL_KINDS } from '../core/events.ts'
import type { AgentState, SwarmState } from '../core/fold.ts'
import { agentStatus, type AgentStats } from '../core/stats.ts'
import { mix, quantise } from './color.ts'
import { clipText, fmtDuration, fmtPercent, fmtTokens, fmtUsd } from './format.ts'
import { type Grid, type Part, writeParts, writeRight } from './grid.ts'
import { CANVAS_RAISED, GLYPH, KIND, KIND_LETTER, SPOTLIGHT_HOLD_MS, STATUS, TEXT, contextColor, modelColor, statusGlyph } from './tokens.ts'
import type { Pulse, Rect, Spot } from './types.ts'

const SCORE_WINDOW_MS = 30_000
const PULSE_WINDOW_MS = 10_000
const PULSE_SCORE = 50
const LOWER_EIGHTH = 0x2581
const FULL = 0x2588
const LIGHT_SHADE = 0x2591
const BAR_CELLS = 10
const SPARK_CELLS = 16

export function busiest(state: SwarmState, pulses: readonly Pulse[], now: number): string | null {
  let best: string | null = null
  let bestScore = -1
  let bestAt = Number.NEGATIVE_INFINITY
  for (const a of Object.values(state.agents)) {
    if (a.placeholder) continue
    let score = agentStatus(a, now) === 'running' ? 1 : 0
    for (const s of a.samples) if (s.at <= now && now - s.at <= SCORE_WINDOW_MS) score += s.output
    for (const p of pulses) if (p.agent === a.id && p.at <= now && now - p.at <= PULSE_WINDOW_MS) score += PULSE_SCORE
    if (score > bestScore || (score === bestScore && a.lastActivity > bestAt)) {
      best = a.id
      bestScore = score
      bestAt = a.lastActivity
    }
  }
  return best
}

/** A valid pin wins. Otherwise the current agent is held for SPOTLIGHT_HOLD_MS, then the spotlight follows the busiest. */
export function chooseSpotlight(prev: Spot | null, pinned: string | null, state: SwarmState, pulses: readonly Pulse[], now: number): Spot | null {
  const real = (id: string | null): id is string => id !== null && Object.hasOwn(state.agents, id) && !state.agents[id]!.placeholder
  if (real(pinned)) return prev !== null && prev.id === pinned ? prev : { id: pinned, since: now }
  const held = prev !== null && real(prev.id) ? prev : null
  if (held !== null && now - held.since < SPOTLIGHT_HOLD_MS) return held
  const next = busiest(state, pulses, now)
  if (next === null) return held
  return held !== null && held.id === next ? held : { id: next, since: now }
}

/** A one-row bar chart of `values`, newest on the right, scaled to its own maximum; missing values draw the baseline. */
export function sparkline(grid: Grid, x: number, y: number, width: number, values: readonly number[], color: number, bg?: number): void {
  const shown = values.slice(-width)
  const max = Math.max(0, ...shown)
  const offset = width - shown.length
  for (let i = 0; i < width; i++) {
    const v = i < offset ? 0 : (shown[i - offset] ?? 0)
    const level = v <= 0 || max <= 0 ? 0 : Math.max(1, Math.round((v / max) * 8))
    const fg = level === 0 ? TEXT.faint : mix(TEXT.faint, color, quantise(0.4 + (0.6 * v) / max, 4))
    grid.set(x + i, y, level === 0 ? LOWER_EIGHTH : 0x2580 + level, fg, bg)
  }
}

const SEP: Part = [' · ', TEXT.faint]

export function drawSpotlight(grid: Grid, area: Rect, s: AgentStats, a: AgentState, now: number, compact: boolean): void {
  if (area.h < 1 || area.w < 4) return
  const bg = CANVAS_RAISED
  grid.fill(area.x, area.y, area.w, area.h, bg)
  const x = area.x + 1
  const maxX = area.x + area.w - 1
  const color = modelColor(s.model)
  const status: Part[] = [[`${statusGlyph(s.status, s.placeholder)} ${s.status}`, STATUS[s.status]], SEP, [fmtDuration(s.lifetimeMs), TEXT.dim]]
  const fill = s.contextFill
  const fillPart: Part = [fmtPercent(fill), fill === null ? TEXT.dim : contextColor(fill)]
  // No agent.usage yet (spec section 11): tokens and cost show a dash, not zero. The model arrives with the first usage.
  const noUsage = s.model === null
  const tok = (n: number): string => (noUsage ? '–' : fmtTokens(n))
  const usd = noUsage ? '–' : fmtUsd(s.costUsd)

  if (compact) {
    writeParts(grid, x, area.y, [
      [`${GLYPH.dot} `, color], [clipText(s.name, 24), TEXT.primary], [' ', TEXT.dim], ...status, SEP,
      [`${tok(s.tokens.total)} tok`, TEXT.dim], SEP, [usd, TEXT.primary], [' · ctx ', TEXT.faint], fillPart,
    ], maxX, bg)
    return
  }

  const row = (i: number) => area.y + i
  const rows = area.h
  // 0: who
  writeParts(grid, x, row(0), [
    [`${GLYPH.dot} `, color], [clipText(s.name, 32), TEXT.primary], SEP, [clipText(s.role, 24), TEXT.dim], SEP, [s.model ?? 'model –', TEXT.dim],
  ], maxX, bg)
  writeRight(grid, row(0), status, x, maxX, bg)
  // 1: tokens and cost
  if (rows > 1) {
    const t = s.tokens
    writeParts(grid, x, row(1), [
      ['tokens ', TEXT.dim], [`in ${tok(t.input)}`, TEXT.primary], ['  ', TEXT.dim], [`out ${tok(t.output)}`, TEXT.primary],
      ['  cache ', TEXT.dim], [`r ${tok(t.cacheRead)} w ${tok(t.cacheWrite5m + t.cacheWrite1h)}`, TEXT.primary],
      ['  = ', TEXT.dim], [tok(t.total), TEXT.primary],
    ], maxX, bg)
    writeRight(grid, row(1), [[usd, TEXT.primary]], x, maxX, bg)
  }
  // 2: context bar and cache hit rate
  if (rows > 2) {
    let cx = writeParts(grid, x, row(2), [['context ', TEXT.dim]], maxX, bg)
    const filled = fill === null ? 0 : Math.round(fill * BAR_CELLS)
    for (let i = 0; i < BAR_CELLS && cx + i < maxX; i++) {
      grid.set(cx + i, row(2), i < filled ? FULL : LIGHT_SHADE, i < filled && fill !== null ? contextColor(fill) : TEXT.faint, bg)
    }
    cx += BAR_CELLS
    writeParts(grid, cx, row(2), [[' ', TEXT.dim], fillPart, ['  cache hit ', TEXT.dim], [fmtPercent(s.cacheHitRate), TEXT.primary]], maxX, bg)
  }
  // 3: speed and tokens sparklines
  if (rows > 3) {
    let cx = writeParts(grid, x, row(3), [['speed ≈ ', TEXT.dim], [s.speedTps === null ? '–' : `${Math.round(s.speedTps)} tok/s`, TEXT.primary], [' ', TEXT.dim]], maxX, bg)
    if (cx + SPARK_CELLS < maxX) {
      sparkline(grid, cx, row(3), SPARK_CELLS, s.speedSeries, color, bg)
      cx += SPARK_CELLS
      cx = writeParts(grid, cx, row(3), [['  tokens ', TEXT.dim]], maxX, bg)
      if (cx + SPARK_CELLS < maxX) sparkline(grid, cx, row(3), SPARK_CELLS, a.samples.map(sample => sample.output), color, bg)
    }
  }
  // 4: tool activity by kind, errors, stuck
  if (rows > 4) {
    const parts: Part[] = [['tools ', TEXT.dim]]
    for (const k of TOOL_KINDS) parts.push([`${KIND_LETTER[k]} `, KIND[k]], [`${s.tools[k]}  `, TEXT.primary])
    parts.push([' errors ', TEXT.dim], [String(s.errors), s.errors > 0 ? STATUS.failed : TEXT.primary])
    if (s.stuck) parts.push(['  ', TEXT.dim], [`${GLYPH.stuck} stuck`, STATUS.warn])
    writeParts(grid, x, row(4), parts, maxX, bg)
  }
  // 5: files, messages, clashes
  if (rows > 5) {
    const files: Part[] = [['files ', TEXT.dim], [String(s.files.length), TEXT.primary]]
    if (s.files.length > 0) files.push(['  ', TEXT.dim], [s.files.slice(-2).join(', '), TEXT.dim])
    const right: Part[] = [[`msgs ↓${s.messagesIn} ↑${s.messagesOut}`, TEXT.dim]]
    if (s.clashes.length > 0) right.push(['  ', TEXT.dim], [`${GLYPH.clash} clash ${clipText(s.clashes[0]!, 32)}`, STATUS.failed])
    const start = writeRight(grid, row(5), right, x, maxX, bg)
    writeParts(grid, x, row(5), files, Math.max(x, start - 1), bg)
  }
}
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `node --test tests/render/spotlight.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Pin the stats boundaries the spotlight and the frame rate lean on**

Phase 1's final review deferred three boundary tests to this phase (ledger): the 5 s running window, the 30 s speed window, and the recent-edit side of a live file clash. They pin existing `core/stats.ts` behaviour, so they pass at once; they live in their own file so no phase 1 test file changes.

`tests/core/stats-boundaries.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldAll } from '../../src/core/fold.ts'
import { CLASH_WINDOW_MS, RUNNING_WINDOW_MS, SPEED_WINDOW_MS, agentStatus, fileClashes, speed } from '../../src/core/stats.ts'
import { at, ev } from '../helpers.ts'

const started = () => ev('agent.started', { name: 'a', role: 'r', description: '', parent: 'lead' }, { agent: 'a', atSec: 0 })
const use = (sec: number, output: number) =>
  ev('agent.usage', { model: 'claude-opus-5-5', input: 1, output, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, { agent: 'a', atSec: sec })
const edit = (agent: string, sec: number) =>
  ev('agent.tool', { phase: 'start', tool: 'Edit', kind: 'edit', subject: 'f.ts', isError: false }, { agent, atSec: sec })

test('running lasts exactly RUNNING_WINDOW_MS after the last activity', () => {
  const a = foldAll('s1', [started(), use(1, 10)]).agents.a!
  assert.equal(agentStatus(a, at(1) + RUNNING_WINDOW_MS), 'running')
  assert.equal(agentStatus(a, at(1) + RUNNING_WINDOW_MS + 1), 'waiting')
})

test('speed counts a call exactly SPEED_WINDOW_MS old and drops it a millisecond later', () => {
  const a = foldAll('s1', [started(), use(10, 100)]).agents.a!
  assert.equal(speed(a, at(10) + SPEED_WINDOW_MS), 10)
  assert.equal(speed(a, at(10) + SPEED_WINDOW_MS + 1), null)
})

test('a live clash needs one of its edits within CLASH_WINDOW_MS of now', () => {
  const s = foldAll('s1', [edit('a', 0), edit('b', 60)])
  assert.equal(fileClashes(s, at(60) + CLASH_WINDOW_MS).length, 1)
  assert.equal(fileClashes(s, at(60) + CLASH_WINDOW_MS + 1).length, 0)
  assert.equal(fileClashes(s).length, 1)
})
```

Run: `node --test tests/core/stats-boundaries.test.ts`
Expected: PASS, 3 tests. If one fails, stop and report it: that is a phase 1 bug, not something to change here.

- [ ] **Step 6: Run the gate, then commit**

Run: `npm run check` (expected: green), then:

```bash
git add src/render/spotlight.ts tests/render/spotlight.test.ts tests/core/stats-boundaries.test.ts
git commit -m "Add the spotlight: busiest-agent choice with a hold and pins, sparklines and the per-agent stats card; pin the 5 s, 30 s and clash boundaries"
```

---
### Task 8: Text panels: header, summary, tree, timeline, feed  *(wave 2, parallel)*

**Files:**
- Create: `src/render/header.ts`, `src/render/tree.ts`, `src/render/timeline.ts`, `src/render/feed.ts`
- Test: `tests/render/panels.test.ts`

**Interfaces:**
- Consumes: `SwarmTotals`, `AgentStats`, `agentStatus` (`core/stats.ts`); `SwarmState`, `LEAD` (`core/fold.ts`); `Grid`, `Part`, `writeParts`, `writeRight`, `cp` (`grid.ts`); `mix`, `scale`, `desaturate` (`color.ts`); `fmt*`, `clipText` (`format.ts`); tokens; `Rect` (`types.ts`); `orderAgents`, `parentsOf` (`layout.ts`, Task 6 — same wave: code against the signatures in Task 6's Interfaces; the integrator merges Task 6 first).
- Produces:
  - `header.ts`: `drawHeader(grid, area: Rect, state: SwarmState, totals: SwarmTotals): void`, `drawSummary(grid, area: Rect, state: SwarmState, totals: SwarmTotals): void`, `summaryText(state, totals): string` (also the Svg `alt`).
  - `tree.ts`: `drawTree(grid, area: Rect, state: SwarmState, stats: Readonly<Record<string, AgentStats>>): void`.
  - `timeline.ts`: `drawTimeline(grid, area: Rect, state: SwarmState, now: number): void`.
  - `feed.ts`: `drawFeed(grid, area: Rect, state: SwarmState, now: number): void`, `nameOf(state, id): string`.

- [ ] **Step 1: Write the failing tests**

`tests/render/panels.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldAll } from '../../src/core/fold.ts'
import { agentStats, fileClashes, swarmTotals, type AgentStats } from '../../src/core/stats.ts'
import { drawFeed, nameOf } from '../../src/render/feed.ts'
import { fmtUsd } from '../../src/render/format.ts'
import { Grid, gridText } from '../../src/render/grid.ts'
import { drawHeader, drawSummary, summaryText } from '../../src/render/header.ts'
import { drawTimeline } from '../../src/render/timeline.ts'
import { CANVAS } from '../../src/render/tokens.ts'
import { drawTree } from '../../src/render/tree.ts'
import { rect } from '../../src/render/types.ts'
import { FIVE_AT, FIVE_SWARM, fiveAgentEvents } from '../fixtures/swarm-five.ts'

const mid = FIVE_AT.mid
const state = () => foldAll(FIVE_SWARM, fiveAgentEvents())
const statsOf = (s: ReturnType<typeof state>) => {
  const clashes = fileClashes(s, mid)
  const out: Record<string, AgentStats> = {}
  for (const id of Object.keys(s.agents)) out[id] = agentStats(s, id, mid, clashes)!
  return out
}

test('the header shows name, topology, agents, cost, tokens, burn, context and tasks', () => {
  const s = state()
  const totals = swarmTotals(s, mid)
  const g = new Grid(140, 2, CANVAS)
  drawHeader(g, rect(0, 0, 140, 2), s, totals)
  const [top, second] = gridText(g)
  assert.match(top!, /◆ auth refactor · hierarchical · 6 agents 4▶/)
  assert.ok(top!.includes(`${fmtUsd(totals.costUsd)}+`), 'a partial cost is marked +')
  assert.match(top!, / tok · ≈\$[\d.]+\/min · ctx 34%/)
  assert.match(top!, /cc \$1\.20/)
  assert.match(second!, /tasks 0 pending · 1 active · 1 done · 0 failed · memory 1 · ! 1 clash/)
})

test('the header shows log gaps on the right', () => {
  const s = state()
  s.gaps = 2
  const g = new Grid(140, 2, CANVAS)
  drawHeader(g, rect(0, 0, 140, 2), s, swarmTotals(s, mid))
  assert.match(gridText(g)[0]!, /⚠ 2 gaps $/)
})

test('the summary is one line', () => {
  const s = state()
  const totals = swarmTotals(s, mid)
  assert.match(summaryText(s, totals), /^◆ auth refactor · 6 agents 4▶ · ≈\$[\d.]+\+ · ctx 34%$/)
  const g = new Grid(40, 1, CANVAS)
  drawSummary(g, rect(0, 0, 40, 1), s, totals)
  assert.match(gridText(g)[0]!, /^ ◆ auth refactor · 6 agents/)
})

test('the tree lists agents depth first, indented by depth, and says how many did not fit', () => {
  const s = state()
  const g = new Grid(60, 12, CANVAS)
  drawTree(g, rect(0, 0, 60, 12), s, statsOf(s))
  const rows = gridText(g)
  const order = ['lead', 'architect', 'coder-1', 'coder-2', 'tester', 'reviewer', 'ghost'].map(name => rows.findIndex(r => r.includes(` ${name}`)))
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6])
  assert.deepEqual([rows[0]!.search(/\S/), rows[1]!.search(/\S/), rows[2]!.search(/\S/)], [1, 3, 5])
  const small = new Grid(60, 3, CANVAS)
  drawTree(small, rect(0, 0, 60, 3), s, statsOf(s))
  assert.match(gridText(small)[2]!, /… 5 more/)
})

test('the timeline has a row per agent and an axis; failed rows end in a cross', () => {
  const s = state()
  const g = new Grid(100, 7, CANVAS)
  drawTimeline(g, rect(0, 0, 100, 7), s, mid)
  const rows = gridText(g)
  assert.deepEqual(rows.slice(0, 6).map(r => /lead|architect|coder-1|coder-2|tester|reviewer/.exec(r)?.[0]), ['lead', 'architect', 'coder-1', 'coder-2', 'tester', 'reviewer'])
  const reviewer = rows[5]!
  assert.equal([...reviewer].filter(ch => ch === '✕').length, 2)
  assert.match(rows[1]!, /█/)
  assert.match(rows[6]!, /0s.*30s/)
})

test('the feed lists messages, memory writes and task changes, newest first', () => {
  const s = state()
  const g = new Grid(100, 4, CANVAS)
  drawFeed(g, rect(0, 0, 100, 4), s, mid)
  const rows = gridText(g)
  assert.match(rows[0]!, /^ {2}0s # task t2 → done/)
  assert.match(rows[1]!, /0s › architect → \?ghost: are you there/)
  assert.match(rows[2]!, /0s › lead → tester: rerun with a fixed seed/)
  assert.match(rows[3]!, /0s › architect → coder-1: use ed25519 keys/)
  assert.equal(nameOf(s, '?ghost'), '?ghost')
  assert.equal(nameOf(s, 'a-cod1'), 'coder-1')
  assert.equal(nameOf(s, 'nobody'), 'nobody')
})
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test tests/render/panels.test.ts`
Expected: FAIL, `Cannot find module` for `src/render/feed.ts`.

- [ ] **Step 3: Write `src/render/header.ts`**

```ts
/** The header (two rows: the swarm and its totals, then tasks and memory) and the one-line summary. Pure. */
import type { SwarmState } from '../core/fold.ts'
import type { SwarmTotals } from '../core/stats.ts'
import { fmtPercent, fmtTokens, fmtUsd } from './format.ts'
import { type Grid, type Part, writeParts, writeRight } from './grid.ts'
import { ACCENT, CANVAS_RAISED, GLYPH, STATUS, TEXT, contextColor } from './tokens.ts'
import type { Rect } from './types.ts'

const SEP: Part = [' · ', TEXT.faint]

const cost = (t: SwarmTotals): string => `${fmtUsd(t.costUsd)}${t.costPartial ? '+' : ''}`
const ctxPart = (t: SwarmTotals): Part =>
  t.contextPercent === null ? ['–', TEXT.dim] : [fmtPercent(t.contextPercent / 100), contextColor(t.contextPercent / 100)]

export function drawHeader(grid: Grid, area: Rect, state: SwarmState, totals: SwarmTotals): void {
  if (area.h < 1) return
  const bg = CANVAS_RAISED
  grid.fill(area.x, area.y, area.w, Math.min(area.h, 2), bg)
  const x = area.x + 1
  const maxX = area.x + area.w - 1
  const parts: Part[] = [
    [`${GLYPH.lead} `, ACCENT], [state.swarm.name, TEXT.primary], SEP, [state.swarm.topology, TEXT.dim], SEP,
    [`${totals.agents} agents`, TEXT.primary], [` ${totals.running}${GLYPH.running}`, STATUS.running], SEP,
    [cost(totals), TEXT.primary], SEP, [`${fmtTokens(totals.tokens)} tok`, TEXT.dim], SEP,
    [`${fmtUsd(totals.burnPerMin)}/min`, TEXT.dim], SEP, ['ctx ', TEXT.dim], ctxPart(totals),
  ]
  if (totals.sessionCostUsd !== null) parts.push(SEP, [`cc $${totals.sessionCostUsd.toFixed(2)}`, TEXT.dim])
  if (state.swarm.endedAt !== null) parts.push(SEP, ['ended', TEXT.dim])
  writeParts(grid, x, area.y, parts, maxX, bg)
  if (state.gaps > 0) writeRight(grid, area.y, [[`${GLYPH.gap} ${state.gaps} gaps`, STATUS.warn]], x, maxX, bg)
  if (area.h < 2) return
  const t = totals.tasks
  const second: Part[] = [
    ['tasks ', TEXT.dim], [`${t.pending} pending`, TEXT.primary], SEP, [`${t.active} active`, t.active > 0 ? STATUS.running : TEXT.primary], SEP,
    [`${t.done} done`, TEXT.primary], SEP, [`${t.failed} failed`, t.failed > 0 ? STATUS.failed : TEXT.primary], SEP,
    [`memory ${Object.keys(state.memory).length}`, TEXT.dim],
  ]
  if (totals.clashes > 0) second.push(SEP, [`${GLYPH.clash} ${totals.clashes} clash${totals.clashes === 1 ? '' : 'es'}`, STATUS.failed])
  const end = writeParts(grid, x, area.y + 1, second, maxX, bg)
  if (state.swarm.goal !== null && end + 4 < maxX) writeRight(grid, area.y + 1, [[state.swarm.goal, TEXT.dim]], end + 3, maxX, bg)
}

/** The one-line summary, also the words an Svg says for readers that cannot see it. */
export const summaryText = (state: SwarmState, totals: SwarmTotals): string =>
  `${GLYPH.lead} ${state.swarm.name} · ${totals.agents} agents ${totals.running}${GLYPH.running} · ${cost(totals)} · ctx ${ctxPart(totals)[0]}`

export function drawSummary(grid: Grid, area: Rect, state: SwarmState, totals: SwarmTotals): void {
  if (area.h < 1) return
  grid.fill(area.x, area.y, area.w, 1, CANVAS_RAISED)
  writeParts(grid, area.x + 1, area.y, [[summaryText(state, totals), TEXT.primary]], area.x + area.w, CANVAS_RAISED)
  if (state.gaps > 0) writeRight(grid, area.y, [[` ${GLYPH.gap} ${state.gaps}`, STATUS.warn]], area.x + 1, area.x + area.w, CANVAS_RAISED)
}
```

Note: the goal is written right-aligned and may be cut on the left by `writeRight`'s `minX`; that is fine (it is the least important text on the row).

- [ ] **Step 4: Write `src/render/tree.ts`**

```ts
/** The small-pane view: the swarm as an indented tree, one agent a row, depth first. Pure. */
import type { SwarmState } from '../core/fold.ts'
import type { AgentStats } from '../core/stats.ts'
import { clipText, fmtTokens, fmtUsd } from './format.ts'
import { type Grid, writeParts } from './grid.ts'
import { orderAgents, parentsOf } from './layout.ts'
import { STATUS, TEXT, modelColor, statusGlyph } from './tokens.ts'
import type { Rect } from './types.ts'

const MAX_INDENT = 8

export function drawTree(grid: Grid, area: Rect, state: SwarmState, stats: Readonly<Record<string, AgentStats>>): void {
  const parents = parentsOf(state)
  const agents = orderAgents(state)
  const kids = new Map<string, string[]>()
  const roots: string[] = []
  for (const a of agents) {
    const p = parents.get(a.id) ?? null
    if (p === null) roots.push(a.id)
    else kids.set(p, [...(kids.get(p) ?? []), a.id])
  }
  const rows: Array<{ id: string; depth: number }> = []
  const seen = new Set<string>()
  const walk = (id: string, depth: number): void => {
    if (seen.has(id)) return
    seen.add(id)
    rows.push({ id, depth })
    for (const k of kids.get(id) ?? []) walk(k, depth + 1)
  }
  for (const r of roots) walk(r, 0)
  for (const a of agents) walk(a.id, 0)
  const room = area.h
  const shown = rows.length > room ? rows.slice(0, Math.max(0, room - 1)) : rows
  const maxX = area.x + area.w - 1
  shown.forEach((row, i) => {
    const s = Object.hasOwn(stats, row.id) ? stats[row.id]! : null
    if (s === null) return
    const nameColor = s.status === 'failed' ? STATUS.failed : s.placeholder ? TEXT.dim : modelColor(s.model)
    writeParts(grid, area.x + 1, area.y + i, [
      ['  '.repeat(Math.min(row.depth, MAX_INDENT)), TEXT.dim],
      [`${statusGlyph(s.status, s.placeholder)} `, STATUS[s.status]],
      [clipText(s.name, 24), nameColor],
      ['  ', TEXT.dim],
      [s.model === null ? '– tok · –' : `${fmtTokens(s.tokens.total)} tok · ${fmtUsd(s.costUsd)}`, TEXT.dim],
    ], maxX)
  })
  if (rows.length > room && room > 0) writeParts(grid, area.x + 1, area.y + room - 1, [[`… ${rows.length - shown.length} more`, TEXT.dim]], maxX)
}
```

- [ ] **Step 5: Write `src/render/timeline.ts`**

```ts
/** The timeline: one row per agent showing its current run across the swarm's lifetime; running rows grow live. Pure. */
import type { SwarmState } from '../core/fold.ts'
import { agentStatus } from '../core/stats.ts'
import { desaturate, mix, scale } from './color.ts'
import { clipText, fmtDuration } from './format.ts'
import { type Grid, cp, writeParts, writeRight } from './grid.ts'
import { orderAgents } from './layout.ts'
import { CANVAS, GLYPH, STATUS, TEXT, modelColor, statusGlyph } from './tokens.ts'
import type { Rect } from './types.ts'

const FULL = 0x2588
/** Left-aligned blocks, one eighth to seven eighths wide. */
const LEFT_EIGHTHS = [0x2588, 0x258f, 0x258e, 0x258d, 0x258c, 0x258b, 0x258a, 0x2589] as const
const AXIS = cp('─')
const CORNER = cp('└')

function bar(grid: Grid, x0: number, y: number, from: number, to: number, color: number): void {
  const a = Math.floor(from)
  const full = Math.floor(to)
  const frac = Math.round((to - full) * 8)
  for (let x = a; x < full; x++) grid.set(x0 + x, y, FULL, color)
  if (frac >= 8) grid.set(x0 + full, y, FULL, color)
  else if (frac > 0) grid.set(x0 + full, y, LEFT_EIGHTHS[frac]!, color)
  else if (full === a) grid.set(x0 + a, y, LEFT_EIGHTHS[1], color)
}

export function drawTimeline(grid: Grid, area: Rect, state: SwarmState, now: number): void {
  if (area.h < 2 || area.w < 20) return
  const agents = orderAgents(state).filter(a => !a.placeholder)
  const labelW = Math.min(14, Math.floor(area.w / 4))
  const x0 = area.x + labelW + 1
  const width = area.x + area.w - 1 - x0
  if (width < 4) return
  const start = state.swarm.startedAt ?? Math.min(now, ...agents.map(a => a.startedAt))
  const span = Math.max(1000, now - start)
  const toX = (t: number): number => ((Math.max(start, Math.min(now, t)) - start) / span) * (width - 1)
  const rows = Math.min(agents.length, area.h - 1)
  for (let i = 0; i < rows; i++) {
    const a = agents[i]!
    const y = area.y + i
    const status = agentStatus(a, now)
    writeParts(grid, area.x + 1, y, [[`${statusGlyph(status)} `, STATUS[status]], [clipText(a.name, labelW - 3), TEXT.dim]], x0 - 1)
    const from = toX(a.startedAt)
    const to = Math.max(from, toX(a.finishedAt ?? now))
    const base = modelColor(a.model)
    const color = status === 'failed' ? STATUS.failed
      : status === 'done' ? mix(desaturate(base, 0.6), CANVAS, 0.45)
      : status === 'waiting' ? scale(base, 0.72) : base
    bar(grid, x0, y, from, to, color)
    if (status === 'running') grid.set(x0 + Math.min(width - 1, Math.floor(to)), y, FULL, mix(color, 0xffffff, 0.35))
    if (status === 'failed') grid.set(x0 + Math.min(width - 1, Math.floor(to) + 1), y, cp(GLYPH.failed), STATUS.failed)
  }
  const axisY = area.y + area.h - 1
  grid.set(x0 - 1, axisY, CORNER, TEXT.faint)
  for (let x = 0; x < width; x++) grid.set(x0 + x, axisY, AXIS, TEXT.faint)
  writeParts(grid, x0, axisY, [['0s', TEXT.dim]], x0 + width)
  writeRight(grid, axisY, [[fmtDuration(span), TEXT.dim]], x0 + 3, x0 + width)
  if (agents.length > rows) writeParts(grid, area.x + 1, axisY, [[`… +${agents.length - rows}`, TEXT.dim]], x0 - 1)
}
```

- [ ] **Step 6: Write `src/render/feed.ts`**

```ts
/** The flow feed: messages, memory writes, task changes and agent starts and ends, newest first. Pure. */
import type { SwarmState } from '../core/fold.ts'
import { fmtAge } from './format.ts'
import { type Grid, type Part, writeParts } from './grid.ts'
import { FEED_COLOR, FEED_MARK, TEXT } from './tokens.ts'
import type { Rect } from './types.ts'

/** An agent's display name; a placeholder for a name nobody had is shown as `?name`. */
export function nameOf(state: SwarmState, id: string): string {
  if (!Object.hasOwn(state.agents, id)) return id
  const a = state.agents[id]!
  return a.placeholder ? `?${a.name}` : a.name
}

export function drawFeed(grid: Grid, area: Rect, state: SwarmState, now: number): void {
  if (area.h < 1) return
  const items = state.feed.slice(-area.h).reverse()
  const maxX = area.x + area.w - 1
  items.forEach((item, i) => {
    const parts: Part[] = [[fmtAge(now - item.at).padStart(4), TEXT.faint], [` ${FEED_MARK[item.kind]} `, FEED_COLOR[item.kind]]]
    if (item.kind === 'message') {
      parts.push([nameOf(state, item.agent), TEXT.primary], [' → ', TEXT.faint], [nameOf(state, item.to ?? '?'), TEXT.primary], [': ', TEXT.faint], [item.text, FEED_COLOR.message])
    } else {
      parts.push([item.text, FEED_COLOR[item.kind]])
    }
    writeParts(grid, area.x, area.y + i, parts, maxX)
  })
}
```

- [ ] **Step 7: Run the tests to make sure they pass**

Run: `node --test tests/render/panels.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 8: Run the gate, then commit**

Run: `npm run check` (expected: green), then:

```bash
git add src/render/header.ts src/render/tree.ts src/render/timeline.ts src/render/feed.ts tests/render/panels.test.ts
git commit -m "Add the pane's text panels: header, one-line summary, indented tree, timeline and flow feed"
```

---

### Task 9: The Svg fallback for the desktop surface  *(wave 2, parallel)*

**Files:**
- Create: `src/render/svg.ts`
- Test: `tests/render/svg.test.ts`

**Interfaces:**
- Consumes: `Grid` (`grid.ts`); `DEFAULT`, `hex` (`color.ts`).
- Produces: `SVG_SOURCE_MAX = 131_072`, `CELL_W = 8`, `CELL_H = 16`, `blockShape(cp): readonly [x, y, w, h, opacity] | null`, `escapeXml(text): string`, `gridToSvg(grid, alt, max?): string | null` (null when the document would pass `max`; the caller then shows the summary as text).

- [ ] **Step 1: Write the failing tests**

`tests/render/svg.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT } from '../../src/render/color.ts'
import { Grid } from '../../src/render/grid.ts'
import { blockShape, escapeXml, gridToSvg } from '../../src/render/svg.ts'

test('a half-block cell is a background rectangle and a top-half rectangle', () => {
  const g = new Grid(1, 1)
  g.set(0, 0, 0x2580, 0xff0000, 0x0000ff)
  const svg = gridToSvg(g, 'one cell')!
  assert.ok(svg.includes('<path fill="#0000ff" d="M0 0h8v16h-8z"/>'))
  assert.ok(svg.includes('<path fill="#ff0000" d="M0 0h8v8h-8z"/>'))
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="16"'))
  assert.ok(svg.includes('<title>one cell</title>'))
})

test('braille dots become small squares, shades get opacity, text is escaped', () => {
  const g = new Grid(4, 1)
  g.set(0, 0, 0x2801, 0xffffff)
  g.set(1, 0, 0x2591, 0x00ff00)
  g.text(2, 0, 'A<', 0xeeeeee)
  const svg = gridToSvg(g, 'a & b')!
  assert.ok(svg.includes('M1 1h2v2h-2z'))
  assert.ok(svg.includes('fill-opacity="0.25"'))
  assert.ok(svg.includes('x="16 24"'))
  assert.ok(svg.includes('>A&lt;</text>'))
  assert.ok(svg.includes('<title>a &amp; b</title>'))
})

test('the terminal default background is left transparent, and an oversize document is refused', () => {
  const g = new Grid(2, 1, DEFAULT)
  g.set(0, 0, 0x41, 0xffffff)
  assert.ok(!gridToSvg(g, 'x')!.includes('<path'))
  assert.equal(gridToSvg(g, 'x', 10), null)
})

test('block shapes and escaping', () => {
  assert.deepEqual(blockShape(0x2588), [0, 0, 1, 1, 1])
  assert.deepEqual(blockShape(0x2584), [0, 0.5, 1, 0.5, 1])
  assert.deepEqual(blockShape(0x258c), [0, 0, 0.5, 1, 1])
  assert.equal(blockShape(0x41), null)
  assert.equal(escapeXml('<a href="x">\'&</a>\u0001'), '&lt;a href=&quot;x&quot;&gt;&apos;&amp;&lt;/a&gt;')
})
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test tests/render/svg.test.ts`
Expected: FAIL, `Cannot find module` for `src/render/svg.ts`.

- [ ] **Step 3: Write `src/render/svg.ts`**

```ts
/**
 * The same Grid as an SVG document, for surfaces that draw vectors instead of a Raster (the desktop app). Block and
 * braille glyphs become rectangles so they line up whatever the font; other glyphs are placed cell by cell. Pure.
 */
import { DEFAULT, hex } from './color.ts'
import type { Grid } from './grid.ts'

/** The host's limit on an Svg element's source; past it the whole tree would be refused. */
export const SVG_SOURCE_MAX = 131_072
export const CELL_W = 8
export const CELL_H = 16
/** The terminal's own foreground has no value off the terminal: a grey that reads on light and dark pages. */
const DEFAULT_FG = '#8b949e'
const FONT = 'font-family="SFMono-Regular, Menlo, Consolas, DejaVu Sans Mono, monospace" font-size="13"'
/** Braille dot bit to [column, row] in the 2x4 cell. */
const DOTS: ReadonlyArray<readonly [number, number]> = [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2], [0, 3], [1, 3]]

/** A block glyph as fractions of a cell [x, y, w, h] and an opacity, or null for any other glyph. */
export function blockShape(cp: number): readonly [number, number, number, number, number] | null {
  if (cp === 0x2580) return [0, 0, 1, 0.5, 1]
  if (cp >= 0x2581 && cp <= 0x2588) {
    const n = cp - 0x2580
    return [0, 1 - n / 8, 1, n / 8, 1]
  }
  if (cp >= 0x2589 && cp <= 0x258f) return [0, 0, (0x2590 - cp) / 8, 1, 1]
  if (cp === 0x2590) return [0.5, 0, 0.5, 1, 1]
  if (cp >= 0x2591 && cp <= 0x2593) return [0, 0, 1, 1, (cp - 0x2590) / 4]
  return null
}

/** Escapes text for an element body or attribute, dropping code points XML 1.0 cannot hold. */
export function escapeXml(text: string): string {
  let out = ''
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || (c >= 0xd800 && c <= 0xdfff) || c === 0xfffe || c === 0xffff) continue
    out += ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : ch === "'" ? '&apos;' : ch
  }
  return out
}

const num = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''))

/** Rectangles grouped by fill and opacity: one path per colour, not one element per cell. */
class Fills {
  readonly #paths = new Map<string, string[]>()

  rect(fill: string, opacity: number, x: number, y: number, w: number, h: number): void {
    const key = opacity === 1 ? fill : `${fill}|${num(opacity)}`
    const d = `M${num(x)} ${num(y)}h${num(w)}v${num(h)}h${num(-w)}z`
    const list = this.#paths.get(key)
    if (list === undefined) this.#paths.set(key, [d])
    else list.push(d)
  }

  toSvg(): string {
    return [...this.#paths].map(([key, list]) => {
      const [fill, opacity] = key.split('|')
      return `<path fill="${fill}"${opacity === undefined ? '' : ` fill-opacity="${opacity}"`} d="${list.join('')}"/>`
    }).join('')
  }
}

export function gridToSvg(grid: Grid, alt: string, max = SVG_SOURCE_MAX): string | null {
  const back = new Fills()
  const fore = new Fills()
  const texts: string[] = []
  let size = 0
  for (let y = 0; y < grid.rows; y++) {
    for (let x = 0; x < grid.columns;) {
      const bg = grid.bg(x, y)
      let end = x + 1
      while (end < grid.columns && grid.bg(end, y) === bg) end++
      if (bg !== DEFAULT) {
        back.rect(hex(bg), 1, x * CELL_W, y * CELL_H, (end - x) * CELL_W, CELL_H)
        size += 28
      }
      x = end
    }
    let run: { fg: string; xs: number[]; text: string } | null = null
    const flush = (): void => {
      if (run === null) return
      const el = `<text ${FONT} fill="${run.fg}" x="${run.xs.join(' ')}" y="${y * CELL_H + 12}" xml:space="preserve">${run.text}</text>`
      texts.push(el)
      size += el.length
      run = null
    }
    for (let x = 0; x < grid.columns; x++) {
      const code = grid.glyph(x, y)
      const fgRaw = grid.fg(x, y)
      const fg = fgRaw === DEFAULT ? DEFAULT_FG : hex(fgRaw)
      const shape = blockShape(code)
      if (shape !== null) {
        flush()
        const [sx, sy, sw, sh, opacity] = shape
        fore.rect(fg, opacity, (x + sx) * CELL_W, (y + sy) * CELL_H, sw * CELL_W, sh * CELL_H)
        size += 28
      } else if (code > 0x2800 && code <= 0x28ff) {
        flush()
        for (let bit = 0; bit < 8; bit++) {
          if (((code - 0x2800) >> bit) & 1) {
            const [col, row] = DOTS[bit]!
            fore.rect(fg, 1, x * CELL_W + col * 4 + 1, y * CELL_H + row * 4 + 1, 2, 2)
            size += 20
          }
        }
      } else if (code === 0x20 || code === 0x2800) {
        flush()
      } else {
        const glyph = escapeXml(String.fromCodePoint(code))
        if (glyph === '') flush()
        else if (run !== null && run.fg === fg) {
          run.text += glyph
          run.xs.push(x * CELL_W)
        } else {
          flush()
          run = { fg, xs: [x * CELL_W], text: glyph }
        }
      }
      if (size > max) return null
    }
    flush()
  }
  const width = grid.columns * CELL_W
  const height = grid.rows * CELL_H
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img"><title>${escapeXml(alt)}</title>${back.toSvg()}${fore.toSvg()}${texts.join('')}</svg>`
  return svg.length > max ? null : svg
}
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `node --test tests/render/svg.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Run the gate, then commit**

Run: `npm run check` (expected: green), then:

```bash
git add src/render/svg.ts tests/render/svg.test.ts
git commit -m "Add the Svg fallback that draws the same cell grid on surfaces without a Raster"
```

---

### Task 10: The pane's model between pulls  *(wave 2, parallel)*

**Files:**
- Create: `src/mod/pane-model.ts`
- Test: `tests/mod/pane-model.test.ts`

**Interfaces:**
- Consumes: `FeedReply` (`core/feed-reply.ts`, Task 3); `fold`, `LEAD`, `SwarmState` (`core/fold.ts`); `TOOL_KINDS`, `isOneOf`, `SwarmEvent` (`core/events.ts`); `Pulse` (`render/types.ts`, Task 4).
- Produces: `type PaneModel = { swarm: string | null; offset: number; state: SwarmState | null; pulses: Pulse[]; lagMs: number }`, `PULSE_KEEP_MS = 2000`, `MAX_PULSES = 64`, `MAX_LAG_MS = 1000`, `emptyModel(): PaneModel`, `feedArgs(m): { since: number; swarm?: string }`, `pulsesFrom(events): Pulse[]`, `prunePulses(pulses, now): Pulse[]`, `type Applied = { model: PaneModel; changed: boolean; swarmChanged: boolean }`, `applyReply(m, reply: FeedReply, arrivedAt: number): Applied`.

The pane folds the events the server hands it with the same `fold` the server uses (spec §10's `since: N` design); it never reads the log. Pure and mod-safe (no `claude-code` import), so it is tested here with `node --test` and the static check in Task 4 covers it.

- [ ] **Step 1: Write the failing tests**

`tests/mod/pane-model.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FeedReply } from '../../src/core/feed-reply.ts'
import { emptyState, foldAll } from '../../src/core/fold.ts'
import { MAX_PULSES, applyReply, emptyModel, feedArgs, prunePulses, pulsesFrom } from '../../src/mod/pane-model.ts'
import { FIVE_SWARM, FIVE_T0, fiveAgentEvents } from '../fixtures/swarm-five.ts'

const events = fiveAgentEvents()

test('the first pull asks for everything, later pulls ask for what is new', () => {
  assert.deepEqual(feedArgs(emptyModel()), { since: 0 })
  const { model } = applyReply(emptyModel(), { v: 1, kind: 'state', swarm: FIVE_SWARM, offset: 120, state: emptyState(FIVE_SWARM) }, FIVE_T0)
  assert.deepEqual(feedArgs(model), { since: 120, swarm: FIVE_SWARM })
})

test('a state reply replaces the model and says whether the swarm changed', () => {
  const state = foldAll(FIVE_SWARM, events.slice(0, 10))
  const a = applyReply(emptyModel(), { v: 1, kind: 'state', swarm: FIVE_SWARM, offset: 10, state }, FIVE_T0)
  assert.deepEqual([a.changed, a.swarmChanged, a.model.state === state, a.model.offset], [true, true, true, 10])
  const b = applyReply(a.model, { v: 1, kind: 'state', swarm: FIVE_SWARM, offset: 20, state }, FIVE_T0)
  assert.equal(b.swarmChanged, false)
})

test('an events reply is folded in, with pulses, gaps, the new offset and an arrival lag', () => {
  const start = applyReply(emptyModel(), { v: 1, kind: 'state', swarm: FIVE_SWARM, offset: 100, state: foldAll(FIVE_SWARM, events.slice(0, 17)) }, FIVE_T0).model
  const reply: FeedReply = { v: 1, kind: 'events', swarm: FIVE_SWARM, offset: 200, events: events.slice(17, 27), bad: 1 }
  const r = applyReply(start, reply, FIVE_T0 + 14_500)
  assert.equal(r.changed, true)
  assert.equal(r.model.offset, 200)
  assert.ok(r.model.state !== null && Object.hasOwn(r.model.state.agents, 'a-test') && Object.hasOwn(r.model.state.agents, 'a-rev'))
  assert.equal(r.model.state.gaps, 1)
  assert.equal(r.model.pulses.length, 4)
  assert.equal(r.model.pulses.filter(p => p.isError).length, 2)
  assert.equal(r.model.lagMs, 40)
})

test('an empty events reply changes nothing but the offset', () => {
  const start = applyReply(emptyModel(), { v: 1, kind: 'state', swarm: FIVE_SWARM, offset: 100, state: emptyState(FIVE_SWARM) }, FIVE_T0).model
  const r = applyReply(start, { v: 1, kind: 'events', swarm: FIVE_SWARM, offset: 100, events: [], bad: 0 }, FIVE_T0)
  assert.equal(r.changed, false)
})

test('events for another swarm reset the model so the next pull asks for everything', () => {
  const start = applyReply(emptyModel(), { v: 1, kind: 'state', swarm: FIVE_SWARM, offset: 100, state: emptyState(FIVE_SWARM) }, FIVE_T0).model
  const r = applyReply(start, { v: 1, kind: 'events', swarm: 'other', offset: 5, events: [], bad: 0 }, FIVE_T0)
  assert.deepEqual(feedArgs(r.model), { since: 0 })
  assert.equal(r.swarmChanged, true)
})

test('none leaves the model as it was', () => {
  const m = emptyModel()
  const r = applyReply(m, { v: 1, kind: 'none' }, FIVE_T0)
  assert.equal(r.model, m)
  assert.equal(r.changed, false)
})

test('pulses come from tool starts and failed tool ends, and old ones are dropped', () => {
  const all = pulsesFrom(events)
  assert.equal(all.length, 11)
  assert.equal(all.filter(p => p.isError).length, 3)
  assert.deepEqual(all[0], { agent: 'a-arch', kind: 'read', at: FIVE_T0 + 3000, isError: false })
  assert.equal(prunePulses(all, FIVE_T0 + 30_000).length, 2)
  const many = Array.from({ length: 100 }, (_, i) => ({ agent: 'x', kind: 'bash' as const, at: FIVE_T0 + i, isError: false }))
  assert.equal(prunePulses(many, FIVE_T0 + 100).length, MAX_PULSES)
})
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test tests/mod/pane-model.test.ts`
Expected: FAIL, `Cannot find module` for `src/mod/pane-model.ts`.

- [ ] **Step 3: Write `src/mod/pane-model.ts`**

```ts
/**
 * What the pane holds between pulls: the swarm it follows, the offset it has read to, its own fold of the state (from
 * the events the server hands it, never from the log), recent tool pulses and how late events arrive. Pure, mod-safe.
 */
import { TOOL_KINDS, isOneOf, type SwarmEvent } from '../core/events.ts'
import type { FeedReply } from '../core/feed-reply.ts'
import { LEAD, fold, type SwarmState } from '../core/fold.ts'
import type { Pulse } from '../render/types.ts'

export type PaneModel = { swarm: string | null; offset: number; state: SwarmState | null; pulses: Pulse[]; lagMs: number }

/** Pulses older than this have finished flickering. */
export const PULSE_KEEP_MS = 2_000
export const MAX_PULSES = 64
/** A newest event older than this on arrival is history (a fresh load), not lag. */
export const MAX_LAG_MS = 1_000

export const emptyModel = (): PaneModel => ({ swarm: null, offset: 0, state: null, pulses: [], lagMs: 0 })

/** The arguments of the next omnis_feed pull. */
export const feedArgs = (m: PaneModel): { since: number; swarm?: string } =>
  m.swarm === null || m.state === null ? { since: 0 } : { since: m.offset, swarm: m.swarm }

export function pulsesFrom(events: readonly SwarmEvent[]): Pulse[] {
  const out: Pulse[] = []
  for (const e of events) {
    if (e.type !== 'agent.tool') continue
    const at = Date.parse(e.ts)
    if (Number.isNaN(at)) continue
    const kind = isOneOf(TOOL_KINDS, e.data.kind) ? e.data.kind : 'other'
    const agent = e.agent ?? LEAD
    if (e.data.phase === 'start') out.push({ agent, kind, at, isError: false })
    else if (e.data.isError === true) out.push({ agent, kind, at, isError: true })
  }
  return out
}

export const prunePulses = (pulses: readonly Pulse[], now: number): Pulse[] =>
  pulses.filter(p => now - p.at <= PULSE_KEEP_MS).slice(-MAX_PULSES)

export type Applied = { model: PaneModel; changed: boolean; swarmChanged: boolean }

export function applyReply(m: PaneModel, reply: FeedReply, arrivedAt: number): Applied {
  if (reply.kind === 'none') return { model: m, changed: false, swarmChanged: false }
  if (reply.kind === 'state') {
    const swarmChanged = reply.swarm !== m.swarm
    return {
      model: { swarm: reply.swarm, offset: reply.offset, state: reply.state, pulses: swarmChanged ? [] : prunePulses(m.pulses, arrivedAt), lagMs: swarmChanged ? 0 : m.lagMs },
      changed: true,
      swarmChanged,
    }
  }
  if (reply.swarm !== m.swarm || m.state === null) return { model: emptyModel(), changed: false, swarmChanged: m.swarm !== null }
  const state = m.state
  let newest = Number.NEGATIVE_INFINITY
  for (const e of reply.events) {
    fold(state, e)
    const at = Date.parse(e.ts)
    if (at > newest) newest = at
  }
  state.gaps += reply.bad
  const sample = arrivedAt - newest
  const lagMs = Number.isFinite(sample) && sample >= 0 && sample <= MAX_LAG_MS ? Math.round(m.lagMs * 0.8 + sample * 0.2) : m.lagMs
  return {
    model: { swarm: m.swarm, offset: reply.offset, state, pulses: prunePulses([...m.pulses, ...pulsesFrom(reply.events)], arrivedAt), lagMs },
    changed: reply.events.length > 0 || reply.bad > 0,
    swarmChanged: false,
  }
}
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `node --test tests/mod/pane-model.test.ts tests/render/mod-safe.test.ts`
Expected: PASS, 8 tests (the mod-safe walk now covers `src/mod/pane-model.ts` too).

- [ ] **Step 5: Run the gate, then commit**

Run: `npm run check` (expected: green), then:

```bash
git add src/mod/pane-model.ts tests/mod/pane-model.test.ts
git commit -m "Add the pane's model: fold the feed's events, track tool pulses and arrival lag, and say when to pull everything again"
```

---
### Task 11: The graph  *(wave 3, serial)*

**Files:**
- Create: `src/render/graph.ts`
- Test: `tests/render/graph.test.ts`

**Interfaces:**
- Consumes: `Pixels`, `Dots`, `compose`, `toDots` (Task 5); `arc`, `comet`, `fadeIn`, `ghost`, `glow`, `flash`, `blink`, `hashUnit` (Task 5); `orderAgents`, `structuralEdges`, `layoutNodes` (Task 6); `Grid`, `cp`, `safeGlyph` (Task 4); `mix`, `scale`, `desaturate`, `quantise` (Task 4); tokens; `clipText`; `AgentStats`, `Clash`, `fileClashes`, `agentStats` (`core/stats.ts`); `AgentState`, `SwarmState`, `LEAD` (`core/fold.ts`); `View`, `Point`, `Rect` (`types.ts`). Tests also use `pulsesFrom` (Task 10).
- Produces: `type GraphInput = { state; stats: Readonly<Record<string, AgentStats>>; positions: Readonly<Record<string, Point>>; clashes: readonly Clash[]; view: View; now: number; tEff: number }`, `nodeRadius(tokens, maxRadius): number`, `nodeColor(s: AgentStats, a: AgentState, now): number`, `lastEditAt(state, path): number`, `clashActive(state, clash, now): boolean`, `drawGraph(grid, area: Rect, input: GraphInput): void`.

What it draws, in paint order (spec §10 graph bullets): heavy message links as dim pixel lines; nodes (size from tokens, colour from model, lit core, glow halo while running, context ring amber from 70% and red from 90%, fade in on start, ghost when done, red when failed, a rim flicker in the tool kind's colour on each tool pulse, a red rim on a failed tool, an amber breathing rim when stuck, a blinking red rim for a fresh file clash); faint dotted structural edges (straight); message links as gentle arcs (`GRAPH.linkBend`) that brighten after each message and double once busy, so they never lie on a parent edge or run through a node on the same row; a dashed red line between agents that edited the same file; comets with a fading trail along each recent message's arc; then a label under each node (status glyph and name, the lead marked `◆`). `tEff = now - lag` so comets start at the sender even when events arrive late. `fileClashes` is computed once per frame by the caller and passed in (ledger item).

- [ ] **Step 1: Write the failing tests**

`tests/render/graph.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldAll, type SwarmState } from '../../src/core/fold.ts'
import { agentStats, fileClashes, type AgentStats } from '../../src/core/stats.ts'
import { pulsesFrom } from '../../src/mod/pane-model.ts'
import { desaturate, mix, scale } from '../../src/render/color.ts'
import { drawGraph, nodeColor, nodeRadius } from '../../src/render/graph.ts'
import { Grid, gridText, pairCount } from '../../src/render/grid.ts'
import { layoutNodes } from '../../src/render/layout.ts'
import { CANVAS, GRAPH, LINK, MODEL, STATUS } from '../../src/render/tokens.ts'
import { emptyView, rect } from '../../src/render/types.ts'
import { FIVE_AT, FIVE_SWARM, fiveAgentEvents } from '../fixtures/swarm-five.ts'
import { ev } from '../helpers.ts'

const statsOf = (s: SwarmState, now: number) => {
  const clashes = fileClashes(s, now)
  const out: Record<string, AgentStats> = {}
  for (const id of Object.keys(s.agents)) out[id] = agentStats(s, id, now, clashes)!
  return { stats: out, clashes }
}

function draw(s: SwarmState, now: number, w = 120, h = 24): Grid {
  const g = new Grid(w, h, CANVAS)
  const { stats, clashes } = statsOf(s, now)
  const positions = layoutNodes(s, s.swarm.topology, w, h * 2)
  drawGraph(g, rect(0, 0, w, h), { state: s, stats, positions, clashes, view: { ...emptyView(), pulses: pulsesFrom(fiveAgentEvents()) }, now, tEff: now })
  return g
}

const cells = (g: Grid) => Array.from({ length: g.columns * g.rows }, (_, i) => ({ x: i % g.columns, y: Math.floor(i / g.columns) }))
  .map(({ x, y }) => ({ glyph: g.glyph(x, y), fg: g.fg(x, y), bg: g.bg(x, y) }))

test('node radius grows with the log of tokens, within its limits', () => {
  assert.equal(nodeRadius(0, 6), GRAPH.minRadius)
  assert.ok(nodeRadius(1_000_000, 6) > nodeRadius(10_000, 6))
  assert.equal(nodeRadius(1e12, 6), 6)
  assert.equal(nodeRadius(1_000_000, 3), 3)
})

test('node colour follows status: running in the model colour, waiting dimmer, done a ghost, failed red, new ones faded', () => {
  const s = foldAll(FIVE_SWARM, fiveAgentEvents())
  const mid = FIVE_AT.mid
  const st = statsOf(s, mid).stats
  assert.equal(nodeColor(st['a-cod1']!, s.agents['a-cod1']!, mid), MODEL.sonnet)
  assert.equal(nodeColor(st['a-rev']!, s.agents['a-rev']!, mid), STATUS.failed)
  assert.equal(nodeColor(st['a-cod2']!, s.agents['a-cod2']!, mid), mix(desaturate(MODEL.sonnet, 0.7), CANVAS, 0.55))
  const idle = statsOf(s, FIVE_AT.idle).stats
  assert.equal(nodeColor(idle['a-arch']!, s.agents['a-arch']!, FIVE_AT.idle), scale(MODEL.opus, 0.72))
  assert.equal(nodeColor(st['a-cod1']!, s.agents['a-cod1']!, s.agents['a-cod1']!.startedAt), CANVAS)
})

test('mid-swarm: every agent is labelled, comets fly, the clash is drawn and the failed node is red', () => {
  const g = draw(foldAll(FIVE_SWARM, fiveAgentEvents()), FIVE_AT.mid)
  const text = gridText(g).join('\n')
  for (const name of ['lead', 'architect', 'coder-1', 'coder-2', 'tester', 'reviewer', 'ghost']) assert.ok(text.includes(name), name)
  const all = cells(g)
  assert.ok(all.some(c => c.fg === LINK.comet), 'a comet head')
  assert.ok(all.some(c => c.glyph > 0x2800 && c.glyph <= 0x28ff && c.fg === LINK.clash), 'a dashed clash line')
  assert.ok(all.some(c => (c.glyph === 0x2580 || c.glyph === 0x20) && (c.fg === STATUS.failed || c.bg === STATUS.failed)), 'a red node')
  assert.ok(pairCount(g) <= 1024)
})

test('once everything has settled there are no comets', () => {
  const g = draw(foldAll(FIVE_SWARM, fiveAgentEvents()), FIVE_AT.idle)
  assert.ok(!cells(g).some(c => c.fg === LINK.comet))
})

test('mesh and star layouts draw too', () => {
  for (const topology of ['mesh', 'star'] as const) {
    const text = gridText(draw(foldAll(FIVE_SWARM, fiveAgentEvents(topology)), FIVE_AT.mid)).join('\n')
    assert.ok(text.includes('architect') && text.includes('reviewer'), topology)
  }
})

test('a parent loop and an empty swarm draw without trouble', () => {
  const looped = foldAll('s1', [
    ev('agent.started', { name: 'a', role: 'r', description: '', parent: 'b' }, { agent: 'a', atSec: 0 }),
    ev('agent.started', { name: 'b', role: 'r', description: '', parent: 'a' }, { agent: 'b', atSec: 1 }),
  ])
  assert.ok(gridText(draw(looped, Date.parse('2026-10-21T10:00:10.000Z'))).join('').includes('a'))
  const empty = draw(foldAll('s1', []), FIVE_AT.mid)
  assert.ok(cells(empty).every(c => c.bg === CANVAS))
})
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test tests/render/graph.test.ts`
Expected: FAIL, `Cannot find module` for `src/render/graph.ts`.

- [ ] **Step 3: Write `src/render/graph.ts`**

```ts
/** The graph: nodes, links, comets, tool pulses and file clashes on the pixel and dot layers, then labels in cells. Pure. */
import { LEAD, type AgentState, type SwarmState } from '../core/fold.ts'
import type { AgentStats, Clash } from '../core/stats.ts'
import { Dots, Pixels, compose, toDots } from './canvas.ts'
import { desaturate, mix, quantise, scale } from './color.ts'
import { clipText } from './format.ts'
import { arc, blink, comet, fadeIn, flash, ghost, glow, hashUnit } from './fx.ts'
import { type Grid, cp } from './grid.ts'
import { orderAgents, structuralEdges } from './layout.ts'
import { ACCENT, CANVAS, GLYPH, GRAPH, KIND, LINK, MOTION, STATUS, TEXT, contextColor, modelColor, statusGlyph } from './tokens.ts'
import type { Point, Rect, View } from './types.ts'

export type GraphInput = {
  state: SwarmState
  stats: Readonly<Record<string, AgentStats>>
  positions: Readonly<Record<string, Point>>
  clashes: readonly Clash[]
  view: View
  now: number
  /** The time effects are drawn at: now less the arrival lag, so a comet starts at its sender. */
  tEff: number
}

type Node = { id: string; p: Point; r: number; fill: number; s: AgentStats; a: AgentState }
type Rim = { color: number; k: number } | null

const WHITE = 0xffffff
const LABEL_MAX = 12

/** Node radius in pixels: grows with the log of total tokens, inside the graph's own limit. */
export function nodeRadius(tokens: number, maxRadius: number): number {
  const r = GRAPH.minRadius + 0.9 * Math.log10(1 + Math.max(0, tokens) / 1000)
  return Math.max(GRAPH.minRadius, Math.min(Math.max(GRAPH.minRadius, maxRadius), r))
}

/** Running: the model colour. Waiting: dimmer. Done: fades to a ghost. Failed: red. Everything fades in from the canvas. */
export function nodeColor(s: AgentStats, a: AgentState, now: number): number {
  const base = s.placeholder ? TEXT.faint : modelColor(s.model)
  let c = base
  if (s.status === 'failed') c = STATUS.failed
  else if (s.status === 'done') c = mix(base, mix(desaturate(base, 0.7), CANVAS, 0.55), quantise(ghost(a.finishedAt, now), 6))
  else if (s.status === 'waiting') c = scale(base, 0.72)
  return mix(CANVAS, c, quantise(fadeIn(a.startedAt, now), 8))
}

export function lastEditAt(state: SwarmState, path: string): number {
  const edits = Object.hasOwn(state.edits, path) ? state.edits[path]! : []
  return edits.reduce((latest, e) => Math.max(latest, e.at), Number.NEGATIVE_INFINITY)
}

/** A clash flashes for MOTION.clashFlashMs after its latest edit; its dashed line stays while it is live. */
export const clashActive = (state: SwarmState, clash: Clash, now: number): boolean =>
  flash(lastEditAt(state, clash.path), now, MOTION.clashFlashMs) > 0

const posOf = (positions: Readonly<Record<string, Point>>, id: string): Point | null => (Object.hasOwn(positions, id) ? positions[id]! : null)

/** The segment from a to b with `ra` and `rb` cut off the ends, so lines stop at node edges; null when they overlap. */
function trimmed(a: Point, b: Point, ra: number, rb: number): [Point, Point] | null {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  if (len <= ra + rb) return null
  const ux = dx / len
  const uy = dy / len
  return [{ x: a.x + ux * ra, y: a.y + uy * ra }, { x: b.x - ux * rb, y: b.y - uy * rb }]
}

/** The strongest live pulse per agent: its colour and how far it has faded. */
function pulseRims(view: View, tEff: number): Map<string, { color: number; k: number }> {
  const out = new Map<string, { color: number; k: number }>()
  for (const p of view.pulses) {
    const k = quantise(flash(p.at, tEff, p.isError ? MOTION.errorPulseMs : MOTION.pulseMs), 4)
    if (k <= 0 || (out.get(p.agent)?.k ?? 0) >= k) continue
    out.set(p.agent, { color: p.isError ? STATUS.failed : KIND[p.kind], k })
  }
  return out
}

function paintNode(px: Pixels, n: Node, glowK: number, ring: { fill: number; color: number } | null, rim: Rim): void {
  const reach = n.r + GRAPH.ringPx + GRAPH.glowPx + 1
  for (let y = Math.floor(n.p.y - reach); y <= Math.ceil(n.p.y + reach); y++) {
    for (let x = Math.floor(n.p.x - reach); x <= Math.ceil(n.p.x + reach); x++) {
      const dx = x + 0.5 - n.p.x
      const dy = y + 0.5 - n.p.y
      const d = Math.hypot(dx, dy)
      if (d <= n.r) {
        px.set(x, y, mix(n.fill, WHITE, quantise(1 - d / n.r, 4) * 0.28))
        if (rim !== null && d > n.r - 1) px.blend(x, y, rim.color, rim.k)
      } else if (ring !== null && d <= n.r + GRAPH.ringPx) {
        let angle = Math.atan2(dx, -dy)
        if (angle < 0) angle += 2 * Math.PI
        px.set(x, y, angle / (2 * Math.PI) <= ring.fill ? ring.color : mix(CANVAS, TEXT.faint, 0.6))
      } else if (glowK > 0 && d <= n.r + GRAPH.ringPx + GRAPH.glowPx) {
        const k = quantise((1 - (d - n.r) / (GRAPH.ringPx + GRAPH.glowPx)) ** 2, 5) * glowK
        px.light(x, y, n.fill, k * 0.55)
      }
    }
  }
}

/** Dots along `path` (t from 0 to 1), about two to each pixel of `length`. */
function dotPath(dots: Dots, path: (t: number) => Point, length: number, color: number): void {
  const steps = Math.max(2, Math.ceil(length * 2))
  for (let i = 0; i <= steps; i++) {
    const d = toDots(path(i / steps))
    dots.dot(d.x, d.y, color)
  }
}

function labels(grid: Grid, area: Rect, nodes: readonly Node[]): void {
  const used = new Uint8Array(area.w * area.h)
  for (const n of nodes) {
    const row = Math.min(area.h - 1, Math.floor((n.p.y + n.r + 0.5) / 2) + 1)
    const isLead = n.id === LEAD
    const glyph = isLead ? GLYPH.lead : statusGlyph(n.s.status, n.s.placeholder)
    const glyphColor = isLead ? ACCENT : STATUS[n.s.status]
    const nameColor = n.s.status === 'failed' ? STATUS.failed : n.s.status === 'running' ? TEXT.primary : TEXT.dim
    const stuck = n.s.stuck ? ` ${GLYPH.stuck}` : ''
    for (const text of [`${glyph} ${clipText(n.s.name, LABEL_MAX)}${stuck}`, glyph]) {
      const chars = [...text]
      const x0 = Math.max(0, Math.min(area.w - chars.length, Math.round(n.p.x - chars.length / 2)))
      if (chars.some((_, i) => used[row * area.w + x0 + i] === 1)) continue
      chars.forEach((ch, i) => {
        used[row * area.w + x0 + i] = 1
        const color = i === 0 ? glyphColor : stuck !== '' && i === chars.length - 1 ? STATUS.warn : nameColor
        grid.set(area.x + x0 + i, area.y + row, cp(ch), color)
      })
      break
    }
  }
}

export function drawGraph(grid: Grid, area: Rect, input: GraphInput): void {
  const { state, stats, positions, clashes, view, now, tEff } = input
  if (area.w < 1 || area.h < 1) return
  const px = new Pixels(area.w, area.h * 2, CANVAS)
  const dots = new Dots(area.w, area.h)
  const maxR = Math.min(GRAPH.maxRadius, Math.max(GRAPH.minRadius, (area.h * 2) / 7))
  const nodes = new Map<string, Node>()
  for (const a of orderAgents(state)) {
    const p = posOf(positions, a.id)
    const s = Object.hasOwn(stats, a.id) ? stats[a.id]! : null
    if (p === null || s === null) continue
    nodes.set(a.id, { id: a.id, p, r: s.placeholder ? GRAPH.minRadius : nodeRadius(s.tokens.total, maxR), fill: nodeColor(s, a, now), s, a })
  }
  const segment = (from: string, to: string, gap = 1): [Point, Point] | null => {
    const a = nodes.get(from)
    const b = nodes.get(to)
    return a === undefined || b === undefined ? null : trimmed(a.p, b.p, a.r + gap, b.r + gap)
  }
  const recency = (lastAt: number): number => quantise(flash(lastAt, tEff, MOTION.linkFadeMs), 5)

  // 1. Busy links as dim pixel arcs, under the nodes.
  for (const link of Object.values(state.links)) {
    if (link.count < GRAPH.linkThick[1]) continue
    const seg = segment(link.from, link.to, 0.5)
    if (seg === null) continue
    const path = arc(seg[0], seg[1], GRAPH.linkBend)
    const steps = Math.max(2, Math.ceil(Math.hypot(seg[1].x - seg[0].x, seg[1].y - seg[0].y)))
    const color = mix(LINK.idle, LINK.active, recency(link.lastAt))
    for (let i = 0; i <= steps; i++) {
      const p = path(i / steps)
      px.blend(p.x, p.y, color, 0.45)
    }
  }

  // 2. Nodes, with glow, context ring and rim.
  const rims = pulseRims(view, tEff)
  const flashing = new Set<string>()
  for (const c of clashes) if (clashActive(state, c, now) && blink(now, MOTION.clashBlinkMs)) for (const id of c.agents) flashing.add(id)
  for (const n of nodes.values()) {
    const seed = hashUnit(n.id)
    const rim: Rim = flashing.has(n.id) ? { color: LINK.clash, k: 0.9 }
      : rims.get(n.id) ?? (n.s.stuck ? { color: STATUS.warn, k: quantise(0.3 + 0.6 * glow(now, seed), 4) } : null)
    const fill = n.s.contextFill
    const glowK = n.s.status === 'running' ? quantise(0.45 + 0.55 * glow(now, seed), 5) : 0
    paintNode(px, n, glowK, fill !== null && n.r >= 2.2 ? { fill, color: contextColor(fill) } : null, rim)
  }

  // 3. The swarm's shape: faint dotted edges.
  for (const e of structuralEdges(state, state.swarm.topology)) {
    const seg = segment(e.from, e.to)
    if (seg !== null) dots.line(toDots(seg[0]), toDots(seg[1]), mix(CANVAS, TEXT.faint, 0.9), 2)
  }

  // 4. Message links as arcs: brighter for a while after each message, doubled once busy.
  for (const link of Object.values(state.links)) {
    const seg = segment(link.from, link.to)
    if (seg === null) continue
    const color = mix(LINK.idle, LINK.active, recency(link.lastAt))
    const length = Math.hypot(seg[1].x - seg[0].x, seg[1].y - seg[0].y)
    dotPath(dots, arc(seg[0], seg[1], GRAPH.linkBend), length, color)
    if (link.count >= GRAPH.linkThick[0]) dotPath(dots, arc(seg[0], seg[1], GRAPH.linkBend + 0.04), length, color)
  }

  // 5. File clashes: a dashed red line between the agents editing the same file.
  for (const c of clashes) {
    for (let i = 0; i + 1 < c.agents.length; i++) {
      const seg = segment(c.agents[i]!, c.agents[i + 1]!)
      if (seg !== null) dots.line(toDots(seg[0]), toDots(seg[1]), LINK.clash, 3)
    }
  }

  // 6. Comets along the arcs of recent messages, with a soft glow under the head.
  for (const item of state.feed) {
    if (item.kind !== 'message' || item.to === undefined) continue
    const seg = segment(item.agent, item.to)
    if (seg === null) continue
    for (const spark of comet(arc(seg[0], seg[1], GRAPH.linkBend), item.at, tEff)) {
      const d = toDots(spark.p)
      if (spark.k === 1) {
        dots.dot(d.x, d.y, LINK.comet)
        dots.dot(d.x + 1, d.y, LINK.comet)
        px.light(spark.p.x, spark.p.y, LINK.active, 0.35)
      } else {
        dots.dot(d.x, d.y, mix(CANVAS, LINK.active, quantise(spark.k, 4)))
      }
    }
  }

  compose(grid, area, px, dots)
  labels(grid, area, [...nodes.values()])
}
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `node --test tests/render/graph.test.ts`
Expected: PASS, 6 tests. If "a comet head" fails because a later trail dot recoloured the head's cell, draw all trails first and all heads last (two passes over `state.feed`); do not weaken the test.

- [ ] **Step 5: Run the gate, then commit**

Run: `npm run check` (expected: green), then:

```bash
git add src/render/graph.ts tests/render/graph.test.ts
git commit -m "Draw the swarm graph: glowing nodes with context rings, message links and comets, tool pulses and file clashes"
```

---

### Task 12: The frame, golden snapshots, the preview script and the render e2e  *(wave 4, serial)*

**Files:**
- Create: `src/render/frame.ts`, `tests/render/golden-cases.ts`, `scripts/preview.ts`
- Test: `tests/render/frame.test.ts`, `tests/render/golden.test.ts`, `tests/render/golden/*.txt` (generated), `tests/e2e/pane-render.test.ts`

**Interfaces:**
- Consumes: everything in `src/render/` (Tasks 4-11), `pulsesFrom`, `applyReply`, `emptyModel`, `feedArgs` (Task 10), `createFeedTools`, `parseFeedReply` (Task 3), `fileClashes`, `swarmTotals`, `agentStats` (`core/stats.ts`).
- Produces:
  - `frame.ts`: `render(state: SwarmState, view: View, nowMs: number, size: Size): Frame` (spec §4's `render(state, view, nowMs, size)`; it returns a `Frame` holding two grids and the chips rather than one grid, because the pin chips are Buttons that sit between the two Rasters), `targetFps(state, view, nowMs, stats, clashes): number` (`FPS.busy`, `FPS.glow` or 0), `frameInterval(fps, previousMs, renderMs): number` (back off when slow, recover when fast).
  - `tests/render/golden-cases.ts`: `type GoldenCase`, `GOLDEN_CASES`, `goldenFrame(c): Frame` (shared by the golden test and the preview script).
  - `scripts/preview.ts`: `node scripts/preview.ts [outDir]` writes `<case>.png` and `<case>-top.svg` / `-bottom.svg` for each golden case (default `.superpowers/preview/`, which is git-ignored).

- [ ] **Step 1: Write the failing frame tests**

`tests/render/frame.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldAll } from '../../src/core/fold.ts'
import { agentStats, fileClashes, type AgentStats } from '../../src/core/stats.ts'
import { frameInterval, render, targetFps } from '../../src/render/frame.ts'
import { pairCount, safeGlyph, type Grid } from '../../src/render/grid.ts'
import { FPS, PAIR_BUDGET } from '../../src/render/tokens.ts'
import { emptyView, type View } from '../../src/render/types.ts'
import { FIVE_AT, FIVE_SWARM, fiveAgentEvents, quietEvents } from '../fixtures/swarm-five.ts'
import { at, ev } from '../helpers.ts'

const five = () => foldAll(FIVE_SWARM, fiveAgentEvents())
const FULL = { columns: 120, rows: 44 }
const fps = (s: ReturnType<typeof five>, view: View, now: number) => {
  const clashes = fileClashes(s, now)
  const stats: Record<string, AgentStats> = {}
  for (const id of Object.keys(s.agents)) stats[id] = agentStats(s, id, now, clashes)!
  return targetFps(s, view, now, stats, clashes)
}

test('each size step gives the right grids and chips', () => {
  const s = five()
  const full = render(s, emptyView(), FIVE_AT.mid, FULL)
  assert.deepEqual([full.step, full.top.columns, full.top.rows, full.bottom?.rows, full.chips.length], ['full', 120, 26, 17, 6])
  assert.deepEqual(full.chips.map(c => c.label), ['lead', 'architect', 'coder-1', 'coder-2', 'tester', 'reviewer'])
  const tree = render(s, emptyView(), FIVE_AT.mid, { columns: 60, rows: 13 })
  assert.deepEqual([tree.step, tree.bottom, tree.chips.length], ['tree', null, 0])
  const line = render(s, emptyView(), FIVE_AT.mid, { columns: 40, rows: 5 })
  assert.deepEqual([line.step, line.top.rows], ['summary', 1])
  assert.match(full.alt, /^◆ auth refactor · 6 agents/)
})

test('the spotlight is the pin, else the view\'s choice, else the busiest', () => {
  const s = five()
  assert.equal(render(s, emptyView(), FIVE_AT.mid, FULL).spotlight, 'a-cod1')
  assert.equal(render(s, { ...emptyView(), spotlight: { id: 'a-arch', since: 0 } }, FIVE_AT.mid, FULL).spotlight, 'a-arch')
  const pinned = render(s, { ...emptyView(), pinned: 'a-test', spotlight: { id: 'a-arch', since: 0 } }, FIVE_AT.mid, FULL)
  assert.equal(pinned.spotlight, 'a-test')
  assert.equal(pinned.chips.find(c => c.id === 'a-test')?.pinned, true)
})

test('treeKey changes only when the element tree must change; nodesKey when the nodes do', () => {
  const s = five()
  const a = render(s, emptyView(), FIVE_AT.mid, FULL)
  const b = render(s, emptyView(), FIVE_AT.idle, FULL)
  assert.equal(a.treeKey, b.treeKey)
  assert.notEqual(a.treeKey, render(s, { ...emptyView(), pinned: 'a-test' }, FIVE_AT.mid, FULL).treeKey)
  assert.notEqual(a.treeKey, render(s, emptyView(), FIVE_AT.mid, { columns: 100, rows: 29 }).treeKey)
  const fewer = render(foldAll(FIVE_SWARM, fiveAgentEvents().slice(0, 12)), emptyView(), FIVE_AT.mid, FULL)
  assert.notEqual(a.treeKey, fewer.treeKey)
  assert.notEqual(a.nodesKey, fewer.nodesKey)
})

test('the frame rate: busy while things move, slow while only glows move, stopped when still', () => {
  const s = five()
  assert.equal(fps(s, emptyView(), FIVE_AT.mid), FPS.busy)
  assert.equal(fps(s, emptyView(), FIVE_AT.idle), FPS.glow)
  const quiet = foldAll(FIVE_SWARM, quietEvents())
  assert.equal(fps(quiet, emptyView(), FIVE_AT.idle), 0)
  assert.equal(fps(quiet, { ...emptyView(), tween: { from: {}, at: FIVE_AT.idle - 100 } }, FIVE_AT.idle), FPS.busy)
  assert.equal(fps(quiet, { ...emptyView(), pulses: [{ agent: 'a-arch', kind: 'read', at: FIVE_AT.idle - 100, isError: false }] }, FIVE_AT.idle), FPS.busy)
})

test('the frame interval backs off when frames are slow and recovers when they are fast', () => {
  assert.equal(frameInterval(30, 0, 0), 33)
  assert.equal(frameInterval(30, 33, 25), 66)
  assert.equal(frameInterval(30, 66, 50), 132)
  assert.equal(frameInterval(30, 132, 100), 250)
  assert.equal(frameInterval(30, 250, 10), 125)
  assert.equal(frameInterval(30, 125, 10), 63)
  assert.equal(frameInterval(12, 33, 5), 83)
  assert.equal(frameInterval(12, 100, 40), 100)
  assert.equal(frameInterval(0, 33, 5), 0)
})

test('every frame stays inside its colour-pair budget and the Raster limits', () => {
  const s = five()
  for (const size of [FULL, { columns: 100, rows: 29 }, { columns: 80, rows: 21 }, { columns: 60, rows: 13 }, { columns: 600, rows: 600 }]) {
    for (const now of [FIVE_AT.mid, FIVE_AT.idle]) {
      const f = render(s, emptyView(), now, size)
      assert.ok(pairCount(f.top) <= PAIR_BUDGET.top)
      if (f.bottom !== null) assert.ok(pairCount(f.bottom) <= PAIR_BUDGET.bottom)
      for (const g of [f.top, f.bottom]) if (g !== null) assert.ok(g.columns <= 512 && g.rows <= 256)
    }
  }
})

test('render is deterministic', () => {
  const s = five()
  const a = render(s, emptyView(), FIVE_AT.mid, FULL)
  const b = render(s, emptyView(), FIVE_AT.mid, FULL)
  assert.equal(a.top.encode(), b.top.encode())
  assert.equal(a.bottom!.encode(), b.bottom!.encode())
})

test('hostile names and summaries never put a cell the Raster would refuse', () => {
  const s = foldAll('s1', [
    ev('agent.started', { name: '😀中文x', role: 'r‮', description: '', parent: 'lead' }, { agent: 'e1', atSec: 0 }),
    ev('message.sent', { to: 'main', summary: 'ź́ ﾟ全角   end' }, { agent: 'e1', atSec: 1 }),
  ])
  const f = render(s, emptyView(), at(2), FULL)
  const ok = (g: Grid) => {
    for (let y = 0; y < g.rows; y++) for (let x = 0; x < g.columns; x++) assert.equal(safeGlyph(g.glyph(x, y)), g.glyph(x, y))
  }
  ok(f.top)
  ok(f.bottom!)
})

test('an empty swarm renders', () => {
  const f = render(foldAll('s1', []), emptyView(), at(0), FULL)
  assert.deepEqual([f.spotlight, f.chips.length, f.fps], [null, 0, 0])
})
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test tests/render/frame.test.ts`
Expected: FAIL, `Cannot find module` for `src/render/frame.ts`.

- [ ] **Step 3: Write `src/render/frame.ts`**

```ts
/** One frame of the pane: render(state, view, now, size) gives the two grids, the chips and how fast to animate. Pure. */
import type { SwarmState } from '../core/fold.ts'
import { agentStats, fileClashes, swarmTotals, type AgentStats, type Clash } from '../core/stats.ts'
import { drawFeed } from './feed.ts'
import { clipText } from './format.ts'
import { tween } from './fx.ts'
import { clashActive, drawGraph } from './graph.ts'
import { Grid, limitPairs, writeParts } from './grid.ts'
import { drawHeader, drawSummary, summaryText } from './header.ts'
import { layoutNodes, nodesKey, orderAgents } from './layout.ts'
import { planRegions } from './regions.ts'
import { busiest, drawSpotlight } from './spotlight.ts'
import { drawTimeline } from './timeline.ts'
import { CANVAS, CANVAS_RAISED, FPS, MOTION, PAIR_BUDGET, TEXT, modelColor } from './tokens.ts'
import { drawTree } from './tree.ts'
import type { Chip, Frame, Point, Size, View } from './types.ts'

const MAX_LAG_MS = 1_000
const CHIP_LABEL = 14
const lagOf = (view: View): number => Math.max(0, Math.min(MAX_LAG_MS, Number.isFinite(view.lagMs) ? view.lagMs : 0))

/** FPS.busy while comets, fades, pulses, a glide or a clash flash are live; FPS.glow while only glows move; else 0. */
export function targetFps(state: SwarmState, view: View, nowMs: number, stats: Readonly<Record<string, AgentStats>>, clashes: readonly Clash[]): number {
  const t = nowMs - lagOf(view)
  for (const item of state.feed) if (item.kind === 'message' && t >= item.at && t - item.at <= MOTION.cometMs + MOTION.trailMs) return FPS.busy
  for (const a of Object.values(state.agents)) {
    if (nowMs >= a.startedAt && nowMs - a.startedAt < MOTION.fadeInMs) return FPS.busy
    if (a.finishedAt !== null && nowMs >= a.finishedAt && nowMs - a.finishedAt < MOTION.ghostMs) return FPS.busy
  }
  for (const p of view.pulses) if (t >= p.at && t - p.at <= (p.isError ? MOTION.errorPulseMs : MOTION.pulseMs)) return FPS.busy
  if (view.tween !== null && nowMs - view.tween.at < MOTION.tweenMs) return FPS.busy
  if (clashes.some(c => clashActive(state, c, nowMs))) return FPS.busy
  for (const s of Object.values(stats)) if (!s.placeholder && (s.status === 'running' || s.stuck)) return FPS.glow
  return 0
}

/**
 * The next frame interval in ms. A frame that took more than 60% of the interval doubles it (down to FPS.min); one
 * that took under a quarter halves it again, never faster than `fps` asks. 0 means stop.
 */
export function frameInterval(fps: number, previousMs: number, renderMs: number): number {
  if (fps <= 0) return 0
  const base = Math.round(1000 / fps)
  const slowest = Math.round(1000 / FPS.min)
  if (previousMs <= 0) return base
  if (renderMs > previousMs * 0.6) return Math.min(slowest, Math.max(base, previousMs * 2))
  if (renderMs < previousMs * 0.25) return Math.max(base, Math.round(previousMs / 2))
  return Math.max(base, previousMs)
}

export function render(state: SwarmState, view: View, nowMs: number, size: Size): Frame {
  const clashes = fileClashes(state, nowMs)
  const totals = swarmTotals(state, nowMs, clashes)
  const stats: Record<string, AgentStats> = {}
  for (const id of Object.keys(state.agents)) {
    const s = agentStats(state, id, nowMs, clashes)
    if (s !== null) stats[id] = s
  }
  const real = orderAgents(state).filter(a => !a.placeholder)
  const regions = planRegions(size, real.length)
  const top = new Grid(regions.top.columns, regions.top.rows, CANVAS, TEXT.primary)
  let positions: Record<string, Point> = {}
  if (regions.step === 'summary') drawSummary(top, regions.header, state, totals)
  else {
    drawHeader(top, regions.header, state, totals)
    if (regions.tree !== null) drawTree(top, regions.tree, state, stats)
    if (regions.graph !== null) {
      positions = tween(layoutNodes(state, state.swarm.topology, regions.graph.w, regions.graph.h * 2), view.tween, nowMs)
      drawGraph(top, regions.graph, { state, stats, positions, clashes, view, now: nowMs, tEff: nowMs - lagOf(view) })
    }
  }

  const isReal = (id: string | null): id is string => id !== null && real.some(a => a.id === id)
  const pinned = isReal(view.pinned) ? view.pinned : null
  const chosen = view.spotlight?.id ?? null
  const spotlight = pinned ?? (isReal(chosen) ? chosen : busiest(state, view.pulses, nowMs))

  let bottom: Grid | null = null
  if (regions.bottom !== null) {
    bottom = new Grid(regions.bottom.columns, regions.bottom.rows, CANVAS, TEXT.primary)
    const spot = regions.spotlight
    if (spot !== null) {
      const s = spotlight === null ? null : (stats[spotlight] ?? null)
      if (s !== null && spotlight !== null) drawSpotlight(bottom, spot, s, state.agents[spotlight]!, nowMs, regions.step === 'compactSpotlight')
      else {
        bottom.fill(spot.x, spot.y, spot.w, spot.h, CANVAS_RAISED)
        writeParts(bottom, spot.x + 1, spot.y, [['No agents yet.', TEXT.dim]], spot.x + spot.w - 1, CANVAS_RAISED)
      }
    }
    if (regions.timeline !== null) drawTimeline(bottom, regions.timeline, state, nowMs)
    if (regions.feed !== null) drawFeed(bottom, regions.feed, state, nowMs)
  }

  const chips: Chip[] = regions.chips
    ? real.map(a => ({ id: a.id, label: clipText(a.name, CHIP_LABEL), color: modelColor(a.model), pinned: a.id === pinned }))
    : []
  limitPairs(top, PAIR_BUDGET.top)
  if (bottom !== null) limitPairs(bottom, PAIR_BUDGET.bottom)
  const treeKey = [
    regions.step, `${top.columns}x${top.rows}`, bottom === null ? '-' : `${bottom.columns}x${bottom.rows}`,
    ...chips.map(c => `${c.id}:${c.label}:${c.color}:${c.pinned ? 1 : 0}`),
  ].join('|')
  return {
    step: regions.step, top, bottom, chips, treeKey, nodesKey: nodesKey(state), positions,
    fps: targetFps(state, view, nowMs, stats, clashes), spotlight, alt: summaryText(state, totals),
  }
}
```

- [ ] **Step 4: Run the frame tests to make sure they pass**

Run: `node --test tests/render/frame.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Write the golden cases and the golden test**

`tests/render/golden-cases.ts`:

```ts
/** The golden snapshot cases: the five-agent fixture at fixed times, sizes and topologies. Shared with scripts/preview.ts. */
import type { Topology } from '../../src/core/events.ts'
import { foldAll } from '../../src/core/fold.ts'
import { pulsesFrom } from '../../src/mod/pane-model.ts'
import { render } from '../../src/render/frame.ts'
import type { Frame, Size } from '../../src/render/types.ts'
import { FIVE_AT, FIVE_SWARM, fiveAgentEvents } from '../fixtures/swarm-five.ts'

export type GoldenCase = { name: string; size: Size; at: number; topology: Topology }

const FULL = { columns: 120, rows: 44 }

export const GOLDEN_CASES: readonly GoldenCase[] = [
  { name: 'full-mid', size: FULL, at: FIVE_AT.mid, topology: 'hierarchical' },
  { name: 'full-idle', size: FULL, at: FIVE_AT.idle, topology: 'hierarchical' },
  { name: 'mesh-mid', size: FULL, at: FIVE_AT.mid, topology: 'mesh' },
  { name: 'star-mid', size: FULL, at: FIVE_AT.mid, topology: 'star' },
  { name: 'no-timeline-mid', size: { columns: 100, rows: 29 }, at: FIVE_AT.mid, topology: 'hierarchical' },
  { name: 'compact-mid', size: { columns: 80, rows: 21 }, at: FIVE_AT.mid, topology: 'hierarchical' },
  { name: 'tree-mid', size: { columns: 60, rows: 13 }, at: FIVE_AT.mid, topology: 'hierarchical' },
  { name: 'summary-mid', size: { columns: 40, rows: 5 }, at: FIVE_AT.mid, topology: 'hierarchical' },
]

export function goldenFrame(c: GoldenCase): Frame {
  const events = fiveAgentEvents(c.topology)
  return render(foldAll(FIVE_SWARM, events), { pinned: null, spotlight: null, pulses: pulsesFrom(events), lagMs: 0, tween: null }, c.at, c.size)
}
```

`tests/render/golden.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hex } from '../../src/render/color.ts'
import { type Grid, gridText } from '../../src/render/grid.ts'
import type { Frame } from '../../src/render/types.ts'
import { FIVE_T0 } from '../fixtures/swarm-five.ts'
import { GOLDEN_CASES, goldenFrame, type GoldenCase } from './golden-cases.ts'

// Golden snapshots: each frame's glyphs, a map of its colour pairs with a legend (for review against
// docs/design/pane.md), and a hash of the exact cells. Regenerate with UPDATE_GOLDEN=1 after an intended change,
// then have the designer review the diff.
const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), 'golden')
const LETTERS = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!$%&*+-/:;<=>?@^_~']

function colours(grid: Grid): { map: string[]; legend: string[] } {
  const letter = new Map<string, string>()
  const count = new Map<string, number>()
  const map: string[] = []
  for (let y = 0; y < grid.rows; y++) {
    let line = ''
    for (let x = 0; x < grid.columns; x++) {
      const key = `fg ${hex(grid.fg(x, y))} bg ${hex(grid.bg(x, y))}`
      if (!letter.has(key)) letter.set(key, LETTERS[letter.size] ?? '.')
      count.set(key, (count.get(key) ?? 0) + 1)
      line += letter.get(key)
    }
    map.push(line)
  }
  const legend = [...letter].filter(([, l]) => l !== '.').map(([key, l]) => `${l} ${key} x${count.get(key)}`)
  if (letter.size > LETTERS.length) legend.push(`. ${letter.size - LETTERS.length} more pairs`)
  return { map, legend }
}

function snapshot(c: GoldenCase, f: Frame): string {
  const part = (label: string, g: Grid): string[] => {
    const { map, legend } = colours(g)
    const sha = createHash('sha256').update(g.encode()).digest('hex').slice(0, 16)
    return [`## ${label} ${g.columns}x${g.rows} sha ${sha}`, '### glyphs', ...gridText(g), '### colours', ...map, '### legend', ...legend]
  }
  return [
    `# ${c.name}: ${c.topology} at +${c.at - FIVE_T0} ms in ${c.size.columns}x${c.size.rows}; step ${f.step}, fps ${f.fps}, spotlight ${f.spotlight}`,
    ...part('top', f.top),
    ...(f.bottom === null ? ['## bottom none'] : part('bottom', f.bottom)),
    '## chips',
    ...f.chips.map(ch => `${ch.pinned ? '◉' : '●'} ${hex(ch.color)} ${ch.label} (${ch.id})`),
    '',
  ].join('\n')
}

for (const c of GOLDEN_CASES) {
  test(`golden: ${c.name}`, () => {
    const actual = snapshot(c, goldenFrame(c))
    const file = join(GOLDEN, `${c.name}.txt`)
    if (process.env.UPDATE_GOLDEN === '1') {
      mkdirSync(GOLDEN, { recursive: true })
      writeFileSync(file, actual)
      return
    }
    assert.ok(existsSync(file), `no golden for ${c.name}: run with UPDATE_GOLDEN=1, then have the designer review it`)
    assert.equal(actual, readFileSync(file, 'utf8').replace(/\r\n/g, '\n'))
  })
}
```

- [ ] **Step 6: Run the golden test to see it fail, then write the goldens**

Run: `node --test tests/render/golden.test.ts`
Expected: FAIL, 8 tests, each "no golden for <case>".

Generate them (Git Bash): `UPDATE_GOLDEN=1 node --test tests/render/golden.test.ts`
(PowerShell: `$env:UPDATE_GOLDEN='1'; node --test tests/render/golden.test.ts; Remove-Item Env:UPDATE_GOLDEN`)

Then run `node --test tests/render/golden.test.ts` again. Expected: PASS, 8 tests. Open `tests/render/golden/full-mid.txt` and check by eye that the glyph section shows the header, all seven labels, braille comets and the spotlight card; if it looks broken, fix the code, not the golden.

- [ ] **Step 7: Write the preview script**

`scripts/preview.ts`:

```ts
/**
 * Renders the golden cases to PNG and SVG so the designer can see colours, not just glyphs:
 *   node scripts/preview.ts [outDir]        (default .superpowers/preview, git-ignored)
 * Blocks and braille are drawn exactly; any other glyph is drawn as a soft bar (read the words in the golden file).
 * A blank row between the two grids stands for the chip row. Development only; not shipped in the plugin's mod.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { DEFAULT } from '../src/render/color.ts'
import type { Grid } from '../src/render/grid.ts'
import { CELL_H, CELL_W, blockShape, gridToSvg } from '../src/render/svg.ts'
import { GOLDEN_CASES, goldenFrame } from '../tests/render/golden-cases.ts'

const DOTS: ReadonlyArray<readonly [number, number]> = [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2], [0, 3], [1, 3]]

function png(width: number, height: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(raw, y * (width * 3 + 1) + 1)
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

function paint(grids: readonly Grid[]): { width: number; height: number; rgb: Uint8Array } {
  const width = Math.max(...grids.map(g => g.columns)) * CELL_W
  const height = (grids.reduce((n, g) => n + g.rows, 0) + grids.length - 1) * CELL_H
  const rgb = new Uint8Array(width * height * 3)
  const fill = (x: number, y: number, w: number, h: number, c: number, a = 1) => {
    for (let yy = Math.round(y); yy < Math.round(y + h); yy++) {
      for (let xx = Math.round(x); xx < Math.round(x + w); xx++) {
        if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue
        const i = (yy * width + xx) * 3
        rgb[i] = Math.round(rgb[i]! * (1 - a) + ((c >>> 16) & 255) * a)
        rgb[i + 1] = Math.round(rgb[i + 1]! * (1 - a) + ((c >>> 8) & 255) * a)
        rgb[i + 2] = Math.round(rgb[i + 2]! * (1 - a) + (c & 255) * a)
      }
    }
  }
  let oy = 0
  for (const g of grids) {
    for (let cy = 0; cy < g.rows; cy++) {
      for (let cx = 0; cx < g.columns; cx++) {
        const x = cx * CELL_W
        const y = oy + cy * CELL_H
        const bg = g.bg(cx, cy)
        const fg = g.fg(cx, cy) === DEFAULT ? 0xc9d1d9 : g.fg(cx, cy)
        const code = g.glyph(cx, cy)
        if (bg !== DEFAULT) fill(x, y, CELL_W, CELL_H, bg)
        const shape = blockShape(code)
        if (shape !== null) fill(x + shape[0] * CELL_W, y + shape[1] * CELL_H, shape[2] * CELL_W, shape[3] * CELL_H, fg, shape[4])
        else if (code > 0x2800 && code <= 0x28ff) {
          DOTS.forEach(([col, row], bit) => {
            if (((code - 0x2800) >> bit) & 1) fill(x + col * 4 + 1, y + row * 4 + 1, 2, 2, fg)
          })
        } else if (code !== 0x20) fill(x + 1, y + 4, CELL_W - 2, CELL_H - 8, fg, 0.6)
      }
    }
    oy += (g.rows + 1) * CELL_H
  }
  return { width, height, rgb }
}

const out = resolve(process.argv[2] ?? '.superpowers/preview')
mkdirSync(out, { recursive: true })
for (const c of GOLDEN_CASES) {
  const f = goldenFrame(c)
  const grids = f.bottom === null ? [f.top] : [f.top, f.bottom]
  const picture = paint(grids)
  writeFileSync(join(out, `${c.name}.png`), png(picture.width, picture.height, picture.rgb))
  grids.forEach((g, i) => {
    const svg = gridToSvg(g, f.alt, Number.MAX_SAFE_INTEGER)
    if (svg !== null) writeFileSync(join(out, `${c.name}-${i === 0 ? 'top' : 'bottom'}.svg`), svg)
  })
  console.log(`${c.name}: ${picture.width}x${picture.height} -> ${join(out, `${c.name}.png`)}`)
}
```

Run: `node scripts/preview.ts`
Expected: 8 lines like `full-mid: 960x704 -> ...\.superpowers\preview\full-mid.png`, and the PNGs open as images (use the Read tool on one to check it decodes).

- [ ] **Step 8: Write the render e2e**

`tests/e2e/pane-render.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseFeedReply } from '../../src/core/feed-reply.ts'
import { appendEvent, writeCurrent } from '../../src/core/log.ts'
import { swarmTotals } from '../../src/core/stats.ts'
import { Session } from '../../src/mcp/session.ts'
import { createFeedTools } from '../../src/mcp/tools/feed.ts'
import { applyReply, emptyModel, feedArgs, type PaneModel } from '../../src/mod/pane-model.ts'
import { fmtTokens } from '../../src/render/format.ts'
import { render } from '../../src/render/frame.ts'
import { gridText } from '../../src/render/grid.ts'
import { emptyView } from '../../src/render/types.ts'
import { FIVE_AT, FIVE_SWARM, fiveAgentEvents } from '../fixtures/swarm-five.ts'
import { tmpRoot } from '../helpers.ts'

test('a scripted five-agent swarm goes from the log through omnis_feed and the pane model to a drawn frame', () => {
  const root = tmpRoot()
  const events = fiveAgentEvents()
  for (const e of events.slice(0, 30)) assert.ok(appendEvent(root, e))
  writeCurrent(root, FIVE_SWARM)
  const feed = createFeedTools({ root, session: new Session(root) })[0]!
  const pull = (m: PaneModel) => {
    const reply = parseFeedReply(feed.handler(feedArgs(m)).text)
    assert.ok(reply !== null)
    return applyReply(m, reply, FIVE_AT.mid)
  }

  const first = pull(emptyModel())
  assert.equal(first.model.state?.swarm.name, 'auth refactor')
  for (const e of events.slice(30)) assert.ok(appendEvent(root, e))
  const second = pull(first.model)
  assert.equal(second.changed, true)

  const state = second.model.state!
  assert.equal(Object.keys(state.links).length, 8)
  const frame = render(state, { ...emptyView(), pulses: second.model.pulses }, FIVE_AT.mid, { columns: 120, rows: 44 })
  const text = [...gridText(frame.top), ...gridText(frame.bottom!)].join('\n')
  for (const name of ['lead', 'architect', 'coder-1', 'coder-2', 'tester', 'reviewer', 'ghost']) assert.ok(text.includes(name), name)
  const totals = swarmTotals(state, FIVE_AT.mid)
  assert.equal(totals.agents, 6)
  assert.ok(text.includes('6 agents'))
  assert.ok(text.includes(`${fmtTokens(totals.tokens)} tok`))
  assert.deepEqual(frame.chips.map(c => c.label), ['lead', 'architect', 'coder-1', 'coder-2', 'tester', 'reviewer'])
})
```

Run: `node --test tests/e2e/pane-render.test.ts`
Expected: PASS, 1 test.

- [ ] **Step 9: Run the gate, then commit**

Run: `npm run check` (expected: green), then:

```bash
git add src/render/frame.ts tests/render/frame.test.ts tests/render/golden-cases.ts tests/render/golden.test.ts tests/render/golden scripts/preview.ts tests/e2e/pane-render.test.ts
git commit -m "Compose the pane frame, pin it with golden snapshots, add a PNG/SVG preview for design review and a headless render e2e"
```

---
### Task 13: Design review of the goldens  *(wave 5, serial; omnis-designer)*

**Files:**
- Modify (only if a value changes): `docs/design/pane.md`

**Interfaces:**
- Consumes: `docs/design/pane.md`; `tests/render/golden/*.txt` (glyphs, colour-pair map and legend per frame); the PNG and SVG previews.
- Produces: a review in the reply to the lead (the designer role has no report file here): a numbered list of exact changes, each one of: a token value (`MOTION.cometMs: 900 → 700`), a glyph (`GLYPH.waiting: ◌ → ○`), or a render change naming the file, the function and the cell or colour (`graph.ts labels(): label row is one row too low for depth-0 nodes at 120x44; use floor((y + r) / 2) + 1`). Or "no changes".

- [ ] **Step 1: Make the previews**

Run: `node scripts/preview.ts`
Expected: 8 PNGs and their SVGs in `.superpowers/preview/`.

- [ ] **Step 2: Review each case against `docs/design/pane.md`**

For each of the 8 cases, read the PNG (Read tool) and the golden file. Check, and note every miss with its exact fix:

1. The accessibility checklist (pane.md section 11): every status readable by glyph or motion alone; red/amber/green never the only cue.
2. The palette: every legend colour is a token or a quantised blend of tokens toward `CANVAS` (no stray colours).
3. Status encoding per section 4: running nodes glow, waiting nodes dim, `coder-2` is a ghost, `reviewer` is red with `✕`, `tester` shows `!` (stuck), `?ghost` is a small faint node.
4. Motion frozen at +30 s (`full-mid`): comets on `architect → coder-1`, `lead → tester` and `architect → ?ghost` with visible trails; a rim flicker on `tester` (its read at +29.8 s); the dashed clash line between `coder-1` and `coder-2`. At +400 s (`full-idle`) nothing in flight.
5. Layouts per topology (section 7): tree, ring with the lead at 12 o'clock, star with the lead in the centre.
6. Size steps (section 8): each step shows exactly what the doc says; nothing clipped mid-word that matters (names, costs).
7. Legibility: labels never overlap nodes or each other; the header and card read at a glance.

- [ ] **Step 3: Update `docs/design/pane.md` for any token value that changes, then reply**

If a token value changes, edit its row in the Tokens table (with its new contrast ratio when it is a colour), then commit:

```bash
git add docs/design/pane.md
git commit -m "Adjust the pane's design tokens after reviewing the first rendered frames"
```

Reply to the lead with the numbered change list (or "no changes").

---

### Task 14: Apply the design review  *(wave 5, serial, after 13; skip if Task 13 said "no changes")*

**Files:**
- Modify: `src/render/tokens.ts` and only the render files the review names
- Modify (regenerated): `tests/render/golden/*.txt`

**Interfaces:**
- Consumes: Task 13's numbered change list and the updated `docs/design/pane.md`; Task 2's recommended `FPS.busy` and `PAIR_BUDGET` if they arrived after Task 4.
- Produces: the same exports as before (no renamed token, no changed signature).

- [ ] **Step 1: Make each change exactly as listed**

Copy changed token values from `docs/design/pane.md` into `src/render/tokens.ts`. Make each named render change in the file and function the review names. Change nothing else.

- [ ] **Step 2: Run the unit tests (goldens excluded) and fix only what the changes broke**

Run: `node --test tests/render/color.test.ts tests/render/grid.test.ts tests/render/format.test.ts tests/render/tokens.test.ts tests/render/canvas.test.ts tests/render/fx.test.ts tests/render/regions.test.ts tests/render/layout.test.ts tests/render/spotlight.test.ts tests/render/panels.test.ts tests/render/svg.test.ts tests/render/graph.test.ts tests/render/frame.test.ts`
Expected: PASS. A unit test that pinned an old value (for example a size-step threshold in `regions.test.ts`) is updated to the new value from `pane.md`, never loosened.

- [ ] **Step 3: Regenerate the goldens and previews**

Git Bash: `UPDATE_GOLDEN=1 node --test tests/render/golden.test.ts && node scripts/preview.ts`
PowerShell: `$env:UPDATE_GOLDEN='1'; node --test tests/render/golden.test.ts; Remove-Item Env:UPDATE_GOLDEN; node scripts/preview.ts`

- [ ] **Step 4: The designer checks the new previews**

Send the designer the list of changes made. The designer reads the regenerated PNGs and replies "approved" or a further numbered list (then repeat Steps 1-4).

- [ ] **Step 5: Run the gate, then commit**

Run: `npm run check` (expected: green), then:

```bash
git add src/render tests/render/golden
git commit -m "Apply the design review: token values and render tweaks, goldens regenerated"
```

---

### Task 15: Integrator wiring  *(wave 6, serial; omnis-integrator; needs phase 2's scaffold on master)*

**Files:**
- Create: `src/mod/pane.ts` (a stub Task 16 replaces)
- Modify: `src/mcp/registry.ts` (one import, one array entry), `src/mod/register.ts` (two lines and the `options` rename), `.claude-plugin/plugin.json` (the `panel` user option), `tests/e2e/mcp-server.test.ts` (the tool list)

**Interfaces:**
- Consumes: `createFeedTools` (Task 3); phase 2's `src/mod/register.ts`, `INTERNAL_TOOL`, `types/index.d.ts`, `tsconfig.mod.json`, `test:mod`. The scaffold is already on master, so this task could run as soon as Task 3 has merged; it sits in wave 6 so the shared files are touched once, late.
- Produces: `export function registerPane(on: On, options: PluginOptions): void` in `src/mod/pane.ts` (stub), called from `register.ts`; `omnis_feed` served by the MCP server; `options.panel` available to the mod.

- [ ] **Step 1: Check phase 2's scaffold is on master and merged into the phase 3 branch**

Run:

```bash
git merge master
ls src/mod/register.ts hooks/hooks.json tsconfig.mod.json types/index.d.ts
grep -n "test:mod" package.json
grep -n "panePinned" types/index.d.ts
grep -n "omnis_(record|feed)" src/core/recording.ts
```

Expected: every file listed; `test:mod` in `package.json`; `panePinned: string | null` in the contract; `omnis_(record|feed)` in `INTERNAL_TOOL` (`src/core/recording.ts`), which the guard and the recorder's skip use. All of these were on master when this plan was written; if any is missing, stop and ask the lead rather than patching phase 2's files.

- [ ] **Step 2: Register the feed tool**

In `src/mcp/registry.ts`, add after the existing imports:

```ts
import { createFeedTools } from './tools/feed.ts'
```

and add `createFeedTools` as the last entry of the `toolFactories` array (after `createTools` and phase 2's factory).

- [ ] **Step 3: Add the pane stub and wire it into the hooks module**

Create `src/mod/pane.ts`:

```ts
/** The swarm pane mod. Task 16 replaces this stub; until then registering it does nothing. */
import type { On, PluginOptions } from 'claude-code'

export function registerPane(on: On, options: PluginOptions): void {
  void on
  void options
}
```

In `src/mod/register.ts`, add `import { registerPane } from './pane.ts'` with the other imports, rename the `_options` parameter to `options`, and add `registerPane(on, options)` as the last line inside `register`:

```ts
export const register: Register = (on, options) => {
  registerGuard(on)
  registerRecorder(on)
  registerPane(on, options)
}
```

- [ ] **Step 4: Add the `panel` user option to `.claude-plugin/plugin.json`**

Add this top-level key (merge into an existing `userConfig` object if phase 2 made one):

```json
"userConfig": {
  "panel": {
    "type": "string",
    "title": "Swarm pane",
    "description": "command (the default): the pane opens only with /omnis pane or /omnis-swarm:watch. auto: it also opens when a swarm starts. off: it never opens.",
    "default": "command",
    "options": ["command", "auto", "off"]
  }
}
```

- [ ] **Step 5: Update the server e2e's tool list**

In `tests/e2e/mcp-server.test.ts`, the `tools/list` assertion gains `'omnis_feed'` (and `'omnis_record'` if phase 2 has not already added it), keeping the list sorted:

```ts
    assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name).sort(), [
      'omnis_feed', 'omnis_memory_get', 'omnis_memory_list', 'omnis_memory_put', 'omnis_record', 'omnis_swarm_end',
      'omnis_swarm_init', 'omnis_swarm_status', 'omnis_task_create', 'omnis_task_update',
    ])
```

- [ ] **Step 6: Run the full gate**

Run: `npm run check`
Expected: both typecheck configs clean, every `node --test` test passes, `claude plugin validate .` reports no errors (it lists the stub's module), and the mod tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/registry.ts src/mod/pane.ts src/mod/register.ts .claude-plugin/plugin.json tests/e2e/mcp-server.test.ts
git commit -m "Wire the pane in: serve omnis_feed, register the pane module and add the panel option"
```

---

### Task 16: The pane mod  *(wave 7, serial; omnis-developer)*

**Files:**
- Modify: `src/mod/pane.ts` (replace the stub)
- Create: `src/mod/pane.test.ts`, `commands/watch.md`

**Interfaces:**
- Consumes: `render`, `frameInterval` (Task 12); `chooseSpotlight` (Task 7); `gridToSvg`, `CELL_W` (Task 9); `hex` (Task 4); `GLYPH`, `PULL_MS` (Task 4); `Frame`, `Size`, `Spot`, `Tween`, `View`, `Chip` (Task 4); `applyReply`, `emptyModel`, `feedArgs`, `prunePulses`, `PaneModel` (Task 10); `parseFeedReply` (Task 3); `connectServer` (phase 2's `src/mod/server.ts`); from `claude-code`: `atom`, `read`, `update`, types `EngineInterface`, `On`, `PluginOptions`, `RenderElement`, `Timer`, `Elements`. Test kit: `test`, `expect`, `mock` from `claude-code/testing`. Fixture `tests/fixtures/swarm-five.ts`.
- Produces: `registerPane(on, options)` with hooks on `session.start`, `command.run` (`omnis`, `omnis-swarm:watch`), `ui.render` (`Pane`, `omnis-swarm`), `ui.close`, `tool.call` (`omnis_swarm_init`, for auto) and `agent.spawn` (for auto); `PANE_ID = 'omnis-swarm'`.

Behaviour (spec §10, §11):
- `/omnis pane` opens the pane (`/omnis pane close` closes it); `/omnis-swarm:watch` (a markdown command in `commands/watch.md`) is answered by the mod the same way, so its prompt only reaches the model when mods are off. `panel: off` refuses; `panel: auto` also opens it when `omnis_swarm_init` runs or an agent spawns, unless the person closed it this session.
- While the pane is open a `$.clock.every(PULL_MS)` timer pulls `omnis_feed`, one call in flight, and only calls the server while `$.ui.panes()` says the pane is placed and shown. Closing stops every timer.
- After each pull with news: if the element tree is unchanged (`treeKey`), blit both Rasters; otherwise `$.ui.invalidate('ui.render')`. A node-set change starts a glide (`tween`).
- The frame loop runs only while `frame.fps > 0`, at `frameInterval(...)`, which backs off when frames are slow; it stops when nothing moves, on close, and off the terminal.
- Chips are `Button`s keyed `pin:<agentId>` whose `onPress` toggles `panePinned` in `$.state` (the only write the pane makes; it changes what is shown and nothing else).
- On a surface without `Raster`, each grid becomes an `Svg` (static, redrawn on each render), or the summary as text when the SVG would be too big.
- Values the drawing reads (the pin) live in `$.state`; the swarm model is module state, re-pulled within one `PULL_MS` after a hot reload. Timers and blits go through the `$` captured at `session.start`, as RuFlo's pane does; the pane is opened with the `$` of the command that asked for it.

- [ ] **Step 1: Write the failing mod tests**

`src/mod/pane.test.ts` (it sits beside the mod code so `node --test` never collects it; `npm run test:mod` runs it through `claude plugin test`):

```ts
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { foldAll } from '../core/fold.ts'
import { decodeCells, gridText } from '../render/grid.ts'
import { FIVE_AT, FIVE_SWARM, fiveAgentEvents } from '../../tests/fixtures/swarm-five.ts'

const SERVER = 'plugin:omnis-swarm:omnis-swarm'
const INIT = 'mcp__plugin_omnis-swarm_omnis-swarm__omnis_swarm_init'
const PANE = {
  plugin: 'omnis-swarm',
  component: 'Pane',
  requestId: 'omnis-swarm',
  props: { title: 'Swarm', isFocused: false, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 44 }, view: {} },
} as const
const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const

type Seen = { calls: Array<{ tool: string; args: Record<string, unknown> }>; opens: number; blits: number }

/** Stands in for the engine and the MCP server, which answers the five-agent swarm's folded state. */
function engine(on: On): Seen {
  const seen: Seen = { calls: [], opens: 0, blits: 0 }
  const state = foldAll(FIVE_SWARM, fiveAgentEvents())
  let open = false
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => {
    seen.opens++
    open = true
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    open = false
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: open ? [{ id: 'omnis-swarm', title: 'Swarm', isShown: true, isFocused: false, isPlaced: true }] : [] }))
  on('ui.blit', () => {
    seen.blits++
    return { value: {} }
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('mcp.connect', () => ({ value: { isConnected: true, server: SERVER } }))
  on('mcp.call', (_, e) => {
    seen.calls.push({ tool: e.tool, args: e.args })
    const text = e.tool === 'omnis_feed' ? JSON.stringify({ v: 1, kind: 'state', swarm: FIVE_SWARM, offset: 100, state }) : '{}'
    return { value: { content: [{ type: 'text', text }], isError: false } }
  })
  on('session.id', () => ({ value: 'test-session' }))
  on('agent.list', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return seen
}

const feedCalls = (seen: Seen) => seen.calls.filter(c => c.tool === 'omnis_feed')
const rasterText = (el: { props: Record<string, unknown> } | undefined): string[] =>
  el === undefined ? [] : gridText(decodeCells(String(el.props.cells), Number(el.props.columns), Number(el.props.rows)))

test('/omnis pane opens the pane, pulls omnis_feed and draws the swarm in two Rasters with pin chips', async ($, on) => {
  const seen = engine(on)
  const clock = mock.clock(on, { now: FIVE_AT.mid })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ran = await $.command.run({ command: 'omnis', args: 'pane', ...RUN })
  expect(ran.text).toBe('Swarm pane open.')
  await clock.settle()
  expect(feedCalls(seen)[0]?.args).toEqual({ since: 0 })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const top = rasterText(await ui.find({ type: 'Raster', key: 'top' })).join('\n')
  const bottom = rasterText(await ui.find({ type: 'Raster', key: 'bottom' })).join('\n')
  expect(top).toContain('auth refactor')
  for (const name of ['architect', 'coder-1', 'coder-2', 'tester', 'reviewer']) expect(top).toContain(name)
  expect(bottom).toContain('tokens')
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(6)
  await ui.unmount()
})

test('a pin chip changes only what is shown: it pins the spotlight, and pressing it again unpins', async ($, on) => {
  const seen = engine(on)
  const clock = mock.clock(on, { now: FIVE_AT.mid })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'omnis', args: 'pane', ...RUN })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'pin:a-test' })
  expect(rasterText(await ui.find({ type: 'Raster', key: 'bottom' }))[0]).toContain('tester')
  expect((await ui.find({ type: 'Button', key: 'pin:a-test' }))?.props.variant).toBe('primary')
  await ui.press({ key: 'pin:a-test' })
  expect((await ui.find({ type: 'Button', key: 'pin:a-test' }))?.props.variant).toBeUndefined()
  expect(seen.calls.every(c => c.tool === 'omnis_feed' || c.tool === 'omnis_record')).toBe(true)
  await ui.unmount()
})

test('pulls run at most 4 a second and stop when the pane closes', async ($, on) => {
  const seen = engine(on)
  const clock = mock.clock(on, { now: FIVE_AT.mid })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'omnis', args: 'pane', ...RUN })
  await clock.settle()
  const before = feedCalls(seen).length
  await clock.advance(1000)
  const perSecond = feedCalls(seen).length - before
  expect(perSecond).toBeGreaterThanOrEqual(1)
  expect(perSecond).toBeLessThanOrEqual(4)
  const closed = await $.command.run({ command: 'omnis', args: 'pane close', ...RUN })
  expect(closed.text).toBe('Swarm pane closed.')
  const atClose = feedCalls(seen).length
  await clock.advance(2000)
  expect(feedCalls(seen).length).toBe(atClose)
})

test('off the terminal the same picture is an Svg, and nothing is blitted', async ($, on) => {
  const seen = engine(on)
  const clock = mock.clock(on, { now: FIVE_AT.mid })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'omnis', args: 'pane', ...RUN })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const svgs = await ui.findAll({ type: 'Svg' })
  expect(svgs).toHaveLength(2)
  expect(String(svgs[0]?.props.source)).toContain('architect')
  expect(String(svgs[0]?.props.alt)).toContain('auth refactor')
  expect(seen.blits).toBe(0)
  await ui.unmount()
})

test('panel off refuses to open the pane', { options: { panel: 'off' } }, async ($, on) => {
  const seen = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ran = await $.command.run({ command: 'omnis', args: 'pane', ...RUN })
  expect(ran.text).toMatch(/off/)
  expect(seen.opens).toBe(0)
})

test('/omnis-swarm:watch opens it too, and an unknown subcommand gets the usage', async ($, on) => {
  const seen = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect((await $.command.run({ command: 'omnis-swarm:watch', args: '', ...RUN })).text).toBe('Swarm pane open.')
  expect(seen.opens).toBe(1)
  expect((await $.command.run({ command: 'omnis', args: 'nonsense', ...RUN })).text).toMatch(/^Usage/)
})

test('auto opens the pane when a swarm starts, but not again after the person closed it', { options: { panel: 'auto' } }, async ($, on) => {
  const seen = engine(on)
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: INIT, name: 'x', topology: 'mesh' })
  expect(seen.opens).toBe(1)
  await $.command.run({ command: 'omnis', args: 'pane close', ...RUN })
  await $.tool.call({ tool: INIT, name: 'y', topology: 'mesh' })
  expect(seen.opens).toBe(1)
})
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npm run test:mod`
Expected: FAIL (the stub registers nothing: `/omnis pane` has no answer, no Raster is drawn). If `claude` is not on PATH the script says it skipped; the tests must run, so run this task where `claude` is installed.

- [ ] **Step 3: Write `commands/watch.md`**

```markdown
---
description: Show the live OmnisSwarm pane (the same as /omnis pane)
---
The OmnisSwarm pane needs Claude Code mods (function hooks), and they are not running in this session, so there is no pane to open. Tell the user that in one sentence, mention that policy settings such as disableAllHooks, allowManagedHooksOnly or allowManagedModsOnly turn mods off, and do nothing else.
```

- [ ] **Step 4: Replace `src/mod/pane.ts`**

```ts
/**
 * The swarm pane. /omnis pane (or /omnis-swarm:watch) opens it. While it is placed and shown it pulls omnis_feed at
 * most 4 times a second, folds what arrives and draws render()'s frame: two Rasters with a row of pin chips on the
 * terminal, an Svg of the same cells elsewhere. Informational only: nothing here prompts, runs a tool other than
 * omnis_feed, or writes to the swarm. The chips change only what the pane shows.
 */
import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, On, PluginOptions, RenderElement, Timer } from 'claude-code'
import { parseFeedReply } from '../core/feed-reply.ts'
import { hex } from '../render/color.ts'
import { frameInterval, render } from '../render/frame.ts'
import type { Grid } from '../render/grid.ts'
import { chooseSpotlight } from '../render/spotlight.ts'
import { CELL_W, gridToSvg } from '../render/svg.ts'
import { GLYPH, PULL_MS } from '../render/tokens.ts'
import type { Frame, Size, Spot, Tween, View } from '../render/types.ts'
import { applyReply, emptyModel, feedArgs, prunePulses, type PaneModel } from './pane-model.ts'
import { connectServer } from './server.ts'

export const PANE_ID = 'omnis-swarm'
const FEED_TOOL = 'omnis_feed'
const SWARM_INIT_TOOL = 'mcp__plugin_omnis-swarm_omnis-swarm__omnis_swarm_init'
const pinnedAtom = atom({ plugin: 'omnis-swarm', key: 'panePinned' } as const, null)

type Panel = 'command' | 'auto' | 'off'
type Kit = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

type Runtime = {
  panel: Panel
  engine: EngineInterface | null
  open: boolean
  closedByPerson: boolean
  server: string | null
  model: PaneModel
  pulling: boolean
  pullTimer: Timer | null
  frameTimer: Timer | null
  frameMs: number
  renderMs: number
  spot: Spot | null
  tween: Tween | null
  pinned: string | null
  surface: string | null
  size: Size | null
  last: Frame | null
  /** The size each Raster was last mounted at; a blit of any other size is refused, so none is sent. */
  mounted: { top: string | null; bottom: string | null }
}

const panelOf = (x: unknown): Panel => (x === 'auto' || x === 'off' ? x : 'command')
const fresh = (panel: Panel): Runtime => ({
  panel, engine: null, open: false, closedByPerson: false, server: null, model: emptyModel(), pulling: false, pullTimer: null,
  frameTimer: null, frameMs: 0, renderMs: 0, spot: null, tween: null, pinned: null, surface: null, size: null, last: null,
  mounted: { top: null, bottom: null },
})

/** Module state. A hot reload starts it over and the pane pulls a fresh state within one PULL_MS; the pin is in $.state. */
let rt: Runtime = fresh('command')

const sizeKey = (g: Grid): string => `${g.columns}x${g.rows}`
const viewOf = (): View => ({ pinned: rt.pinned, spotlight: rt.spot, pulses: rt.model.pulses, lagMs: rt.model.lagMs, tween: rt.tween })
const waitingText = (): string =>
  rt.model.swarm === null ? 'No swarm yet. One starts with the first agent, or with omnis_swarm_init.' : 'Reading the swarm…'

/** The frame at `now`, after choosing the spotlight. Starts a glide when the node set changed. Null until there is a state and a size. */
function frameAt(now: number): Frame | null {
  const state = rt.model.state
  if (state === null || rt.size === null) return null
  rt.model = { ...rt.model, pulses: prunePulses(rt.model.pulses, now) }
  rt.spot = chooseSpotlight(rt.spot, rt.pinned, state, rt.model.pulses, now)
  const frame = render(state, viewOf(), now, rt.size)
  if (rt.last !== null && frame.nodesKey !== rt.last.nodesKey) rt.tween = { from: rt.last.positions, at: now }
  return frame
}

function redraw($: EngineInterface): void {
  try {
    $.ui.invalidate('ui.render')
  } catch {
    // A refused redraw leaves the last frame on screen.
  }
}

function blitFrame($: EngineInterface, frame: Frame): void {
  const grids: Array<[string, Grid | null, string | null]> = [['top', frame.top, rt.mounted.top], ['bottom', frame.bottom, rt.mounted.bottom]]
  for (const [key, grid, mounted] of grids) {
    if (grid === null || mounted !== sizeKey(grid)) continue
    void $.ui.blit({ requestId: PANE_ID, key, cells: grid.encode(), columns: grid.columns, rows: grid.rows }).catch(() => undefined)
  }
}

function stopFrames(): void {
  rt.frameTimer?.cancel()
  rt.frameTimer = null
  rt.frameMs = 0
}

/** Runs the frame loop at `fps`, slower while frames are slow; stops it at 0, when closed, or off the terminal. */
function animate($: EngineInterface, fps: number): void {
  if (fps <= 0 || !rt.open || rt.surface !== 'terminal') {
    stopFrames()
    return
  }
  const interval = frameInterval(fps, rt.frameMs, rt.renderMs)
  if (rt.frameTimer !== null && interval === rt.frameMs) return
  rt.frameTimer?.cancel()
  rt.frameMs = interval
  rt.frameTimer = $.clock.every(interval, () => tick($))
}

function tick($: EngineInterface): void {
  const started = Date.now()
  const frame = rt.open ? frameAt(started) : null
  if (frame === null || rt.last === null) {
    stopFrames()
    return
  }
  if (frame.treeKey !== rt.last.treeKey) {
    stopFrames()
    redraw($)
    return
  }
  blitFrame($, frame)
  rt.last = frame
  rt.renderMs = Date.now() - started
  animate($, frame.fps)
}

/** After news: blit when the element tree still fits, otherwise ask for a redraw. */
function show($: EngineInterface, now: number): void {
  const frame = frameAt(now)
  if (frame === null || rt.last === null || rt.surface !== 'terminal' || frame.treeKey !== rt.last.treeKey) {
    redraw($)
    return
  }
  blitFrame($, frame)
  rt.last = frame
  animate($, frame.fps)
}

function stopAll(): void {
  rt.pullTimer?.cancel()
  rt.pullTimer = null
  stopFrames()
}

function closed(byPerson: boolean): void {
  rt.open = false
  rt.closedByPerson = rt.closedByPerson || byPerson
  stopAll()
  rt.last = null
  rt.mounted = { top: null, bottom: null }
}

async function pull($: EngineInterface): Promise<void> {
  if (rt.pulling || !rt.open) return
  rt.pulling = true
  try {
    const me = (await $.ui.panes()).find(p => p.id === PANE_ID)
    if (me === undefined) {
      closed(false)
      return
    }
    if (!me.isPlaced || !me.isShown) {
      stopFrames()
      return
    }
    if (rt.server === null) {
      rt.server = await connectServer($)
      if (rt.server === null) return
    }
    const result = await $.mcp.call(rt.server, FEED_TOOL, feedArgs(rt.model))
    const block = result.content[0]
    const reply = !result.isError && block !== undefined && block.type === 'text' && typeof block.text === 'string' ? parseFeedReply(block.text) : null
    if (reply === null) return
    const now = Date.now()
    const applied = applyReply(rt.model, reply, now)
    rt.model = applied.model
    if (applied.swarmChanged) {
      rt.spot = null
      rt.tween = null
      rt.last = null
    }
    if (applied.changed || applied.swarmChanged) show($, now)
  } catch {
    // A failed pull shows less and changes nothing else; the next tick tries again.
  } finally {
    rt.pulling = false
  }
}

function startPulling($: EngineInterface): void {
  if (rt.pullTimer !== null) return
  rt.pullTimer = $.clock.every(PULL_MS, () => {
    void pull($)
  })
  void pull($)
}

async function openPane($: EngineInterface): Promise<{ isPlaced: boolean; reason: string }> {
  try {
    const result = await $.ui.open({ id: PANE_ID, title: 'Swarm' })
    rt.closedByPerson = false
    rt.open = true
    startPulling(rt.engine ?? $)
    return result.isPlaced ? { isPlaced: true, reason: '' } : { isPlaced: false, reason: result.reason }
  } catch (err) {
    return { isPlaced: false, reason: err instanceof Error ? err.message.slice(0, 160) : 'the pane could not be opened' }
  }
}

async function paneCommand($: EngineInterface, arg: string): Promise<string> {
  if (arg === 'close') {
    await $.ui.close({ id: PANE_ID }).catch(() => undefined)
    closed(true)
    return 'Swarm pane closed.'
  }
  if (rt.panel === 'off') return 'The swarm pane is off (the panel setting). Set it to command or auto in /config to use it.'
  const opened = await openPane($)
  return opened.isPlaced ? 'Swarm pane open.' : `The swarm pane is waiting to be shown: ${opened.reason}`
}

/** Awaited by its hooks after next(e), so the open has settled when the hook returns (the kit settles fire-and-forget calls late). */
async function maybeAutoOpen($: EngineInterface): Promise<void> {
  if (rt.panel !== 'auto' || rt.open || rt.closedByPerson) return
  await openPane($)
}

async function togglePin($: EngineInterface, id: string): Promise<void> {
  await update($, pinnedAtom, current => (current === id ? null : id))
}

/** The chip row: one plain Button per agent, as many as fit, then "+n". Pressing one pins it; pressing it again unpins. */
function chipRow($: EngineInterface, kit: Kit, frame: Frame, columns: number): RenderElement[] {
  if (frame.chips.length === 0) return []
  const shown: typeof frame.chips = []
  let width = 0
  for (const chip of frame.chips) {
    const w = [...chip.label].length + 4
    if (shown.length > 0 && width + w > columns - 4) break
    shown.push(chip)
    width += w
  }
  const buttons = shown.map(chip => kit.Button({
    key: `pin:${chip.id}`,
    plain: true,
    ...(chip.pinned && { variant: 'primary' as const }),
    onPress: () => {
      void togglePin($, chip.id)
    },
    children: [kit.Text({ color: hex(chip.color), children: chip.pinned ? GLYPH.pinned : GLYPH.dot }), ` ${chip.label}`],
  }))
  const more = frame.chips.length - shown.length
  return [kit.Box({ key: 'chips', flexDirection: 'row', gap: 2, children: [...buttons, ...(more > 0 ? [kit.Text({ dimColor: true, children: `+${more}` })] : [])] })]
}

export function registerPane(on: On, options: PluginOptions): void {
  rt = fresh(panelOf(options.panel))

  on('session.start', async ($, e, next) => {
    rt.engine = $
    await $.command.register({
      name: 'omnis',
      description: 'OmnisSwarm: /omnis pane shows the live swarm pane, /omnis pane close hides it',
      argumentHint: 'pane [close]',
      immediate: true,
    }).catch(() => undefined)
    try {
      // After a hot reload the pane is still open: keep it pulling.
      if ((await $.ui.panes()).some(p => p.id === PANE_ID)) {
        rt.open = true
        startPulling($)
      }
    } catch {
      // No surface yet; the pane opens on request.
    }
    return next(e)
  })

  on('command.run', { command: 'omnis' }, async ($, e) => {
    const [sub = '', arg = ''] = e.args.trim().toLowerCase().split(/\s+/)
    if (sub !== 'pane') return { text: 'Usage: /omnis pane, or /omnis pane close.' }
    return { text: await paneCommand($, arg) }
  })

  on('command.run', { command: 'omnis-swarm:watch' }, async $ => ({ text: await paneCommand($, '') }))

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    rt.pinned = await read($, pinnedAtom)
    rt.surface = e.surface
    rt.open = true
    rt.size = {
      columns: Math.max(1, Math.floor(Number(e.props.bodyColumns) || 1)),
      rows: Math.max(1, Math.floor(Number(e.props.scroll.bodyRows) || 1)),
    }
    if (rt.engine !== null) startPulling(rt.engine)
    const frame = frameAt(Date.now())
    rt.last = frame
    if (e.surface === 'terminal') {
      const { Box, Text, Button, Raster } = $.ui.resolve(e)
      if (frame === null) {
        rt.mounted = { top: null, bottom: null }
        return Text({ dimColor: true, children: waitingText() })
      }
      rt.mounted = { top: sizeKey(frame.top), bottom: frame.bottom === null ? null : sizeKey(frame.bottom) }
      if (rt.engine !== null) animate(rt.engine, frame.fps)
      return Box({
        flexDirection: 'column',
        children: [
          Raster(frame.top.toRaster('top')),
          ...chipRow($, { Box, Text, Button }, frame, rt.size.columns),
          ...(frame.bottom === null ? [] : [Raster(frame.bottom.toRaster('bottom'))]),
        ],
      })
    }
    const { Box, Text, Button, Svg } = $.ui.resolve(e)
    rt.mounted = { top: null, bottom: null }
    stopFrames()
    if (frame === null) return Text({ dimColor: true, children: waitingText() })
    const picture = (grid: Grid, key: string): RenderElement => {
      const source = typeof Svg === 'function' ? gridToSvg(grid, frame.alt) : null
      return source === null ? Text({ children: frame.alt }) : Box({ key: `svg-${key}`, children: [Svg({ source, alt: frame.alt, width: grid.columns * CELL_W })] })
    }
    return Box({
      flexDirection: 'column',
      children: [picture(frame.top, 'top'), ...chipRow($, { Box, Text, Button }, frame, rt.size.columns), ...(frame.bottom === null ? [] : [picture(frame.bottom, 'bottom')])],
    })
  })

  on('ui.close', async ($, e, next) => {
    const result = await next(e)
    if (e.id === PANE_ID) closed(e.origin.kind === 'person')
    return result
  })

  on('tool.call', { tool: SWARM_INIT_TOOL }, async ($, e, next) => {
    const result = await next(e)
    try {
      await maybeAutoOpen($)
    } catch {
      // Opening the pane must never change the tool call's result.
    }
    return result
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    try {
      await maybeAutoOpen($)
    } catch {
      // As above: observe only.
    }
    return result
  })
}
```

- [ ] **Step 5: Type-check and validate the mod**

Run: `npx tsc -p tsconfig.mod.json` then `claude plugin validate .`
Expected: no type errors; validate lists the pane's hooks (`session.start`, `command.run` x2, `ui.render`, `ui.close`, `tool.call`, `agent.spawn`) and its `$` calls, and refuses nothing. Where a shape here differs from this build's `claude-code.d.ts` (for example a matcher's typing), follow the d.ts and keep the behaviour.

- [ ] **Step 6: Run the mod tests**

Run: `npm run test:mod`
Expected: PASS, 7 tests in `src/mod/pane.test.ts` (and phase 2's mod tests still pass).

- [ ] **Step 7: Run the gate, then commit**

Run: `npm run check` (expected: green; the mod-safe walk now covers `src/mod/pane.ts`, which may import `claude-code`), then:

```bash
git add src/mod/pane.ts src/mod/pane.test.ts commands/watch.md
git commit -m "Add the swarm pane mod: /omnis pane, feed pulls while shown, Raster frames with blits, view-only pin chips and an Svg fallback"
```

---

### Task 17: Headless five-agent pane e2e through the engine  *(wave 7, serial, after 16)*

**Files:**
- Create: `src/mod/pane-e2e.test.ts`

**Interfaces:**
- Consumes: the pane mod (Task 16), `fiveAgentEvents`, `FIVE_SWARM`, `FIVE_AT`, `foldAll`, `decodeCells`, `gridText`.
- Produces: an engine-level test (spec §12 e2e) where a stand-in server answers like the real one: a `state` for the first 30 events at offset 30, then the remaining 16 as an `events` reply, and nothing new after that.

- [ ] **Step 1: Write the test**

`src/mod/pane-e2e.test.ts`:

```ts
import { expect, mock, test } from 'claude-code/testing'
import { foldAll } from '../core/fold.ts'
import { decodeCells, gridText } from '../render/grid.ts'
import { FIVE_AT, FIVE_SWARM, fiveAgentEvents } from '../../tests/fixtures/swarm-five.ts'

const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const
const PANE = {
  plugin: 'omnis-swarm', component: 'Pane', requestId: 'omnis-swarm',
  props: { title: 'Swarm', isFocused: false, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 44 }, view: {} },
} as const

test('a scripted five-agent swarm arrives in two pulls and the pane draws and repaints it', async ($, on) => {
  const events = fiveAgentEvents()
  const blits: Record<string, { cells: string; columns: number; rows: number }> = {}
  const asked: unknown[] = []
  let open = false
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => {
    open = true
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: open ? [{ id: 'omnis-swarm', title: 'Swarm', isShown: true, isFocused: false, isPlaced: true }] : [] }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.blit', (_, e) => {
    if ('cells' in e) blits[e.key] = { cells: e.cells, columns: e.columns ?? 0, rows: e.rows ?? 0 }
    return { value: {} }
  })
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'plugin:omnis-swarm:omnis-swarm' } }))
  on('mcp.call', (_, e) => {
    if (e.tool !== 'omnis_feed') return { value: { content: [{ type: 'text', text: '{}' }], isError: false } }
    asked.push(e.args)
    const since = Number(e.args.since ?? 0)
    const reply = since === 0
      ? { v: 1, kind: 'state', swarm: FIVE_SWARM, offset: 30, state: foldAll(FIVE_SWARM, events.slice(0, 30)) }
      : since === 30
        ? { v: 1, kind: 'events', swarm: FIVE_SWARM, offset: 46, events: events.slice(30), bad: 0 }
        : { v: 1, kind: 'events', swarm: FIVE_SWARM, offset: since, events: [], bad: 0 }
    return { value: { content: [{ type: 'text', text: JSON.stringify(reply) }], isError: false } }
  })
  on('session.id', () => ({ value: 'test-session' }))
  on('agent.list', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const clock = mock.clock(on, { now: FIVE_AT.mid })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'omnis', args: 'pane', ...RUN })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const first = await ui.find({ type: 'Raster', key: 'top' })
  const firstText = gridText(decodeCells(String(first?.props.cells), Number(first?.props.columns), Number(first?.props.rows))).join('\n')
  expect(firstText).toContain('6 agents')
  expect(firstText).not.toContain('ghost')

  await clock.advance(250)
  expect(asked).toContainEqual({ since: 30, swarm: FIVE_SWARM })
  const top = blits.top
  const bottom = blits.bottom
  expect(top).toBeDefined()
  expect(bottom).toBeDefined()
  const topText = gridText(decodeCells(top!.cells, top!.columns, top!.rows)).join('\n')
  const bottomText = gridText(decodeCells(bottom!.cells, bottom!.columns, bottom!.rows)).join('\n')
  for (const name of ['lead', 'architect', 'coder-1', 'coder-2', 'tester', 'reviewer', 'ghost']) expect(topText).toContain(name)
  expect(bottomText).toContain('task t2 → done')
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(6)
  await ui.unmount()
})
```

- [ ] **Step 2: Run it**

Run: `npm run test:mod`
Expected: PASS, 8 tests in total for the pane (7 from Task 16 and this one). If it fails, fix the pane, not the test; if the kit reports a blit argument shape different from `RasterBlitArgs`, read it per the d.ts.

- [ ] **Step 3: Run the gate, then commit**

Run: `npm run check` (expected: green), then:

```bash
git add src/mod/pane-e2e.test.ts
git commit -m "Add a headless engine e2e: a five-agent swarm arrives in two pulls and the pane draws then repaints it"
```

---

### Task 18: Merge and final gate  *(wave 8, serial; omnis-integrator)*

**Files:** none new.

- [ ] **Step 1: Merge the phase 3 branch into master** (after the lead's final review), resolving nothing by hand in shared files except the lines Task 15 named.

Run: `git checkout master && git merge --no-ff phase3-pane`

- [ ] **Step 2: Run the full gate on master**

Run: `npm run check`
Expected: both typechecks clean, all `node --test` tests pass (phase 1's 214, phase 2's, and phase 3's), `claude plugin validate .` clean, all mod tests pass.

- [ ] **Step 3: Report** the merge commit, the test counts and any warning `claude plugin validate` printed.

---

### Task 19: Interactive acceptance with Rob  *(wave 9, manual)*

Not automatable: it needs a person at an interactive terminal (spec §10 and §15 leave the Raster's look and blit rate to an interactive check).

- [ ] **Step 1: Rob starts a session with the plugin**

In a fullscreen terminal at least 140 columns wide: `claude --plugin-dir C:\projects\personal\OmnisSwarm --debug`, then `/omnis pane`.

- [ ] **Step 2: Rob runs a real swarm**

Prompt: `Use omnis_swarm_init to start a hierarchical swarm called "pane check", then spawn five general-purpose agents in parallel: an architect who reads src/core/fold.ts and messages two coders with one tip each, two coders who each read a different file in src/render and reply to the architect, a tester who runs npm test, and a reviewer who reads the spec's section 10. Each agent sends one SendMessage to main when done.`

- [ ] **Step 3: Rob checks, and reports each as yes or no with a note**

1. Nodes fade in as agents start; running nodes glow; finished nodes go to a ghost; any failure stays red with `✕`.
2. Each message fires a comet along its link with a fading trail.
3. Tool calls flicker the node's rim; an error pulses red.
4. The spotlight follows the busiest agent and holds each for at least 5 s; pressing a chip pins it, pressing again unpins; nothing else happens on a press.
5. Shrinking the terminal steps down: no timeline, then a one-line spotlight, then the tree, then one line.
6. Motion looks smooth; colours look like the PNG previews; nothing bands or snaps badly.
7. After `/omnis pane close`, the debug log shows no further `omnis_feed` calls.
8. Asking the model to call `omnis_feed` is refused with the guard's reason.
9. The header's ≈ cost sits close to the `cc $` figure once the lead has finished a turn.

- [ ] **Step 4: The lead records the outcome** in the ledger, and opens fix tasks (designer for look, developer for behaviour) for every "no".

---

## Open questions and unverified assumptions

1. **Phase 2 scaffold:** settled. It is on master and matches what this plan needs (see "Shared scaffold owned by phase 2"), including the staged `test:mod` that keeps `tests/**` node suites out of `claude plugin test`.
2. **Dropped recorder events:** settled by phase 2's Task 5 (`data.dropped` adds to `state.gaps`, which the header shows).
3. **`omnis_feed` simplification:** spec §10 describes "at most 500 events, with the new offset and a flag when more are waiting". This plan answers a fresh state when more than 500 are waiting, so there is no `more` flag; the effect for the pane is the same and it avoids per-event offsets. Confirm, or the spec line changes.
4. **`render`'s return:** spec §4 says `render(...) → Grid`; this plan returns a `Frame` (two grids, chips, keys, fps, alt) because the chips are Buttons between two Rasters. Spec wording to update if accepted.
5. **Raster palette and blit rate (unverified, Task 2):** whether the 1024-pair palette is per Raster or per screen, and how many blits a second land. `PAIR_BUDGET` assumes a shared budget (700 + 300); `FPS.busy` is 30.
6. **`/omnis-swarm:watch`:** that a mod's `command.run` hook fires for a plugin's markdown command rests on RuFlo doing exactly this (`ruflo-swarm/0.3.7/hooks/register.ts`), not on our own probe. Task 16's test covers it in the kit.
7. **Test-kit details** (answering `$` calls with `{ value }`, a void `ui.close` answer, `$.command.run` taking the full `CommandRunInput`, `ui.find` exposing a Raster's `cells` in `props`, `mock.clock` not moving `Date.now()`) are read from the d.ts and the bundled example, not run. Task 16 follows the d.ts where they differ.
8. **Timers through the `session.start` `$`**: the pane runs its pull and frame timers and its blits through the `$` captured at `session.start`, as RuFlo's panes do. Not probed by us.
9. **Reply size:** a fresh `state` reply carries the whole `SwarmState` (feed of 200, up to 30 samples and 200 files per agent). No documented `$.mcp.call` size limit; fresh states only happen on the first pull, a swarm change or after falling 500 events behind.
10. **Light terminal themes:** the pane paints its own dark canvas so contrast is fixed whatever the theme. The designer confirms or changes this in Task 1.
11. **`/omnis` ownership:** phase 3 registers the `omnis` command and answers usage for any subcommand other than `pane`. If phase 2 wants `/omnis` subcommands too, the hook must pass them on with `next(e)` instead.
