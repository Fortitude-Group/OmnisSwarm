# Swarm pane: design direction

How the live swarm pane looks and moves. `src/render/tokens.ts` copies the **Tokens** table in section 3; every
render task builds what sections 4 to 10 describe. Task 13 reviews the golden snapshots against section 11.

**What was checked and how.** I computed every contrast ratio in section 3 with the WCAG formula, using the plan's
Task 1 one-liner and a longer script that also prints ratios on `CANVAS_RAISED` and white. I checked colour-blind
separation by running each palette through the Machado 2009 simulation matrices (protanopia, deuteranopia,
tritanopia, full severity) and measuring OKLab distance (reported ×100; about 2 is just noticeable, 10 or more is
clearly different for a node-sized patch). **Not checked:** how any of this looks in a real terminal, blit
throughput, and the 1024-pair palette. Those need Task 2's interactive probe. The glyph widths in section 5 come
from the Unicode East Asian Width and emoji data as I know them; nothing here has been run through a terminal.

## 1. Principles

1. **Motion explains, it never decorates.** Every moving thing stands for an event or a state:
   - a **comet** along a link means a message moved, sender to receiver;
   - a slow **glow** (breathing halo) means the agent is working right now;
   - a **flicker** of the node's rim in a tool kind's colour means a tool call started;
   - a **red pulse** on the rim means a tool call failed;
   - a **ghost** (the node slowly greying and dimming) means the agent finished;
   - a **blinking red rim on two nodes** joined by a dashed red line means both edited the same file.
   Nothing moves for any other reason: no idle shimmer, no background drift, no easing on text.
2. **Status never relies on colour alone.** Each status has its own glyph and, where it is live, its own motion
   (section 4). In greyscale, or under any colour-vision deficiency, the glyph still says which status it is.
3. **The pane paints its own dark canvas**, so it reads the same on dark and light terminal themes (section 2).
4. **Quiet by default.** Text is mostly `TEXT.dim`, and only names, numbers and live things get full strength. When
   nothing is happening, nothing moves, and the eye goes to whatever does.

## 2. Canvas and theme

Every cell of both Rasters has an explicit background: `CANVAS` (`#0b0f17`) for the graph, timeline and feed, and
`CANVAS_RAISED` (`#131a26`) for the header row(s), the one-line summary and the spotlight card. No cell inside a
Raster uses the terminal default colour (`0x01000000`) for foreground or background.

**I confirm the plan's choice, for three reasons.**
- Glow, fades, ghosts and comet trails all blend toward the background. We can only blend toward a colour we know.
  On the terminal's default background, `mix(c, bg, t)` has no `bg`.
- One fixed background means one contrast check per colour. A theme-following palette would have to pass on
  black, white, Solarized and everything between, and the light-theme versions of model yellow and sky blue fail.
- A self-painted pane reads like an embedded picture, which is what it is. On a light theme it is a dark panel in a
  light window, like a video or a code screenshot.

**What stays on the terminal theme:** the pane's title and border (engine chrome) and the **chip row** between the
two Rasters. Chips are `Button`s, which the terminal draws `[ label ]` with its own colours (primary in the theme's
accent). On a light theme the chip row is a light band between two dark panels. That is accepted: painting the row
dark would also mean overriding the Buttons' text and focus colours, and we can't see how they render until Task 2.
So for the chips:
- The label text has **no colour set** (terminal default), so it always reads on the theme.
- The leading dot (`●`, or `◉` when pinned) uses a **theme-neutral** form of the model colour: the model colour
  scaled down (`scale(c, k)`, k found by halving the interval about 20 times) until its relative luminance is at most
  **0.18**. A colour at luminance 0.18 gets about 4.6:1 on both pure black and pure white. Measured: 4.57-4.60 on
  `#000000`, 4.23-4.28 on `#0c0c0c` (Windows Terminal Campbell) and `#fdf6e3` (Solarized light), 3.63 on `#1e1e1e`,
  3.27 on `#002b36` (Solarized dark). Resulting dots: fable `#9e628b`, opus `#3f73d1`, sonnet `#31854e`, haiku
  `#7e7823`, other `#707681`. They look alike under colour-vision deficiency (equal luminance does that), but the
  label names the agent, so the dot is only a key to the node colour. **Task 12: `Chip.color` is this
  theme-neutral colour, not `modelColor(...)` straight.**

**256-colour terminals.** If the terminal is ever painted in 256 colours, the nearest xterm colours keep the canvas
(`#121212`) and the raised panels (`#1c1c1c`) apart. Glow and fade ramps will band, but no meaning rides on a ramp
alone, so the pane stays correct. Task 2 should say whether Claude Code ever downsamples a Raster.

## 3. Tokens

Contrast is the WCAG ratio on `CANVAS` `#0b0f17`, from the Task 1 one-liner run on these values (the ratio on
`CANVAS_RAISED` is about 9% lower; every token that must reach 4.5:1 or 3:1 on `CANVAS` still does on
`CANVAS_RAISED`, except `TEXT.faint`, which is 3.02 there and is never used for information). "Text" means the colour
is used for words or numbers and must reach 4.5:1. "Signal" means it marks something and must reach 3:1.

| Token | Value | Use | Contrast on `CANVAS` |
|---|---|---|---|
| `CANVAS` | `#0b0f17` | Background of the graph, timeline and feed | — |
| `CANVAS_RAISED` | `#131a26` | Background of the header, summary and spotlight card | 1.10 |
| `TEXT.primary` | `#e6edf3` | Names, numbers, the running agent's label (text) | 16.23 |
| `TEXT.dim` | `#9aa4b2` | Labels, units, secondary words, ages in the feed, idle agents' labels (text) | 7.61 |
| `TEXT.faint` | `#5c6679` | Separators ` · `, the timeline axis, empty bar cells `░`, placeholder node fill. **Never information text** | 3.32 |
| `ACCENT` | `#b48cff` | The lead's `◆` marker in labels and the header | 7.43 |
| `MODEL.fable` | `#ff9fe0` | Fable and Mythos agents: node fill, timeline bar, tree name (text) | 10.31 |
| `MODEL.opus` | `#4d8dff` | Opus agents (text) | 6.00 |
| `MODEL.sonnet` | `#4cd07a` | Sonnet agents (text) | 9.69 |
| `MODEL.haiku` | `#f0e442` | Haiku agents (text) | 14.50 |
| `MODEL.other` | `#808794` | Unknown model family (text) | 5.31 |
| `STATUS.running` | `#7ee787` | The `▶` glyph and the word "running" (text) | 12.48 |
| `STATUS.waiting` | `#9aa4b2` | The `◌` glyph and "waiting" (text) | 7.61 |
| `STATUS.done` | `#8b98a9` | The `✓` glyph and "done" (text) | 6.54 |
| `STATUS.failed` | `#f85149` | `✕`, "failed", a failed node's fill, error pulses, the context ring from 90% (text) | 5.72 |
| `STATUS.warn` | `#e69f00` | `!` stuck, the stuck rim, the context ring and bar from 70%, `⚠` gaps (text) | 8.52 |
| `KIND.read` | `#4fd8e8` | Rim flicker for a read; the `r` letter in the tools row (signal) | 11.25 |
| `KIND.edit` | `#ffc861` | Edit (signal) | 12.50 |
| `KIND.bash` | `#c49bff` | Bash (signal) | 8.66 |
| `KIND.search` | `#a6e35a` | Search (signal) | 12.56 |
| `KIND.web` | `#6f95ff` | Web (signal) | 6.78 |
| `KIND.agent` | `#ff86c2` | Agent spawn or message tool (signal) | 8.62 |
| `KIND.other` | `#9aa4b2` | Any other tool (signal). Was `#d6dbe1`: a near-white flash read as a glitch, and "other" was the commonest kind in a real run | 7.61 |
| `LINK.idle` | `#2b3546` | A message link with no recent traffic. Deliberately faint: it is the quietest layer | 1.55 |
| `LINK.active` | `#9ecbff` | A message link just after a message; comet trail colour | 11.36 |
| `LINK.comet` | `#f5fbff` | The comet's head | 18.38 |
| `LINK.clash` | `#f85149` | The dashed file-clash line and blinking rims (same red as `STATUS.failed`) | 5.72 |
| `FEED_COLOR.agent` | `#9aa4b2` | Agent started/finished lines (text) | 7.61 |
| `FEED_COLOR.message` | `#9ecbff` | Message lines, the same blue as the link that carried it (text) | 11.36 |
| `FEED_COLOR.memory` | `#d2a8ff` | Memory writes (text) | 9.85 |
| `FEED_COLOR.task` | `#ffb86b` | Task changes (text) | 11.25 |
| `FEED_MARK.agent` / `.message` / `.memory` / `.task` | `•` / `›` / `+` / `#` | The mark before each feed line, so the kind reads without colour | — |
| `GLYPH.running` / `waiting` / `done` / `failed` | `▶` / `◌` / `✓` / `✕` | Status glyphs (section 4) | — |
| `GLYPH.lead` / `unknown` / `stuck` / `clash` | `◆` / `?` / `!` / `!` | Lead marker; placeholder status; stuck after a label; clash before a path | — |
| `GLYPH.gap` / `dot` / `pinned` | `⚠` / `●` / `◉` | Log-gap marker; chip and spotlight dot; pinned chip | — |
| `MOTION.fadeInMs` | 600 | New node fades in from the canvas, ease-out cubic | — |
| `MOTION.ghostMs` | 1500 | Finished node fades to its ghost, linear | — |
| `MOTION.glowPeriodMs` | **2000** | One breath of a running node's halo (was 1600; slower reads calmer and gives 10 frames a breath at `FPS.glow`) | — |
| `MOTION.cometMs` | 900 | Comet head travel, sender to receiver, ease-in-out | — |
| `MOTION.trailMs` | 450 | How far behind the head the trail reaches, in time | — |
| `MOTION.trailDots` | 6 | Trail dots behind the head | — |
| `MOTION.linkFadeMs` | 3000 | A link's brightening after a message decays back to idle, linear | — |
| `MOTION.pulseMs` | **450** | Tool-start rim flicker, linear decay in 3 steps (was 350 in 4) | — |
| `MOTION.errorPulseMs` | 900 | Failed-tool red rim pulse, linear decay | — |
| `MOTION.clashFlashMs` | 4000 | A clash's rims blink for this long after the latest clashing edit | — |
| `MOTION.clashBlinkMs` | **400** | Half-period of the clash blink: 1.25 blinks a second (was 250) | — |
| `MOTION.tweenMs` | 400 | Nodes glide to new positions after a layout change, ease-out cubic | — |
| `FPS.busy` | **20** | Frame rate while a comet, fade-in, tool or error pulse, or glide is live (was 30) | — |
| `FPS.glow` | **5** | Frame rate for slow motion: glows, stuck rims, ghost fades, link fades, the clash blink (was 12) | — |
| `FPS.min` | 4 | Slowest rate at which a comet still reads as travelling; below it motion is dropped, not slowed (section 6) | — |
| `FPS.tick` | **1** (new) | Clock refresh while the pane is shown and nothing else moves (section 6) | — |
| `GRAPH.minRadius` | 1.6 | Smallest node radius, pixels (also every placeholder) | — |
| `GRAPH.maxRadius` | 6 | Largest node radius, pixels (also capped at graph height ÷ 7) | — |
| `GRAPH.glowPx` | 2.5 | Halo width beyond the ring, pixels | — |
| `GRAPH.ringPx` | 1.2 | Context ring width, pixels (drawn only when radius ≥ 2.2) | — |
| `GRAPH.linkThick` | [5, 20] | At 5 messages a link is drawn as a double arc; at 20 it also gets a soft pixel arc beneath | — |
| `GRAPH.linkBend` | 0.18 | Smallest bend: each message link bows to the left of its direction by this share of its length | — |
| `GRAPH.linkBendMax` | 0.5 | Largest bend: a link raises its bend up to this so its arc clears any node it passes over | — |
| `GRAPH.busyArcOffset` | 0.04 | A busy link's second arc bows this much more than the first | — |
| `SIZE.summaryBelowRows` / `summaryBelowColumns` | 6 / 30 | Below either, the one-line summary | — |
| `SIZE.treeBelowRows` / `treeBelowColumns` | 14 / 48 | Below either, the indented tree | — |
| `SIZE.compactBelowRows` | 22 | Below this, the spotlight becomes one row | — |
| `SIZE.noTimelineBelowRows` | 30 | Below this, no timeline | — |
| `SIZE.graphShare` | 0.55 | Share of the rows the top grid (header and graph) gets | — |
| `SIZE.minGraphRows` | 8 | Fewest graph rows before the tree takes over | — |
| `SIZE.spotlightRows` | 6 | Rows of the full spotlight card | — |
| `SIZE.timelineMaxRows` | 8 | Most timeline rows (agent rows plus the axis) | — |
| `SIZE.minFeedRows` | 2 | Fewest feed rows | — |
| `SPOTLIGHT_HOLD_MS` | 5000 | Least time the spotlight stays on one agent | — |
| `PULL_MS` | 250 | `omnis_feed` pull interval (at most 4 a second) | — |
| `PAIR_BUDGET.top` / `.bottom` | 700 / 300 | Distinct fg/bg pairs per grid until Task 2 measures the real limit | — |

**Changes from the plan's proposed values**, and why:

| Token | Was | Now | Why |
|---|---|---|---|
| `TEXT.faint` | `#4a5363` (2.28:1) | `#5c6679` (3.32:1) | It fills placeholder nodes and draws the axis, both signals that need 3:1. It is also used for no information text (see below) |
| `MODEL.fable` | `#cc79a7` | `#ff9fe0` | Under deuteranopia the old pink, teal and grey merged (OKLab 6.1 and 3.7). Lighter pink stays apart from blue by lightness |
| `MODEL.opus` | `#56b4e9` | `#4d8dff` | Old sky blue and teal were 2.4 apart under tritanopia, with equal lightness (0.1), so they could not be told apart at all |
| `MODEL.sonnet` | `#2ec4a0` | `#4cd07a` | Same tritanopia merge; a yellower green separates from blue |
| `MODEL.other` | `#a7b0be` | `#808794` | A darker grey stays clear of green under deuteranopia; 5.31:1 still passes for text |
| `STATUS.failed`, `LINK.clash` | `#ff6b4a` | `#f85149` | Failed and warn were 5.8 apart under deuteranopia; now 9.6. Failed against every model colour: 9.3 at worst |
| `KIND.*` | pastel set | see table | Read and web were 5.0 apart even with normal vision; the new set is 11.9 apart at worst with normal vision |
| `MOTION.clashBlinkMs` | 250 | 400 | 2 blinks a second for 4 s was harsh. 1.25 a second still reads as an alarm and is far under the 3-flashes-a-second seizure threshold |
| `FPS.tick` | — | 1 (new) | See section 6: without it, ages, live timeline bars and half-faded links freeze when nothing animates |

**Model palette separation** (minimum pairwise OKLab ×100): normal 16.5, protanopia 12.0, deuteranopia 12.0,
tritanopia 10.9. The proposed set scored 9.9 / 6.0 / 3.7 / 2.4. Model colours are shades a viewer must tell apart
across the graph, so they get the strictest check.

**Usage rules the code must follow:**
- `TEXT.faint` is never used for information. Task 8's feed draws the age column in **`TEXT.dim`**, not
  `TEXT.faint`. Separators, axis lines, empty bar cells and the structural-edge dots stay faint.
- `TEXT.primary` is for names and numbers that matter now; everything else on a row is `TEXT.dim`.
- Kind colours are a bonus, not the only carrier of kind: the flicker itself says "a tool ran", and the spotlight's
  tools row gives each kind a letter. Under colour-vision deficiency some kind pairs come close (edit and search
  2.0 apart under deuteranopia); that is accepted for this reason.

## 4. Status encoding

Every status has a glyph, a fill and a motion. The glyph is in the node's label, the tree, the timeline and the
spotlight. In greyscale the glyphs `▶ ◌ ✓ ✕ ?` and the trailing `!` are all different shapes.

| Status | Node fill | Glyph (colour) | Label colour | Motion |
|---|---|---|---|---|
| running | Model colour, lit core (centre mixed toward white by up to 28%, 4 steps) | `▶` (`STATUS.running`) | `TEXT.primary` | Glow halo breathes: at distance `d` past the node edge, light `0.8 × q5(1 - (d - r) / (ringPx + glowPx)) × q5(0.45 + 0.55 × glow)` of the fill, linear falloff, period `glowPeriodMs`, phase offset per agent |
| waiting | Model colour × 0.72 (e.g. opus `#3766b8`, 3.43:1) | `◌` (`STATUS.waiting`) | `TEXT.dim` | None |
| done | Fades linearly over `ghostMs` to `mix(desaturate(model, 0.7), CANVAS, 0.55)`, 6 steps. Ghost contrast 2.0-3.5:1: still visible, clearly out of play | `✓` (`STATUS.done`) | `TEXT.dim` | The fade, then still |
| failed | `STATUS.failed`, stays | `✕` (`STATUS.failed`) | `STATUS.failed` | A red rim pulse (`errorPulseMs`) for the failed tool call, if one came first; then still. Red but still is how failed differs from a live error pulse |
| stuck (3 failed tools in a row) | As its status | Status glyph, then ` !` after the name (`STATUS.warn`) | As its status | Amber rim breathes on the glow period: rim strength `q4(0.3 + 0.6 × glow)` |
| placeholder (a name nobody had) | `TEXT.faint`, radius `GRAPH.minRadius`, no ring, no glow | `?` (`STATUS.waiting`) | `TEXT.dim`, name shown as `?name` in the feed | None |

`q5(x)` and `q4(x)` mean `quantise(x, 5)` and `quantise(x, 4)`.

**The lead.** The lead's label starts with `◆` in `ACCENT` instead of a status glyph, and **its status glyph follows
the name**: `◆ lead ▶`. Without that, a failed lead would be shown by red alone. (Task 11's `labels()` puts the
status glyph after the name for the lead, coloured as for any agent, with a space before it.)

**Context ring** (radius ≥ 2.2 only): an arc clockwise from 12 o'clock, its length the context fill, in
`contextColor(fill)` (`TEXT.dim` below 70%, `STATUS.warn` from 70%, `STATUS.failed` from 90%). The unfilled part is a
faint track, `mix(CANVAS, TEXT.faint, 0.35)` (`#272d39`), so a near-empty context doesn't draw a grey frame round
every node. Arc length carries the amount, so the threshold colour is never the only carrier;
the spotlight prints the percentage.

**Tool flicker** (`pulseMs`): **one ring only**, the pixel band just outside the context ring
(`r + ringPx < d ≤ r + ringPx + 1`), set to `mix(under, KIND[kind], 0.85 × q3(flash))`. The disc itself is not
recoloured, and the colour is mixed in, not added, so the hue stays true over a glowing halo. It sits on the canvas,
so an edit (amber) on a haiku (yellow) node still shows.

**Coalescing.** Per agent, a tool start less than **600 ms** after the last one that flickered is skipped: no
restart, no second flicker. A burst of parallel calls reads as one flicker, and one agent flickers at most about
1.7 times a second.

*Why (live check, 2026-10-22):* the first version recoloured the disc's edge **and** added a flare outside the ring.
With the dark ring track between them, every flicker drew three concentric bands (a target), and adding pink over
the blue halo turned it lavender. Replaying the recorded run (5 agents, 112 tool events) showed the rate was never
the problem (median gap per agent about 7 s); the shape and colour were.

**Error pulse** (`errorPulseMs`): the same single ring in `STATUS.failed`, never coalesced or skipped. Of several live pulses on one node the
strongest wins; a clash blink beats both.

## 5. Glyphs

Every glyph is one code point, printable, width 1, in the BMP, and passes `safeGlyph`. None has default emoji
presentation and none is East Asian Wide. Some are East Asian **Ambiguous** (A): narrow everywhere except terminals
set to treat ambiguous characters as wide (some CJK locales), where Claude Code's own UI and RuFlo's would
misalign too.

| Glyph | Code point | Width class | Use |
|---|---|---|---|
| `▶` | U+25B6 | A | Running. Has the emoji property with text default; Task 2 to confirm it draws as text, else fall back to `▸` U+25B8 |
| `◌` | U+25CC | N | Waiting |
| `✓` | U+2713 | N | Done |
| `✕` | U+2715 | N | Failed; the end of a failed timeline bar |
| `◆` | U+25C6 | A | The lead |
| `?` | U+003F | Na | Placeholder |
| `!` | U+0021 | Na | Stuck (after a label), clash (before a path) |
| `⚠` | U+26A0 | N | Log gaps. Emoji property, text default; Task 2 to confirm it draws narrow, else fall back to `▲` U+25B2 |
| `●` | U+25CF | A | Chip and spotlight model dot |
| `◉` | U+25C9 | A | Pinned chip |
| `•` `›` `+` `#` | U+2022, U+203A, U+002B, U+0023 | A, N, Na, Na | Feed marks |
| `▀` | U+2580 | A | Half block: two vertical pixels a cell, upper = fg, lower = bg |
| `⠀`-`⣿` | U+2800-U+28FF | N | Braille: 2×4 dots a cell, for structural edges, message arcs, comets, the clash dashes |
| `▁▂▃▄▅▆▇█` | U+2581-U+2588 | A | Sparklines (8 heights) and full timeline cells |
| `▅` | U+2585 | A | Timeline bars (five-eighths high, so rows stay apart) |
| `░` | U+2591 | A | Empty part of the context bar |
| `─` `└` | U+2500, U+2514 | A | Timeline axis |
| `→` `↓` `↑` `≈` `·` `…` `–` | U+2192, U+2193, U+2191, U+2248, U+00B7, U+2026, U+2013 | A | Text punctuation |

**Pixels.** The graph is a canvas of pixels one cell wide and half a cell tall, so with a typical 1:2 cell a pixel is
about square. A cell shows its two pixels as `▀` with the upper pixel as foreground and the lower as background; a
cell whose two pixels match is a space on that background (one fewer pair). Braille dots are drawn over the pixel
layer: the dot colour becomes the cell's foreground and the cell keeps its lower pixel colour as background.

## 6. Motion

| Value | What it shows | Easing | Steps |
|---|---|---|---|
| `fadeInMs` 600 | An agent has just started | ease-out cubic, `mix(CANVAS, fill, t)` | 8 |
| `ghostMs` 1500 | An agent has just finished | linear | 6 |
| `glowPeriodMs` 2000 | The agent is working | sine, phase `hashUnit(id)` so neighbours breathe out of step | 5 |
| `cometMs` 900 | A message is travelling | ease-in-out along the link's arc; the same time for any link length, so every message reads as one beat | head 1 + trail 4 |
| `trailMs` 450 / `trailDots` 6 | Which way the message went | trail dot *i* has strength `1 - i/7`, colour `mix(CANVAS, LINK.active, q4(k))` | 4 |
| `linkFadeMs` 3000 | Which links carried traffic recently | linear, `mix(LINK.idle, LINK.active, recency)` | 5 |
| `pulseMs` 450 | A tool call started | linear decay | 3 |
| `errorPulseMs` 900 | A tool call failed | linear decay | 4 |
| `clashFlashMs` 4000 / `clashBlinkMs` 400 | Two agents edited the same file | square wave, rims at 0.9 strength on, off on the other half-period | 2 |
| `tweenMs` 400 | The layout changed (an agent arrived) | ease-out cubic from old to new positions | continuous |

The comet head is two braille dots side by side in `LINK.comet` with `light(LINK.active, 0.35)` on the pixel under
it, so the head glows. Draw every trail first and every head last, so a head is never painted over.

Comets and pulses are drawn at `tEff = now - lag` (lag capped at 1 s): events arrive in batches every `PULL_MS`, and
drawing them at their own time keeps a comet starting at its sender instead of jumping in half-way.

**Frame rate policy** (`targetFps`, Task 12). Measured by the lead: a 120×44 frame costs about 25 ms of Claude
Code's main thread, so 12 fps of breathing alone took about 30% of it. Spec section 11 says the pane never slows the
session, so frame rate follows a **budget: the pane may spend at most 10% of the main thread, averaged over a
second** (100 ms of render a second), as well as the motion's needs.

The slowest rate each motion still reads at, and why:

| Motion | Needs | Rate |
|---|---|---|
| Comet (900 ms) and its trail | Each frame moves the head about one trail gap (1/12 of the arc), so the eye joins the dots into travel. Below 4 fps it reads as jumping | `FPS.busy` 20; floor 4 |
| Tool and error pulses (350 / 900 ms, 4 steps) | At least one frame at full strength and one part-faded | `FPS.busy` 20 (7 frames a pulse); floor: a single full-strength frame |
| Fade-in (600 ms, 8 steps) | Most of its 8 steps | `FPS.busy` 20 |
| Glide (400 ms) | 6 or more positions | `FPS.busy` 20 |
| Glow and stuck rim (2000 ms, 5 and 4 steps) | 8 level changes a breath; 10 frames cover them | `FPS.glow` 5 |
| Ghost fade (1500 ms, 6 steps) | One frame a step | `FPS.glow` 5 |
| Link fade (3000 ms, 5 steps) | One frame a step | `FPS.glow` 5 (the tick would also do) |
| Clash blink (400 ms half-period) | Two frames each half | `FPS.glow` 5 |

1. `FPS.busy` (20) while any comet, fade-in, pulse or glide is live. These come in bursts of about 1.4 s.
2. Otherwise `FPS.glow` (5) while any glow, stuck rim, ghost fade, link fade or clash blink is live.
3. Otherwise **`FPS.tick` (1) while the pane is shown**: feed ages, a waiting agent's live timeline bar and the
   header's burn rate change with the clock, not with events. The loop stops when the pane is hidden, closed or off
   the terminal.
4. **Budget cap.** Each frame's interval is at least `10 × renderMs` of the frame before (so at 25 ms a frame the pane
   runs at 4 fps at most; at 5 ms, the full 20). This replaces the 60% back-off: it is the same idea with a fixed
   share. If a frame comes in under the cap, the interval falls back to the target rate.
5. **Graceful degradation.** When the cap leaves fewer frames than a motion needs, drop motions in this order,
   least meaningful first, and give each back in reverse order as frames become cheap again:
   1. **Breathing.** Glow halos are drawn steady at `glowK = 0.7`, and stuck rims steady at strength 0.6. Running is
      still the halo plus `▶`; stuck is still the amber rim plus `!`. Applies when the cap is under `FPS.glow` (5).
   2. **Slow fades.** Ghost fades and link fades jump to their end state; a link stays lit until the next tick
      after its fade window ends, then goes. Applies when the cap is under 5.
   3. **Clash blink.** Both rims are drawn steady in `LINK.clash` for `clashFlashMs`; the dashed line is unchanged.
      Applies when the cap is under 5.
   4. **Fade-in and glide.** New nodes appear at full colour; layout changes jump. Applies when the cap is under 10.
   5. **Pulses.** A tool or error pulse becomes one full-strength frame, held until the next frame. Never dropped
      entirely: a pulse is the only sign a tool ran. Applies when the cap is under 10.
   6. **Comets, last.** Under `FPS.min` (4) a comet can't read as travel, so instead the link flashes to
      `LINK.active` at once and decays by its link fade (at tick rate if need be). Direction is then shown by the
      feed line, not the picture.
   Every status stays readable at every step, because the glyph never depends on motion (section 4).
6. The budget and the degradation step are worked out each frame from the last frame's `renderMs`, so a cheaper
   frame (blitting only the grids that changed, a cached graph layer) buys the motion back with no other change.

## 7. Layouts per topology

Legend for the sketches: `(A)` a node, `◆` the lead, `.` a structural edge (faint dotted braille, `TEXT.faint`
mixed 90% over the canvas, dash 2), `~` a message arc, `*` a comet head with `-` its trail, `x x x` a clash line.

**Hierarchical: a tree.** Lead centred at the top, one layer per depth, layers evenly spaced down the graph, nodes
in a layer spread evenly across it in start order. Structural edges go parent to child, straight.

```
                              ◆ lead ▶
                               (L)
                  .  .  .  .  .  .  .  .  .  .
            (A)                (T)                (R)
       ▶ architect           ▶ tester ! ~~~~~*--  ✕ reviewer
         .       .
      (C1)        (C2)
   ▶ coder-1 x x x ✓ coder-2
```

**Mesh: a ring.** Lead at 12 o'clock, the rest clockwise in start order, equally spaced, on an ellipse inside
`MARGIN`. **No structural edges:** in a mesh anyone may message anyone, and faint ring lines would suggest a ring
topology that isn't there. The message arcs are the shape.

```
                    ◆ lead ▶
                     (L)
           (R)    ~~~~~~~~*--  (A)
         ✕ reviewer        ▶ architect
              ~                 ~
          (T)                    (C1)
        ▶ tester  ~~~~~~~~~~~  ▶ coder-1
```

**Star: hub and spokes.** Lead in the centre, the rest on a ring around it as for mesh. Structural edges are the
spokes, lead to each agent.

```
              (A)            (C1)
                 .          .
         (R) . . . ◆ (L) . . . (C2)
                 .          .
              (T)            (?ghost)
```

**Node size in a crowd.** A node's radius is capped at 0.4 times the gap to its nearest neighbour (never
below `minRadius`, never above `maxRadius` or a seventh of the graph height), so dense layers shrink and roomy ones
keep full-size nodes. It is also capped by edge room: the node and its ring stay inside the canvas at the top,
bottom and sides, and the label row sits below the ring rather than over it.

**Links over every layout.**
- Structural edges (tree: parent to child; star: the spokes; mesh: none) are always straight and dotted (dash 2)
  in `mix(CANVAS, TEXT.faint, 0.6)` (`#3c4352`, 1.93:1): the quietest line in the graph, and stop one pixel short of
  each node's edge.
- A message link is a quadratic arc bowed `linkBend` (0.18) of its length to the left of travel, raised up to
  `linkBendMax` (0.5) until its peak clears every node between its ends (radius + ring + 1 px). A→B and B→A
  curve opposite ways, so both show. A link never lies on its parent edge, and a same-row link arcs over the
  nodes between.
- **A quiet link (fewer than `linkThick[0]` messages) is drawn only while it is recent:** `mix(CANVAS, LINK.active,
  recency)`, fading to nothing over `linkFadeMs`. Only the links that just carried a message show, each with its
  comet. At the first review the fixture drew 8 arcs and 5 edges across 7 nodes at once; this leaves 3 arcs, all live.
- A busy link (`linkThick[0]` or more) stays drawn: `mix(LINK.idle, LINK.active, recency)`, brightening when a
  message passes and decaying back to `LINK.idle` over `linkFadeMs`.
- At `linkThick[0]` (5) messages it gets a second arc `busyArcOffset` (0.04) further out. At `linkThick[1]` (20) it also gets a soft pixel
  arc beneath (pixels blended 45% toward the link colour), so busy links read as thicker.
- Comets run along the arc with the trail behind.
- A file clash draws a dashed braille line (dash 3) in `LINK.clash` between the agents involved, for as long as the
  clash is live, and blinks both nodes' rims for `clashFlashMs` after the latest clashing edit.

**Labels.** One row below each node: the status glyph, a space, the name clipped to 12 characters, then ` !` if
stuck (and ` ▶`-style trailing status for the lead, section 4). If the label would overlap another, fall back to the
glyph alone (keeping the marks: `◆` before the lead's glyph, `!` after a stuck agent's); if that overlaps too, skip it (the chips and spotlight still name everyone). A label needs its span
**plus one cell either side** clear of other labels and of cells holding node pixels; braille dots inside that padded
span are cleared to a space (the cell keeps its background), so a label never runs into a line or a node.

**Legibility guard.** If the closest two node centres are under 8 px apart (`2 × (minRadius + ringPx) + 2`, rounded
up), nodes and halos overlap and the picture lies. The graph area then shows the indented tree (as in the tree step)
instead of the graph; the chips and spotlight stay. At the first review this fired in the 80×21 case, where the three
tree layers had only 5 px between them.

## 8. Size steps

The pane picks a step from its body size; regions are in rows. The chip row is one terminal row between the two
grids. Row budgets are what Task 6's `planRegions` produces.

| Step | Threshold sample | Top grid | Chips | Bottom grid |
|---|---|---|---|---|
| full | 120×44 | 26: header 2, graph 24 | 1 | 17: spotlight 6, timeline 7, feed 4 |
| noTimeline | 100×29 (rows < 30) | 18: header 2, graph 16 | 1 | 10: spotlight 6, feed 4 |
| compactSpotlight | 80×21 (rows < 22) | 14: header 2, graph 12 | 1 | 6: spotlight 1, feed 5 |
| tree | 60×13 (rows < 14 or columns < 48) | 13: header 1, tree 12 | — | — |
| summary | 40×5 (rows < 6 or columns < 30) | 1: summary | — | — |

**full, 120×44:**
```
row  0 ▕◆ auth refactor · hierarchical · 6 agents 4▶ · ≈$1.31+ · 248k tok · ≈$0.08/min · ctx 34% · cc $1.20     ⚠ 2 gaps▏ RAISED
row  1 ▕tasks 0 pending · 1 active · 1 done · 0 failed · memory 1 · ! 1 clash          move sessions to signed tokens▏ RAISED
rows 2-25   graph, 24 rows = 48 px tall, 120 px wide (section 7)                                                        CANVAS
chips      [ ● lead ]  [ ● architect ]  [ ◉ coder-1 ]  [ ● coder-2 ]  [ ● tester ]  [ ● reviewer ]                     terminal
row  0 ▕● coder-1 · coder · claude-sonnet-5-5                                                       ▶ running · 25s▏ RAISED
row  1 ▕tokens in 7k  out 3.7k  cache r 48k w 8k  = 67k                                                       ≈$0.12▏ RAISED
row  2 ▕context ██████░░░░ 6%  cache hit 71%                                                                         ▏ RAISED
row  3 ▕speed ≈ 42 tok/s ▁▂▃▅▇█▅▃▂▁▁▂▃▅▆█  tokens ▁▁▂▃▃▅▅▆▇▇█████                                                 ▏ RAISED
row  4 ▕tools r 0  e 2  b 0  s 0  w 0  a 0  o 0   errors 0                                                           ▏ RAISED
row  5 ▕files 2  src/auth/token.ts, src/auth/issuer.ts                          msgs ↓2 ↑1  ! clash src/auth/token.ts▏ RAISED
row  6  ◆ lead       ████████████████████████████████████████████████████████████████████████████████████████████▉
row  7  ▶ architect    ███████████████████████████████████████████████████████████████████████████████████████████
rows 8-11 one row per agent (coder-1, coder-2 ✓, tester, reviewer ✕ ... ✕)
row 12  …          └──0s──────────────────────────────────────────────────────────────────────────────────────30s
rows 13-16 feed:   0s # task t2 → done
                   0s › architect → ?ghost: are you there
                   0s › lead → tester: rerun with a fixed seed
                   0s › architect → coder-1: use ed25519 keys
```

**noTimeline, 100×29:** the same header, graph 16 rows (32 px), chips, the 6-row card, then 4 feed rows.

**compactSpotlight, 80×21:** header 2, graph 12 rows (24 px; node radius capped at 24 ÷ 7 ≈ 3.4), chips, then:
```
row 0 ▕● coder-1 ▶ running · 25s · 67k tok · ≈$0.12 · ctx 6%            ▏ RAISED
rows 1-5  feed, 5 rows
```

**tree, 60×13:**
```
row  0 ▕◆ auth refactor · 6 agents 4▶ · ≈$1.31+ · ctx 34%               ▏ RAISED (header, 1 row)
row  1  ◌ lead  41k tok · ≈$0.31
row  2    ▶ architect  52k tok · ≈$0.42
row  3      ▶ coder-1  67k tok · ≈$0.12
row  4      ✓ coder-2  39k tok · ≈$0.07
row  5    ▶ tester  6k tok · ≈$0.01
row  6    ✕ reviewer  1.3k tok · –
row  7  ? ghost  – tok · –
```
Indent 2 cells per depth, at most 8 levels. Status glyph in its status colour, name in its model colour (failed:
`STATUS.failed`, placeholder: `TEXT.dim`), figures in `TEXT.dim`. When rows run out, the last row says `… n more`.

**summary, 40×5:** one `CANVAS_RAISED` row, the rest of the pane empty (the engine draws nothing below a 1-row Raster):
```
▕ ◆ auth refactor · 6 agents 4▶ · ≈$1.3…▏
```
`⚠ n` is written over the right end when there are gaps.

Above 512 columns or 256 rows per grid, each grid is held to the Raster limits and the extra space stays empty.

## 9. Spotlight card, timeline, feed, header, chips

**Header** (`CANVAS_RAISED`, 2 rows; Task 8's layout holds):
- Row 0, in this order: `◆` in `ACCENT`, swarm name `TEXT.primary`, topology `TEXT.dim`, `n agents` `TEXT.primary`
  then `k▶` in `STATUS.running` (`TEXT.dim` when k is 0), cost `TEXT.primary` (`+` when some agents have no price),
  `ctx` in `TEXT.dim` with the percentage in `contextColor`, then tokens and burn in `TEXT.dim`, `cc $x.xx` (Claude
  Code's own session cost) in `TEXT.dim`, `ended` in `TEXT.dim` when it ended. Right-aligned: `⚠ n gaps` in
  `STATUS.warn`. Context comes before tokens because it is the figure to keep when the row runs out of room.
- On a 1-row header (tree step) the topology is left out so `ctx` fits (`◆ auth refactor · 6 agents 4▶ · ≈$0.57+ · ctx 34%` at 60×13).
- **Parts are whole or absent.** Each ` · value` group is drawn only if all of it fits before the right-aligned
  notes; the row stops at the first group that doesn't. A cut figure (`cc $1.2` for `$1.20`) reads as a different
  number. The same holds for the summary line.
- Row 1: `tasks` `TEXT.dim`; the counts in `TEXT.primary`, except active > 0 in `STATUS.running` and failed > 0 in
  `STATUS.failed`; `memory n` `TEXT.dim`; `! n clash(es)` in `STATUS.failed`. Right-aligned, in priority order:
  1. the degraded note, `⚠ Swarm too large to draw (n agents)` or `⚠ Waiting for the swarm…`, in `STATUS.warn`;
  2. `+n finished` (finished agents left out of the graph) in `TEXT.dim`;
  3. the goal in `TEXT.dim`, only if all of it or at least 12 cells of it fit (clipped at its end with `…`), else
     left out.
  Notes are joined with ` · ` in `TEXT.faint`.
- With a 1-row header (tree step) and on the summary line, the degraded note is drawn right-aligned on that row in
  `STATUS.warn` as `⚠ too large` or `⚠ waiting`, before the gaps marker; `+n finished` and the goal are left out.
- Separators ` · ` in `TEXT.faint`.

**Spotlight card** (full: 6 rows on `CANVAS_RAISED`, left text from column 1, right text ending one column from the edge):
- Row 0: `●` in the model colour, name `TEXT.primary`, ` · role` `TEXT.dim`, ` · model` in the model colour. Right:
  status glyph and word in the status colour, ` · ` and lifetime in `TEXT.dim`.
- Row 1: `tokens` and each label (`in`, `out`, `cache r`, `w`, `=`) in `TEXT.dim`, each figure `TEXT.primary`.
  Right: `≈$x.xx` `TEXT.primary`, or `–` in `TEXT.dim` for an unknown model.
- Row 2: `context` `TEXT.dim`, a 10-cell bar: filled `█` in `contextColor(fill)`, empty `░` in `TEXT.faint`, then the
  percentage in `contextColor(fill)`; `cache hit` `TEXT.dim` and its percentage `TEXT.primary`.
- Row 3: `speed ≈` `TEXT.dim`, the 30 s average and `tok/s` `TEXT.primary`, a 16-cell sparkline; `tokens`
  `TEXT.dim` and a 16-cell sparkline. Both sparklines are in the model colour; a zero sample draws `▁` in
  `TEXT.faint`. One colour per sparkline, no ramp (that saves pairs).
- Row 4: `tools` `TEXT.dim`, then for each kind its letter (`r e b s w a o`) in its `KIND` colour and its count in
  `TEXT.primary` (`TEXT.dim` when 0); `errors` `TEXT.dim` and the count in `STATUS.failed` when > 0, else `TEXT.dim`;
  then `! stuck` in `STATUS.warn` when stuck.
- Row 5: `files` `TEXT.dim`, the count `TEXT.primary`, the paths `TEXT.dim` clipped with `…`. Right: `msgs ↓in ↑out`
  in `TEXT.dim`, then `! clash <path>` in `STATUS.failed` when this agent is in a live clash.
- Compact (1 row): `● name ▶ running · 25s · 67k tok · ≈$0.12 · ctx 6%`, colours as above.
- No agents yet: `No agents yet.` in `TEXT.dim` on `CANVAS_RAISED`.

**Timeline** (on `CANVAS`, Task 8's layout holds): one row per non-placeholder agent in drawing order, then the axis.
The label column is up to 14 cells: status glyph in its status colour, name in `TEXT.dim`. Bars run from the start
to the finish (or now) on a shared scale, every cell `▅`, the end rounded to the nearest cell (at least one cell).
Each bar has a status colour: running = model colour; waiting = model × 0.72; done =
`mix(desaturate(model, 0.6), CANVAS, 0.45)`; failed = `STATUS.failed`. The **body** is drawn at
`mix(CANVAS, colour, 0.6)` (2.6-5.7:1) and the **last cell** at the full colour; a running bar's last cell is
brightened further (`mix(c, #ffffff, 0.35)`) as the live edge. A failed bar gets a `✕` in `STATUS.failed` in the cell
after it. A quiet body with a bright end keeps the timeline under the graph in weight: at the first review, full-height
saturated blocks made it the heaviest thing on screen. Axis
`└───` in `TEXT.faint`; `0s` and the span in `TEXT.dim`. Overflow: `… +n` in the label column of the axis row.

**Feed** (on `CANVAS`, newest first, one event a row): age right-aligned in 4 cells in **`TEXT.dim`**, a space, the
mark in its `FEED_COLOR`, a space, then:
- message: `from` `TEXT.primary`, ` → ` `TEXT.faint`, `to` `TEXT.primary`, `: ` `TEXT.faint`, summary
  `FEED_COLOR.message`;
- anything else: the text in its `FEED_COLOR`.
Clipped at the right edge with `…`.

**Chips** (terminal theme, one row): one Button per agent in drawing order, as many as fit (label width + 4 each, gap
2), then `+n` dim. Child: the dot (`●`, or `◉` when pinned) in the theme-neutral model colour (section 2), then a space
and the label (name clipped to 14) in the terminal's default text colour. The pinned chip is also `variant: 'primary'`.
Pinned is therefore shown three ways: `◉`, the primary style, and the spotlight staying put.

## 10. Pair budget and the Svg surface

A Raster paints at most 1024 distinct fg/bg pairs at once and snaps the rest to the nearest (spec section 10, from the
docs; not yet measured). Each grid has a budget, `PAIR_BUDGET.top` 700 and `.bottom` 300, and every ramp is
quantised to a few fixed steps so a frame stays under it:

| Ramp | Steps |
|---|---|
| Fade-in | 8 |
| Ghost | 6 |
| Glow halo (per frame, per node) | 5 |
| Link recency | 5 |
| Node core shading, tool and error rims, stuck rim, comet trail | 4 |
| Clash blink | 2 (on/off) |

**Measured in the goldens** (first review): top grid 72-152 pairs (full-mid 136, no-timeline-mid 152), bottom grid
11-29. That is well under 700 and 300, and under my earlier estimate of 230-300 and 50. `limitPairs` stays in as the
safety net. If Task 2
finds the palette smaller than 1024, cut the glow to 4 steps first, then fade-in to 6.

**Svg (desktop).** Where the surface offers `Svg` instead of `Raster`, the same two grids become a static SVG
redrawn on each render. Each cell is a background rect plus its glyph in a monospace font. `▀` becomes two
half-height rects, braille becomes small circles at the dot positions. `alt` is the one-line summary. There is no
motion on that surface, which is why every status must read from its glyph alone (section 4): a running node there
is a still model-coloured disc with `▶`, a ghost is a dim disc with `✓`.

## 11. Accessibility checklist (Task 13 reviews against this)

Measured on the token values in section 3:
- [x] Text tokens ≥ 4.5:1 on `CANVAS`: `TEXT.primary` 16.23, `TEXT.dim` 7.61, every `MODEL.*` 5.31-14.50, every
  `STATUS.*` 5.72-12.48, every `FEED_COLOR.*` 7.61-11.36, `ACCENT` 7.43.
- [x] Signal colours ≥ 3:1 on `CANVAS`: every `KIND.*` 6.78-13.77, `TEXT.faint` 3.32, `LINK.active` 11.36,
  `LINK.clash` 5.72.
- [x] Model colours apart under colour-vision deficiency: minimum OKLab ×100 is 12.0 (protanopia), 12.0
  (deuteranopia), 10.9 (tritanopia), 16.5 (normal).
- [x] Status colours: failed vs warn 9.6 under deuteranopia; running vs failed 16.4. Waiting and done are close in
  colour (4.0) by design; their glyphs `◌` and `✓` tell them apart.
- [x] Theme-neutral chip dots ≥ 3.2:1 on black, white, Campbell, VS Code dark and Solarized dark and light.

To check on the goldens (Task 13):
- [ ] Every status reads in greyscale from its glyph: `▶ ◌ ✓ ✕ ?` and the trailing `!` on every node label (or the
      glyph-only fallback), in the tree and in the timeline.
- [ ] The lead's label carries its status glyph after the name.
- [ ] No information text is drawn in `TEXT.faint`, and the feed ages are `TEXT.dim`.
- [ ] No cell inside either Raster uses the terminal default colour.
- [ ] Every glyph in the goldens is in section 5's table, or is a text character from untrusted input (which has
      passed `safeGlyph`).
- [ ] `pairCount` ≤ `PAIR_BUDGET` for every golden case, and the printed counts are within the section 10 estimate.
- [ ] No blink is faster than 3 a second (`clashBlinkMs` ≥ 167).
- [ ] The pane's render time × frame rate stays at or under 100 ms a second (10% of the main thread) in every state.
- [ ] Nothing moves in the `idle` golden except what section 6 allows (glow for a running agent, the tick).
- [ ] A comet head is visible in the `mid` golden and no comet in `idle`.
- [ ] Tool flicker on a same-hue node (edit on haiku) shows in the outer flare.
- [ ] A tool flicker is one ring outside the context ring; the disc keeps its colour and shape during it.
- [ ] Task 2 confirms `▶` and `⚠` draw as narrow text in Windows Terminal; otherwise swap to `▸` and `▲`.
- [ ] Every node label has a clear cell either side: no braille dot or node pixel touches a label.
- [ ] No two node discs or halos overlap; where they would, the graph area shows the tree (legibility guard).
- [ ] No header figure is cut part-way (`cc $1.2`); the goal shows whole, or at least 12 cells of it, or not at all.
- [ ] A degraded read shows `⚠` and its note in `STATUS.warn`, not in dim text alone.
- [ ] Timeline bars are `▅` with a quiet body and a full-colour end; the timeline weighs less than the graph.

## 12. Robot node style

An alternative look for nodes: each agent is drawn as a small pixel robot instead of a globe. The robot's pixels
come from a swappable **skin** (12.4); for now the only skin is `clawd`, after the Claude Code mascot (block body, two
dark eyes, short arms, four stubby legs). Everything else in the graph stays as it is:
layout, links, comets, clashes, labels, the frame budget.

**What was checked and how.** The bitmaps below come from a throwaway preview script that draws them on a `Pixels`
canvas with the rules in this section and writes PNGs (one canvas pixel = 8×8 image pixels, so a cell is 8×16).
I looked at every size × state render and changed the sprites until each state read clearly; two first attempts
failed and are noted below. The colour figures use the same WCAG and Machado/OKLab method as section 3.
**Not checked:** a real terminal, render time, or pair counts in a golden frame.

### 12.1 Switch

- One pane-wide setting, `pane.style`: `globe` (default) or `robot`, set with `/omnis pane style robot|globe`.
  The whole graph uses one style; there are never globes and robots in one swarm.
- The tree, timeline, spotlight, chips and labels don't change. Svg (desktop) draws the still frame (12.6).

### 12.2 Colour: skin-coloured body, model in the glow and the bar

Rob chose a fixed body colour (2026-10-22). Every robot's body is its **skin's `bodyColor`** (`clawd`: terracotta
`#d77757`, 6.09:1 on `CANVAS`), so the robots read as one family. Status changes the body's tone and shape, and the
**model colour moves to the two places that already exist round the robot: the glow and the context bar** under its
feet.

| State | Body | Eyes (colour) | Glow | Bar (12.4) |
|---|---|---|---|---|
| running | `bodyColor` | `CANVAS` | model colour, breathing (as a globe's halo) | model tone |
| waiting | `scale(bodyColor, 0.72)` (`#9b563f`, 3.47:1) | `CANVAS` | none | model × 0.72 |
| done | ghost of `bodyColor`: `mix(bodyColor, mix(desaturate(bodyColor, 0.7), CANVAS, 0.55), q6(ghost))` (`#504646` at the end, 2.11:1) | `CANVAS` | none | model ghosted the same way |
| failed | **`ROBOT.dead` `#2a2e36`** (a dead robot), held | **`STATUS.failed`** | `STATUS.failed`, steady at `glowK` 0.7 (no breathing) | model tone |
| error flash | unchanged | `CANVAS` | `STATUS.failed` at full strength on the red steps (12.5), with a red outline | unchanged |
| placeholder | `TEXT.faint` | `CANVAS` | none | none |

Everything fades in from the canvas as globes do (`mix(CANVAS, c, q8(fadeIn))` on body, glow and bar).

**Why error and failed never use red on the body.** Terracotta against `STATUS.failed` is OKLab ×100 **1.9 under
deuteranopia** (5.1 protanopia), and red ✕ eyes on terracotta are 1.06:1. A red body flash or red eyes on a live
robot would be invisible to a deuteranope. So:
- failed changes the **body** to dark grey, a lightness change that every viewer sees, and puts the red on the eyes
  (4.06:1 on `ROBOT.dead`) and the glow;
- an error flash keeps the body, flashes the **glow and outline** red, and switches to the hurt eyes in `CANVAS`.

**Eye rule (every skin):** eye pixels must reach 3:1 against the body under them. `CANVAS` on terracotta 6.09,
on waiting terracotta 3.47; `STATUS.failed` on `ROBOT.dead` 4.06. On the done ghost they are 2.11 by design (faint,
out of play).

**What carries each distinction** (OKLab ×100; normal / protanopia / deuteranopia / tritanopia; about 2 is just
noticeable, 10 or more clearly different):

| Pair | Carried by | Distance |
|---|---|---|
| failed vs running | body: dead grey vs terracotta | 39.5 / 32.1 / 39.5 / 41.4 |
| failed vs waiting | body: dead vs terracotta × 0.72 | 25.3 / 19.4 / 25.2 / 27.0 |
| failed vs done | body: dead vs terracotta ghost | 10.7 / 9.7 / 10.8 / 10.9 |
| failed vs any (eyes) | red eyes vs dark eyes | 54.1 / 39.9 / 53.0 / 54.1 |
| error vs running: glow | red glow vs model glow, worst model per vision | fable 21.5 normal; other 10.8 protanopia; **sonnet 9.3 deuteranopia**; fable 21.6 tritanopia |
| waiting vs running | body tone | 14.4 / 12.8 / 14.5 / 14.7 |
| done vs waiting | body tone (and closed eyes) | 15.1 / 10.0 / 14.6 / 16.7 |

Every pair also differs by shape or motion: failed has the hurt eyes (except S, see 12.4); error has the hurt eyes
for 900 ms and two flashes; done has closed eyes; running hops. The weakest colour pair is the error glow on a sonnet
robot under deuteranopia (9.3); the hurt eyes and the flashing carry it there. A first dead grey, `#4b5160`, was
only 4.2-4.9 from the done ghost and gave red eyes 2.37:1, so it was rejected. The chosen grey is only 1.41:1 on the
canvas by itself, but a failed robot always has its steady red glow, which draws the edge.

**The chip-dot key.** Chips still show the theme-neutral model dot (section 2). That dot now keys to the glow and
the bar instead of a disc. Checked in `models-M.png`: each dot sits over robots whose glow and bar are the same
hue. The key is weaker than before. A running robot shows the model in a 1-3 px halo plus the bar, but a waiting or
done robot shows it only in the 1 px bar, dimmed (and nearly gone once ghosted). The spotlight's `●` and model name,
and the timeline bars, are unchanged and stay the full key.

### 12.3 Sizes (shared by every skin)

Three size steps. The **box** is what the robot owns: hop headroom on top, the sprite, then one row for the context
bar (12.4). The sprite sits at the bottom of its box; hopping moves it up into the headroom, so the
box (and the label under it) never moves. These values belong to the robot style, not to a skin:

| Size | Radius `r` | Headroom (= highest lift, 12.5) | Gauge row | Halo `rLo` / `rHi` | Sprite limit (w×h) |
|---|---|---|---|---|---|
| S | `r < 2.8` (under about 20k tokens) | 1 | yes | 1.6 / 2.8 | 8×5 |
| M | `2.8 ≤ r < 4.0` (about 20k-460k) | 2 | yes | 2.8 / 4.0 | 11×6 |
| L | `r ≥ 4.0` (about 460k and up) | 2 | yes | 4.0 / 6.0 | 13×7 |

A skin's sprite at each size may be smaller than the limit, never larger, so the size rule and the layout never
depend on which skin is on. Box = sprite width × (headroom + sprite height + 1 bar row). With the `clawd` skin the
boxes are **8×7, 11×9 and 13×10**. S now has a bar too, because the bar is where a waiting or done robot shows its
model. The M and L limits are a little wider than the brief's 12×10 guess: a ✕ eye needs
3×3 pixels, and two of them need a gap between and a margin outside. A 13-wide L is still inside a maximum globe's
footprint (`2 × (6 + ringPx)` = 14.4 px).

**Bucket rule.**
1. Work out `r` exactly as for a globe (`nodeRadius(tokens, min(maxR, room))`, placeholders `minRadius`) and take its
   size from the table. The radius cap already shrinks crowded graphs, so crowded robots step down too.
2. **Graph-wide fit.** Find the largest size at which no two nodes' boxes, each grown by 1 px on every side, overlap.
   No node is drawn bigger than that size. If even S boxes overlap, the legibility guard (section 7) shows the tree.
3. **Edge fit.** Per node, step down while the box would leave the canvas (top < 0, left < 0, right ≥ width, or
   bottom > `height - 3`, which keeps the label row on the grid).

**Placement.** `left = round(p.x - w / 2)`, `top = round(p.y - H / 2)` for a box of `w × H`. Label row:
`floor((top + H - 1) / 2) + 1`. For label clearance, the solid cells are every cell the box touches (as
`solidCells` does for a disc and its ring).

**Token weight in the glow.** Inside a size the halo width follows `r`: `wH = 1 + round(2 × clamp01((r - rLo) /
(rHi - rLo)))`, so 1-3 px. A heavier agent glows wider. Waiting and done agents have no glow (as globes), so for them
weight shows only as the size.

### 12.4 Skins

All of a robot's look lives in one table, `ROBOT_SKINS`, keyed by skin name. The renderer reads only that table for
pixels; every rule in 12.3, 12.5 and 12.6 is written against the **contract** below, never against one skin's shape.
A new skin (the planned original `omnis` robot) is one new entry and nothing else. The active skin is one token,
`ROBOT.skin` (`'clawd'` for now); `/omnis pane style robot` uses it. It is not a user setting while there is only one
skin.

**The skin contract.** For each size S, M and L a skin gives:

| Field | Meaning | Used by |
|---|---|---|
| `bodyColor` | One per skin (not per size): the body's colour. `clawd`: `#d77757` | body, every state tone (12.2) |
| `w`, `h` | Sprite size, within the size's limit (12.3) | box, placement |
| `body` | The body rectangle `[x0, y0, x1, y1]` in sprite pixels: the solid trunk, without arms, legs or ears | halo, outline, bar columns |
| `haloRows` | The last sprite row the halo may paint (usually the row above the feet), so gaps between legs stay clear | halo |
| `eyes.open`, `eyes.closed` | Required eye variants: the whole sprite with that eye state, arms down | every state |
| `eyes.cross` | Optional: the "hurt" eyes (✕ or any shape that reads as broken). **If missing**, failed uses `eyes.open` with red eyes and an error leaves the eyes as they are | error, failed |
| `arms.down`, `arms.up` | Required arm variants: the whole sprite with arms in that pose. Only the `A` cells are read from these | tool wave |

Bitmap letters, the same for every skin:
- `.` clear (canvas, halo or outline shows through), `B` body = `body` (the state's tone of `bodyColor`, 12.2),
  `E` eye = the state's eye colour (12.2), `A` arm = `body` (`KIND[kind]` during a tool wave), `L` leg = `body`.
- A skin may add shade letters, but **every colour except `bodyColor` itself must be worked out from `body`**: `D` =
  `scale(body, 0.8)` and `H` = `mix(body, #ffffff, 0.2)` are the two allowed today. So waiting, done and failed tone
  the whole robot together, and a skin can't paint a second fixed colour that means something else.

**Compositing (skin-independent).** Take the eye variant the state asks for, turn its `A` cells to `.`, then set `A`
wherever the arm variant has `A`. Arms up with ✕ eyes, or arms up with closed eyes, need no extra bitmaps.

**Checks a skin must pass** (a unit test over `ROBOT_SKINS`, so a broken skin fails the build, not the pane):
every variant is `w × h`; `w × h` is within the size's limit; outside `A` cells, `arms.up` and `arms.down` match
`eyes.open` cell for cell; every `E` lies inside `body`; `eyes.closed` and `eyes.cross` differ from `eyes.open` (the
eyes are what carry waiting/done/failed in a still frame); `haloRows < h`; only the letters above appear. On `bodyColor`: at least 4.5:1 on `CANVAS`; `CANVAS` eyes at
least 3:1 on it and on its waiting tone; at least 9 OKLab ×100 from `ROBOT.dead`, and its done ghost at least 9 from
`ROBOT.dead`, under normal vision, protanopia and deuteranopia (`clawd`: 6.09; 6.09 and 3.47; 32.1 and 9.7 at worst).

#### Skin `clawd`

After the Claude Code mascot. Proportions from the start-up logo (`▐▛███▜▌` / `▝▜█████▛▘` / `▘▘ ▝▝`), worked out
from its quadrant blocks: body 6:4 wide to tall, arms one sixth of the body width on the third body row, legs in
pairs, eyes one sixth in from each side. Placeholder likeness: the legal check expects the public release to need an
original skin. `bodyColor` `#d77757` (the mascot's terracotta). No shade letters.

| Size | `w×h` | `body` | `haloRows` | `cross` |
|---|---|---|---|---|
| S | 8×5 | `[1, 0, 6, 3]` | 3 | none (6 pixels of face can't hold two 3×3 crosses) |
| M | 11×6 | `[1, 0, 9, 4]` | 4 | a `> <` squint |
| L | 13×7 | `[1, 0, 11, 5]` | 5 | two crosses, 3 px apart |

Column 0 is the box's left edge; row 0 is the sprite's top row (box row `headroom - lift`). `arms.down` is
`eyes.open`.

**S (8×5)**
```
eyes.open         arms.up           eyes.closed
.BBBBBB.          .BBBBBB.          .BBBBBB.
.BEBBEB.          ABEBBEBA          .BBBBBB.
ABBBBBBA          .BBBBBB.          ABBBBBBA
.BBBBBB.          .BBBBBB.          .BBBBBB.
..L..L..          ..L..L..          ..L..L..
```

**M (11×6).** Its `cross` is a squint: 3×3 crosses with one pixel between them read as a checkerboard in the
preview (first attempt, rejected).
```
eyes.open         arms.up           eyes.closed       eyes.cross
.BBBBBBBBB.       ABBBBBBBBBA       .BBBBBBBBB.       .BBBBBBBBB.
.BBEBBBEBB.       ABBEBBBEBBA       .BBBBBBBBB.       .BEBBBBBEB.
.BBEBBBEBB.       .BBEBBBEBB.       .BEEEBEEEB.       .BBEBBBEBB.
ABBBBBBBBBA       .BBBBBBBBB.       ABBBBBBBBBA       ABEBBBBBEBA
.BBBBBBBBB.       .BBBBBBBBB.       .BBBBBBBBB.       .BBBBBBBBB.
.L.L...L.L.       .L.L...L.L.       .L.L...L.L.       .L.L...L.L.
```

**L (13×7)**
```
eyes.open         arms.up           eyes.closed       eyes.cross
.BBBBBBBBBBB.     ABBBBBBBBBBBA     .BBBBBBBBBBB.     .BBBBBBBBBBB.
.BBEBBBBBEBB.     ABBEBBBBBEBBA     .BBBBBBBBBBB.     .BEBEBBBEBEB.
.BBEBBBBBEBB.     .BBEBBBBBEBB.     .BEEEBBBEEEB.     .BBEBBBBBEBB.
ABBBBBBBBBBBA     .BBBBBBBBBBB.     ABBBBBBBBBBBA     ABEBEBBBEBEBA
ABBBBBBBBBBBA     .BBBBBBBBBBB.     ABBBBBBBBBBBA     ABBBBBBBBBBBA
.BBBBBBBBBBB.     .BBBBBBBBBBB.     .BBBBBBBBBBB.     .BBBBBBBBBBB.
..L.L...L.L..     ..L.L...L.L..     ..L.L...L.L..     ..L.L...L.L..
```

#### Drawn round every skin

**Context bar (every size; replaces the context ring and carries the model).** The box's bottom row, under the
skin's `body` columns (`x0` to `x1`): the ground the robot stands on. Let `tone` be the model colour in the agent's
state (running and failed: as is; waiting: × 0.72; done: ghosted as the body). Pixel `i` of `n` is filled when
`(i + 0.5) / n ≤ fill`, filled from the left: in `tone` below 70%, in `contextColor(fill)` from 70% (`STATUS.warn`,
then `STATUS.failed` from 90%), so the warning thresholds still show. Unfilled pixels are the track,
`mix(CANVAS, tone, 0.35)`, so the model hue is there even at 0% context. With no context figure the whole row is
track. Placeholders have no bar.

**Halo (running only).** For each non-sprite pixel from `wH` rows above the sprite down to sprite row `haloRows`,
and from `wH` columns left of `body` to `wH` right of it: `d = ceil(hypot(dx, dy) - 0.25)`, where `dx`, `dy` are the
distances to the `body` rectangle (0 inside it). Pixels with `1 ≤ d ≤ wH` get
`add(under, glowColour, 0.8 × q5(1 - d / (wH + 1)) × glowK)`. Running: `glowColour` is the model colour (fade-in
applied) and `glowK` is worked out as for a globe. Failed: `STATUS.failed` at a steady 0.7. Error flash: see 12.5. *Rejected first:* a
Chebyshev halo round the whole sprite filled the leg gaps and drew a square frame, so the robot read as a TV set.

**Outline (stuck and clash; replaces the rim).** The `d = 1` pixels of the same field (non-sprite pixels only):
`mix(under, colour, k)`, drawn after the halo. Stuck: `STATUS.warn`, `k` as the stuck rim (section 4). Clash:
`LINK.clash` at 0.9 on the blink. Error flash: `STATUS.failed` at 0.9 on the red steps. Clash beats error, error
beats stuck. The outline can show at the same time as a tool wave or an
error flash, because those draw on the sprite and the outline draws around it.

### 12.5 States and motion (shared by every skin)

These rules name skin variants (`eyes.open`, `eyes.closed`, `eyes.cross`, `arms.down`, `arms.up`) and whole-sprite
offsets only. They never refer to a pixel of a particular skin, so a new skin gets every state and motion for free.

| State | Body | Eyes | Arms | Lift | Other |
|---|---|---|---|---|---|
| running | `bodyColor`, model glow | `eyes.open` | `arms.down` | hop table | halo breathes as a globe's |
| tool call (`pulseMs` 450, 3 steps) | as its state | as its state | **wave**: `q3(flash)` 3 → `arms.up`, 2 → `arms.down`, 1 → `arms.up`, 0 → as its state. Arm pixels in `KIND[kind]` for all three steps | as its state | replaces the rim flicker; coalesced as section 4 |
| error (`errorPulseMs` 900, 4 steps) | unchanged. `q4(flash)` 4 and 2: **glow `STATUS.failed` at `glowK` 1 and red outline** (drawn even if the agent has no glow); 3 and 1: the state's own glow, no outline | `eyes.cross` in `CANVAS` for the whole 900 ms | as its state | as its state | replaces the red rim pulse; never coalesced |
| waiting | `bodyColor` × 0.72 | `eyes.open`; **blink** to `eyes.closed` | `arms.down` | 0 | — |
| done | `bodyColor` ghost fade, then still | `eyes.closed` from `finishedAt` | `arms.down` | 0 | still |
| failed | `ROBOT.dead`, held; steady red glow | `eyes.cross` in `STATUS.failed` | `arms.down` | 0 | still |
| stuck | as its state | as its state | as its state | as its state | amber outline breathing |
| placeholder | `TEXT.faint`, always S | `eyes.closed` | `arms.down` | 0 | no bar, no glow |

The error flash is two red glow blinks in 900 ms (2.2 a second), under the 3-a-second limit.

**Hop (running).** The loop is `glowPeriodMs` (2000 ms) cut into 10 slots of 200 ms:
`slot = floor(10 × frac(now / glowPeriodMs + seed + 0.5))`, with `seed = hashUnit(id)` as for the glow. The `+ 0.5`
puts the top of the hop at the brightest point of the breath. Lift is a whole-sprite offset in pixels, by size, the same for every skin (the headroom in 12.3 is its maximum):

| Size | Slots 0-9 | Poses |
|---|---|---|
| S | `0 0 0 0 0 0 0 1 1 0` | 2 (ground, up 1) |
| M, L | `0 0 0 0 0 0 1 2 2 1` | 3 (ground, up 1, up 2) |

So a running robot stands still for 1.2-1.4 s, then makes one short hop: one hop every 2 s, out of step with its
neighbours. A faster hop was rejected: with five running agents, constant bouncing breaks "quiet by default". The
slots match `FPS.glow` (one frame a slot), so the hop needs no frame rate beyond what the glow already asks for.

**Blink (waiting).** Every 6000 ms per agent, eyes closed for 200 ms:
`closed = frac((now + seed × 6000) / 6000) < 200 / 6000`. A waiting agent otherwise needs only `FPS.tick` (1), so
the loop **schedules one frame at each blink edge** (start and end) instead of raising the rate: two extra frames
per waiting agent every 6 s.

**Precedence on the sprite:** while an error pulse is live the arms are body colour (in the wave position if a wave
is live too) and the glow flashes as above; a tool wave alone colours the arms. `eyes.cross` during an error beats a
blink. Done and failed ignore the hop, the blink and the wave.

**Degradation (section 6), robot form:**
1. *Breathing off:* no hop and no blink. **A running robot holds at lift 1** (one pixel off its bar), so running
   still differs from waiting by shape when nothing moves. Halo steady at 0.7, as for globes.
2. *Slow fades off:* the ghost jumps to its end state; `eyes.closed` at once.
3. *Clash blink off:* the clash outline is steady.
4. *Fade-in off:* robots appear at full colour.
5. *Pulse fade off:* a tool call is one frame with the arms up in `KIND` colour, held for `pulseHoldMs`; an error is
   one frame of red glow and outline with `eyes.cross`, held the same way.
6. *Comets off:* no change for robots.

### 12.6 Still frame (Svg, and any frame where motion is off)

Running is lift 1 with a steady halo, waiting is grounded with open eyes, done is a ghost with closed eyes, failed
is a dark grey robot with red `eyes.cross` in a steady red glow, and tool calls and errors show nothing. In greyscale,
running and waiting differ by lift, halo, body tone and label glyph; waiting and done by the eyes and body tone;
failed by its dark body (25+ OKLab from running and waiting, 10 from done) and `eyes.cross` (at S, where `clawd` has
no cross, by the dark body, red eyes and the label's `✕`).

### 12.7 Budget

- **Frames:** nothing beyond the globe style. The hop and the glow share `FPS.glow`; the wave and the error flash
  live inside the existing pulse windows at `FPS.busy`; a blink adds two scheduled frames per waiting agent every 6 s.
- **Pairs:** a robot draws one body colour (plus up to two shades if its skin uses `D` or `H`), the eye colour, at
  most one arm colour, 5 halo levels and 2-3 bar colours. A globe draws 4 disc shades, 5 halo levels and 2 ring colours, so a robot frame should come in at or below
  a globe frame. Not measured: check `pairCount` on robot goldens.
- **Paint cost:** a box of at most 13×10 plus a halo of at most 3 px; less per node than a 6 px globe's disc, ring
  and glow loop.

### 12.8 To check on the robot goldens

- [ ] Every size × state matches the active skin's bitmaps pixel for pixel (a robot golden per size and state).
- [ ] Every skin in `ROBOT_SKINS` passes the skin checks in 12.4.
- [ ] No rule outside `ROBOT_SKINS` names a pixel position, row or column of a particular skin.
- [ ] No two robot boxes (grown by 1 px) overlap; where S would, the tree shows.
- [ ] Labels sit one row under the box and never move during a hop.
- [ ] A tool wave on a haiku robot with an edit (`KIND.edit` against haiku: OKLab 8.3 normal, 4.8 deuteranopia):
      the wave's shape carries it, not the colour.
- [ ] A degraded running robot is drawn at lift 1.
- [ ] No robot body is ever red; failed is `ROBOT.dead` with red eyes and a red glow, and an error flashes only
      the glow and outline.
- [ ] Each chip dot's hue matches its robot's glow and bar.
- [ ] `pairCount` on robot goldens is at or below the matching globe goldens.

## 13. Guard badge, replay, GIF card, model badge

The look of the four features in `docs/superpowers/specs/2026-10-22-guard-replay-design.md`. Same rules as §12:
tokens, exact values, nothing carried by colour alone, the frame budget of section 6.

**What was checked and how.** Robot and globe previews were drawn on a `Pixels` canvas by a throwaway script
following this section. Header, card and badge mock-ups were drawn as text cells in Consolas (10×20 px cells, so
they are wider than a real 8×16 cell). Contrast and OKLab figures were computed as in section 3. **Not checked:** a
real terminal, render time, pair counts in a golden, and the GIF encoder's palette.

### 13.1 Tokens

| Token | Value | Use | Check |
|---|---|---|---|
| `GUARD.drop` | `#e0f4ff` | The sweat drop on robots and globes | 16.95:1 on `CANVAS`; 2.78:1 on terracotta, 4.89:1 on waiting terracotta; OKLab ×100 from terracotta 32.5 / 36.1 / 29.5 / 34.1 (normal / protanopia / deuteranopia / tritanopia); from `KIND.read` 17.0 / 10.8 / 15.1 / 17.1 |
| `GUARD.dripMix` | 0.7 | The drip pixel: `mix(body, GUARD.drop, 0.7)` | 2.08:1 on terracotta (motion carries it) |
| `GUARD.flashMs` | 450 (= `pulseMs`) | Drop flash when a `guard.warned` or `guard.nudged` event arrives | — |
| `REPLAY.raised` | `#202337` = `mix(CANVAS_RAISED, ACCENT, 0.08)` | Header background (both rows, the 1-row header and the summary line) during a replay and in a GIF | On it: `TEXT.primary` 13.10, `TEXT.dim` 6.14, `STATUS.failed` 4.62, `STATUS.warn` 6.87, `STATUS.running` 10.07, `ACCENT` 6.00. A 0.10 tint would put failed text at 4.47, under 4.5, so the tint stays at 0.08 and the badge does the work |
| `REPLAY.badge` | text `CANVAS` on `ACCENT` | ` REPLAY 10× ` | 7.43:1 |
| `GUARD.blockedBadge` | text `CANVAS` on `STATUS.failed` | ` BLOCKED ` | 5.72:1 |
| `GLYPH.times` | `×` U+00D7 (width A) | The replay speed | add to section 5 |
| `GLYPH.cheaper` / `dearer` | `↓` / `↑` (already in section 5) | Model badge mark after a label | — |

### 13.2 Guard warning badge: the sweat drop

**One mark for both styles.** Robots and globes both get a sweat drop. I've used it instead of the spec's
"amber rim on globes" because the amber rim already means **stuck** (section 4: an amber rim breathing on the glow
period); a second amber rim meaning "over budget" would make the two unreadable apart, both in colour and in shape.
The drop is a new shape, so it reads in greyscale and under every colour-vision deficiency.

**Warned vs nudged.** Warned: one drop at the top right. Nudged (the agent has been told to wrap up): **two drops**,
the second mirrored at the top left. More sweat, same meaning, readable without colour.

**Robots.** Each skin gives a `sweat` overlay per size: a list of sprite pixels drawn in `GUARD.drop` after the
sprite and before the bar (contract addition to §12.4; the nudged copy is mirrored, `x → w - 1 - x`). The drop moves
with the sprite, so it lives inside the box and hops with the robot; no new headroom. `clawd`:

| Size | Warned pixels `(x, y)` | Where | Drip |
|---|---|---|---|
| S | `(7, 0)`, `(7, 1)` | the clear column right of the head, beside it (on the body it sat against the eye and read as a white eye) | none (too small) |
| M | `(9, 0)`, `(8, 1)`, `(9, 1)` | the head's top-right corner: a tip and a two-pixel bead | yes |
| L | `(11, 0)`, `(10, 1)`, `(11, 1)`, `(10, 2)`, `(11, 2)` | the head's top-right corner: a tip and a 2×2 bead | yes |

```
S warned          M warned          L warned          M nudged
.BBBBBBW          .BBBBBBBBW.       .BBBBBBBBBBW.     .WBBBBBBBW.
.BEBBEBW          .BBEBBBEWW.       .BBEBBBBBEWW.     .WWEBBBEWW.
ABBBBBBA          .BBEBBBEBB.       .BBEBBBBBEWW.     .BBEBBBEBB.
...               ...               ...               ...
```
(`W` = `GUARD.drop`; S's drop sits in sprite column 7, which is clear except for `arms.up`.)

**The drip (M and L, running or waiting with a drop).** It uses the hop's slot clock (§12.5, 10 slots of 200 ms, same
seed): in slots 2, 3 and 4 one pixel at the body's right column (`body.x1`) is drawn `GUARD.dripMix` toward the
drop, at rows `dropBottom + 1`, `+ 2`, `+ 3` (skipped past the body's last row). Slots 0-1 and 5-9: no drip. A bead
of sweat runs down the side of the head once every 2 s, just before the hop, so it needs no frame beyond `FPS.glow`.
Nudged robots drip on both sides (mirrored column `body.x0`).

**Globes.** The same drop on the canvas, outside the ring: anchor `a = round(p + (r + ringPx + 1.5) × (cos 45°,
-sin 45°)) + (0, 1)`. For `r ≥ 2.2` the pixels are `a + (1, -2)`, `a + (0, -1)`, `a + (1, -1)`; below 2.2, `a + (0,
-1)` and `a`. Nudged: mirrored about the node's vertical axis (one o'clock and eleven o'clock). Drawn after the
halo and rims, before links. No drip on globes. The drop counts as node pixels for label clearance.

**When it shows.** From the agent's first `guard.warned` (one drop) or `guard.nudged` (two) until the agent is done
or failed. Done and failed robots and globes never show a drop (the guard is about live agents; the ghost and the
dead robot already say the agent stopped). A waiting agent keeps its drop (cost limits can be passed while waiting).

**Drop flash** when a `guard.warned` or `guard.nudged` event arrives: `GUARD.flashMs` (450 ms), 3 steps on the pulse
machinery: `q3(flash)` 3 and 1 → the drop pixels in `#ffffff`, 2 → `GUARD.drop`. Never coalesced (these events are
rare). It runs at `FPS.busy` like any pulse.

**How it combines** (one row per neighbour; the drop is drawn on the sprite or beside it, outlines are drawn round
the body, so they never fight):

| With | Result |
|---|---|
| stuck (amber outline) | both: amber outline round the body, drop on the head |
| clash (red outline blinking) | both |
| hop | the drop rides with the sprite; drip slots 2-4 come while the robot is on the ground (hop is slots 6-9) |
| tool wave | both; at S, `arms.up` puts the arm on `(7, 1)`: the **arm wins** for the 450 ms of the wave |
| error flash | both: red glow and outline, hurt eyes, drop unchanged |
| blink | both |
| done / failed | no drop |
| degraded (section 6) | breathing off → no drip; pulse fade off → the flash is one frame of `#ffffff`, held for `pulseHoldMs` |
| still frame (Svg) | drop shown, no drip, no flash |

**Words elsewhere** (so the drop is never the only carrier):
- Spotlight row 4, right-aligned before `! stuck`: `over time-box 21m/20m` or `over $3.20/$3` in `STATUS.warn`
  (when warned), `nudged 31m/30m` (when nudged). If both limits are passed, the one furthest past its act level.
- Tree: ` over` after the figures, `STATUS.warn`.
- The toast and the `guard.*` feed lines are the spec's.

**A blocked swarm in the header.**
- Row 0, the cost group: quiet below the swarm warn level (no limit shown). From the warn level it becomes
  `≈$11.20/$20`, figure in `STATUS.warn`, `/$20` in `TEXT.dim`. From the act level the figure is `STATUS.failed`.
- Row 1, right-aligned notes, new priority 0 (before the degraded note): while spawns are blocked,
  ` BLOCKED ` (`GUARD.blockedBadge`) then ` new agents` `TEXT.dim` · `/omnis budget <usd>` `TEXT.dim`. Priority 2
  (after the degraded note): `n over budget` in `STATUS.warn` while any agent shows a drop.
- 1-row header and summary line: ` BLOCKED ` right-aligned before the gaps marker, nothing else.
- The badge is a word in reverse video, so it reads without colour.

### 13.3 Replay

So nobody mistakes a replay for live: **a badge, a clock and a tinted header, all three, for as long as the replay
is on** (including after it ends, until `/omnis replay stop`).

- Row 0 starts with ` REPLAY 10× ` (`REPLAY.badge`; speed as an integer then `×`), then ` 03:12` in
  `TEXT.primary` (replay time since the swarm started) and ` / 08:40` in `TEXT.dim` (the swarm's length after gap
  cutting is *not* used: the clock shows the swarm's own time, so "3:12" means 3:12 into the real run). Over an hour:
  `1:03:12`. Then two spaces and the usual row 0 (`◆ name · …`). The badge and clock are never dropped; the
  whole-or-absent rule applies to everything after them.
- When the replay reaches the end: ` 08:40 / 08:40 end` (`end` `TEXT.dim`), and the row 1 notes gain
  `/omnis replay stop` in `TEXT.dim` at priority 1.
- Both header rows (and the 1-row header and summary line) are painted `REPLAY.raised` instead of
  `CANVAS_RAISED`. The rest of the pane is unchanged: same renderer, same style, so a replay looks like the run did.
- 1-row header and summary line: ` REPLAY 10× ` first, then the clock if it fits whole, then the usual parts.
- Ages in the feed, the burn rate and live timeline bars are measured against the replay clock.
- No motion of its own: the badge doesn't blink.

### 13.4 GIF export: header mark and summary card

**Frame.** The full layout at 120×44 cells, rasterised at 8×16 px a cell: **960×704 px**. The header during the clip
is the replay header (13.3) with the real speed (e.g. ` REPLAY 24× `), plus the wordmark `OmnisSwarm` right-aligned
at the end of row 0 (`Omnis` in `ACCENT`, `Swarm` in `TEXT.primary`), with the gaps marker moved to its left.

**Summary card** for the clip's last 3 s (30 frames at 10 fps): **60×14 cells, centred in the graph region**
(at the full step: columns 30-89, rows 7-20 of the top grid). The graph under it holds its final state and is
dimmed: every graph cell outside the card has fg and bg mixed 0.5 toward `CANVAS`. The bottom grid stays as it is.

Fade-in over the first 3 frames (0.3 s): the card's cells `mix(dimmed graph, card, k)` and the graph dimming at
`0.5 × k`, for `k` = 1/3, 2/3, 1. Then 27 frames still. No other motion on the card.

Layout (card-relative cells; background `CANVAS_RAISED`; row 0's upper pixel is a line of `ACCENT`, drawn as `▀`
in `ACCENT` over `CANVAS_RAISED`):

| Row | Columns | Content |
|---|---|---|
| 1-3 | 3-10 | The mark (pixels, below) |
| 1 | 13 | `Omnis` `ACCENT` + `Swarm` `TEXT.primary` |
| 2 | 13 | `swarm replay` `TEXT.dim` |
| 5 | 3 | swarm name `TEXT.primary` · topology `TEXT.dim` · `ended 14:05` `TEXT.dim` (separators `TEXT.faint`) |
| 7 / 8 | 3, 17, 31, 45 | Four figures in `TEXT.primary` over their labels in `TEXT.dim`: agents (`6` / `agents`), duration (`12m 40s`; `1h 05m` past an hour), cost (`≈$1.31`, `+` when some agents are unpriced), messages (`42` / `messages`) |
| 10 | 3 | `✓ 4 done   ✕ 1 failed   ◌ 1 waiting`: each glyph in its status colour, words `TEXT.dim`; a status with 0 is left out |
| 11 | 3 | `● opus 2   ● sonnet 3   ● haiku 1`: answered model families, dot in the model colour, words `TEXT.dim` |
| 12 | 3 | `2026-10-22 · 8:40 of work in 24 s` `TEXT.dim` |

Every text colour on `CANVAS_RAISED` passes: `TEXT.primary` 14.8, `TEXT.dim` 6.9, `STATUS.failed` 5.21; the model
dots are signals, 4.83-13.20.

**The mark** (original, no mascot): three nodes and their links, the swarm in miniature. 8×6 px at card pixels
x 3-10, y 2-7. Key: `O` `MODEL.opus`, `S` `MODEL.sonnet`, `F` `MODEL.fable`, `A` `ACCENT`, `.` card background.
```
...OO...
...OO...
..A..A..
.A....A.
SS....FF
SS.AA.FF
```
The mark appears only on the card; the header uses the wordmark (a 6-px mark would be one cell tall there and turn
to mush).

### 13.5 Model badge (`sonnet → haiku`)

When the requested and answered model families differ:
- **Spotlight row 0**, in place of the model id: `sonnet` in `TEXT.dim`, ` → ` in `TEXT.faint`, `haiku` in the
  answered model's colour (`MODEL.haiku`). The `●` and every other model colour in the pane (globe fill, robot glow and
  bar, chip dot, tree name, timeline bar) are the **answered** model: that is what ran and what it cost.
- **Spotlight row 1**, right side: `≈$0.04` `TEXT.primary`, then ` · saves ` `TEXT.dim`, `≈$0.08` in
  `STATUS.running`, ` vs requested` `TEXT.dim`. If the answered model costs more: ` · costs ≈$0.05 more vs requested`
  with the figure in `STATUS.warn`. The words say which way, so the green/amber is a bonus. Either part is whole or
  absent (section 9); `vs requested` is never cut, since without it the figure reads as Router's own.
- **Graph label**: a mark after the name, `↓` in `TEXT.dim` (answered model cheaper) or `↑` in `STATUS.warn` (dearer),
  with a space before it: `▶ coder-1 ↓`. Dropped in the glyph-only fallback. The same mark follows the name in the tree.
- Compact spotlight (1 row): ` · sonnet → haiku` after the name, same colours; the saving is left out.
- Same family (e.g. two Sonnet versions): no badge.

### 13.6 Budget

- Frames: the drip uses the glow slot clock; the drop flash is a pulse at `FPS.busy`; the replay adds nothing; the
  GIF card is frames in a file, not the pane.
- Pairs: the drop adds 1-2 colours per node with a drop (drop, drip mix); the replay tint swaps one background for
  another; the badges add 2. Not measured: check `pairCount` on a guard and a replay golden.

### 13.7 To check on the goldens

- [ ] Warned and nudged robots at S, M and L match 13.2 pixel for pixel; the drop stays inside the box at the top of a hop.
- [ ] No drop on a done or failed node; a waiting agent keeps it.
- [ ] Globes show the drop outside the ring, never an amber rim for the guard; stuck still shows its amber rim.
- [ ] Every frame of a replay shows ` REPLAY n× `, the clock and `REPLAY.raised` on the header, at every size step.
- [ ] The GIF card sits at columns 30-89, rows 7-20, the graph behind it dimmed, and fits 60×14 with a 4-digit cost.
- [ ] `sonnet → haiku` and `saves … vs requested` show whole or not at all; the label mark is `↓`/`↑`.
- [ ] ` BLOCKED ` shows on row 1 (or right-aligned on a 1-row header) for as long as spawns are denied.
