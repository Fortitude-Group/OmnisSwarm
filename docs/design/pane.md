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
| `KIND.other` | `#d6dbe1` | Any other tool (signal) | 13.77 |
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
| `MOTION.glowPeriodMs` | 1600 | One breath of a running node's halo | — |
| `MOTION.cometMs` | 900 | Comet head travel, sender to receiver, ease-in-out | — |
| `MOTION.trailMs` | 450 | How far behind the head the trail reaches, in time | — |
| `MOTION.trailDots` | 6 | Trail dots behind the head | — |
| `MOTION.linkFadeMs` | 3000 | A link's brightening after a message decays back to idle, linear | — |
| `MOTION.pulseMs` | 350 | Tool-start rim flicker, linear decay | — |
| `MOTION.errorPulseMs` | 900 | Failed-tool red rim pulse, linear decay | — |
| `MOTION.clashFlashMs` | 4000 | A clash's rims blink for this long after the latest clashing edit | — |
| `MOTION.clashBlinkMs` | **400** | Half-period of the clash blink: 1.25 blinks a second (was 250) | — |
| `MOTION.tweenMs` | 400 | Nodes glide to new positions after a layout change, ease-out cubic | — |
| `FPS.busy` | 30 | Frame rate while comets, fades, pulses, glides or a clash blink are live | — |
| `FPS.glow` | 12 | Frame rate while only glows and stuck rims move | — |
| `FPS.min` | 4 | Slowest the back-off goes | — |
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

**Tool flicker** (`pulseMs`): the outer pixel band of the node (`r - 1 < d ≤ r`) blends toward `KIND[kind]` by
`q4(flash)`. **Also light one pixel band outside the ring** (`r + ringPx < d ≤ r + ringPx + 1`) with
`light(KIND[kind], 0.6 × q4(flash))`. The outer flare sits on the canvas, so an edit (amber) on a haiku (yellow)
node still shows. This is a small addition to Task 11's `paintNode`.

**Error pulse** (`errorPulseMs`): the same rim and flare in `STATUS.failed`. Of several live pulses on one node the
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
| `glowPeriodMs` 1600 | The agent is working | sine, phase `hashUnit(id)` so neighbours breathe out of step | 5 |
| `cometMs` 900 | A message is travelling | ease-in-out along the link's arc; the same time for any link length, so every message reads as one beat | head 1 + trail 4 |
| `trailMs` 450 / `trailDots` 6 | Which way the message went | trail dot *i* has strength `1 - i/7`, colour `mix(CANVAS, LINK.active, q4(k))` | 4 |
| `linkFadeMs` 3000 | Which links carried traffic recently | linear, `mix(LINK.idle, LINK.active, recency)` | 5 |
| `pulseMs` 350 | A tool call started | linear decay | 4 |
| `errorPulseMs` 900 | A tool call failed | linear decay | 4 |
| `clashFlashMs` 4000 / `clashBlinkMs` 400 | Two agents edited the same file | square wave, rims at 0.9 strength on, off on the other half-period | 2 |
| `tweenMs` 400 | The layout changed (an agent arrived) | ease-out cubic from old to new positions | continuous |

The comet head is two braille dots side by side in `LINK.comet` with `light(LINK.active, 0.35)` on the pixel under
it, so the head glows. Draw every trail first and every head last, so a head is never painted over.

Comets and pulses are drawn at `tEff = now - lag` (lag capped at 1 s): events arrive in batches every `PULL_MS`, and
drawing them at their own time keeps a comet starting at its sender instead of jumping in half-way.

**Frame rate policy** (`targetFps`, Task 12):
1. `FPS.busy` (30) while any comet, fade-in, ghost fade, pulse, glide or clash blink is live.
2. Otherwise `FPS.glow` (12) while any running agent glows or any stuck rim breathes.
3. Otherwise **`FPS.tick` (1) while the pane is shown.** Ages in the feed (`12s`), a waiting agent's live timeline
   bar, the header's burn rate and a link still fading back to idle all change with the clock, not with events.
   The pane only redraws after a pull that brings news, so without a tick they freeze mid-state. One frame a second
   costs less than the four pulls a second the pane already makes. This changes the plan's "0 when nothing moves"
   to "1 when nothing moves, while shown". Spec section 10 says the frame loop stops when nothing moves; it still
   stops when the pane is hidden, closed or off the terminal.
4. Back-off as Task 12's `frameInterval`: a frame that took more than 60% of its interval doubles the interval,
   never slower than `FPS.min` (4); one that took under 25% halves it again, never faster than the target. The
   tick (1 fps, 1000 ms) is already slower than `FPS.min` and is exempt from the floor.

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
glyph alone; if that overlaps too, skip it (the chips and spotlight still name everyone). A label needs its span
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
- [ ] Nothing moves in the `idle` golden except what section 6 allows (glow for a running agent, the tick).
- [ ] A comet head is visible in the `mid` golden and no comet in `idle`.
- [ ] Tool flicker on a same-hue node (edit on haiku) shows in the outer flare.
- [ ] Task 2 confirms `▶` and `⚠` draw as narrow text in Windows Terminal; otherwise swap to `▸` and `▲`.
- [ ] Every node label has a clear cell either side: no braille dot or node pixel touches a label.
- [ ] No two node discs or halos overlap; where they would, the graph area shows the tree (legibility guard).
- [ ] No header figure is cut part-way (`cc $1.2`); the goal shows whole, or at least 12 cells of it, or not at all.
- [ ] A degraded read shows `⚠` and its note in `STATUS.warn`, not in dim text alone.
- [ ] Timeline bars are `▅` with a quiet body and a full-colour end; the timeline weighs less than the graph.
