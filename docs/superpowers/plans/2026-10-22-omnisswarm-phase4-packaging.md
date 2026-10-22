# OmnisSwarm Phase 4 (Packaging) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OmnisSwarm installable from its own GitHub marketplace (`/plugin marketplace add Fortitude-Group/OmnisSwarm`, then `/plugin install omnis-swarm@omnis-swarm`), harden the three places a real install can break it, and ship a README and third-party notices, with `claude plugin validate .` passing with no warnings.

**Architecture:** No new subsystems. Manifest edits (integrator-owned), a plain-JS launcher in front of the type-stripped MCP server so an old Node gets a readable error, a one-line widening of the guard's origin match, a distinct degraded state for a render that throws, a test-time warning when the vendored engine types fall behind the engine, and two docs files. Optional tasks: compact the per-call spend list in trimmed feed replies, warm the renderer at open, and an engine-level timing harness.

**Tech Stack:** Node 24 type-stripped `.ts`, `node:test`, the `claude-code/testing` kit (`npm run test:mod`), `claude plugin validate`. No dependencies.

## Global Constraints

- No new dependencies (runtime or dev).
- Every file under 500 lines.
- Mod code (`src/mod/**`, `src/render/**`, the core files in `tsconfig.mod.json`): web APIs only, timers only through `$.clock` (via the `host` helpers), never store `$` and never pass `$` through a property call.
- Commits: plain messages in Rob's voice (writing-no-slop), no `Co-Authored-By`, no "Generated with" line, author `Fortitude Omnis <dev@fortitude-omnis.group>`.
- Git from Git Bash only. One writer per worktree; each wave-1 task in its own worktree off `master`.
- Gate for every task: `npm test` and `npm run test:mod` green (`test:mod` runs `claude plugin validate` too). `npm run typecheck` clean.
- End-of-phase gate: `claude plugin validate .` prints no `⚠` and no `✘` lines, run in a clean checkout (see Task 8 on the untracked `CLAUDE.md`).
- Only the integrator edits `package.json`, `package-lock.json`, `.gitignore`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`.

## Facts settled before planning (with sources)

1. **Marketplace manifest already exists** (`.claude-plugin/marketplace.json`, entry `source: "./"`). `claude plugin validate .` (Claude Code 2.1.308) warns only `description: No marketplace description provided`. A top-level `"description"` is the documented field (code.claude.com/docs/en/plugin-marketplaces, step 2 example).
2. **Install id** is `<entry-name>@<marketplace-name>` = `omnis-swarm@omnis-swarm` (same docs, step 4). One-step form: `/plugin install omnis-swarm --marketplace Fortitude-Group/OmnisSwarm` (code.claude.com/docs/en/plugins/publish.md, needs 2.1.275+).
3. **No file exclusion exists.** A relative-path plugin in a git-hosted marketplace is copied into `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` from the marketplace clone; "files outside the plugin directory aren't copied", and nothing documents an ignore list (code.claude.com/docs/en/plugins/loading.md, "In-place and copied plugins"). With `source: "./"` every tracked file ships. Gitignored paths (`.superpowers/`, `.omnis-swarm/`, `.claude-plugin/types/`, `node_modules/`) are not in the clone, so they don't ship. `tests/`, `scripts/`, `docs/`, `src/mod/*.test.ts` and `src/mod/test-engine.ts` ship but never load: `hooks/hooks.json` loads only `src/mod/register.ts` and the MCP server only `src/mcp/**`. `types/` must ship (`plugin.json` `"types"`). 214 tracked files, about 3 MB.
4. **A lockfile triggers an install on the user's machine.** When the cached copy has `package.json` plus `package-lock.json` at its root, Claude Code runs a frozen, `--ignore-scripts` npm install there, 60 s timeout (loading.md, "Node.js package dependencies"). We have only devDependencies (`typescript`, `@types/node`). The docs don't say whether dev dependencies are installed. Task 8 settles it with a probe.
5. **Names after a marketplace install.** `$.plugin.name` is "From plugin.json", the manifest name (`types/claude-code/index.d.ts`, `CoreEngineInterface.plugin`). `next.origin.plugin` is "Whose hook made the `$` call, by name" (`Origin`, same file). Components are namespaced under the manifest name; the entry name is only the `enabledPlugins` key and cache folder (loading.md, "Entry name and manifest name"). Both names are `omnis-swarm` here, so both values should be the bare `omnis-swarm`. Plugin names can't contain `@` (code.claude.com/docs/en/plugins-reference, `name`), so also accepting `omnis-swarm@<anything>` costs nothing and covers a host that stamps the install id. Task 3 does that; Task 8 confirms it live.
6. **Icon.** `plugin.json` `"icon"` is a path to an image inside the plugin, read only by Anthropic's directory; Claude Code ignores it (plugins-reference, "Directory listing fields"). Validate doesn't flag it on 2.1.281+. The directory accepts SVG, PNG, JPEG, GIF and WebP, and no dimensions are given (claude.com/docs/plugins/pre-submission-checklist, "Files in the plugin folder"). We use a square SVG: it's text, crisp at any size, and needs no rasteriser.
7. **The Node check in `server.ts` can't fire where it's needed.** `server.ts` is TypeScript. A Node that can't strip types refuses the file (`ERR_UNKNOWN_FILE_EXTENSION`) before any line runs, and ESM hoists the static imports anyway. The check only ever runs on Nodes that already pass it. Type stripping is on by default from Node 22.18, 23.6 and 24 (Node release notes, from memory, not fetched); the current check misses 23.6+. Task 2 puts a plain `.mjs` launcher in front.
8. **Render throws reuse the wrong note.** `periodFailed` (`src/mod/pane-pull.ts:105`) always marks `'unreadable'`, which reads "⚠ Waiting for the swarm…" (`src/mod/pane-draw.ts:28`, `src/render/frame.ts:191`). `ui.render` (`src/mod/pane.ts:66`) calls `frameAt` with no guard, so a render that keeps throwing throws out of the hook.
9. **Vendored types are already behind.** `types/claude-code/index.d.ts` line 1: `// Written by Claude Code 2.1.307.`; the engine-laid `.claude-plugin/types/claude-code/index.d.ts` (gitignored, rewritten on each mod load) says `2.1.308`; the running CLI is 2.1.308. Comparing those two headers needs no `claude` process, so a test can do it cheaply (Task 6).
10. **Validate today** also prints `⚠ root: CLAUDE.md at the plugin root is not loaded as project context` and `✘ README.md: README missing (README_MISSING)`. `CLAUDE.md` is **untracked** (not in `git ls-files`), so a marketplace clone never has it, but a validate run in this working copy sees it.
11. **The per-call spend list breaks the feed ceiling well before 45 agents.** `state.spend` gets one `{at, usd}` entry per model call, kept for 10 minutes (`src/core/fold.ts:266-267`), and `cut()` in `src/core/feed-reply.ts` never trims it. Only the last 5 minutes are read (`BURN_WINDOW_MS`, `src/core/stats.ts:8,171`). Arithmetic: 10 agents making a call every 5 s fill 1,200 entries in 10 minutes, about 36 bytes each, roughly 43 KB, which is over `FEED_REPLY_MAX` (40,000) whatever else is trimmed. So a fresh pull (opening the pane mid-swarm) reports "too large" for a busy 10-agent swarm. The existing ceiling tests use one call per agent, which is why they don't catch it. I worked this out by arithmetic; I haven't run it. Task 9 is marked optional in the ledger, but I recommend doing it.

## File ownership

| Task | Wave | Mode | Owner agent | Files (exclusive) |
|---|---|---|---|---|
| 2 Node launcher | 1 | parallel | omnis-developer | `src/mcp/start.mjs` (new), `src/mcp/node-version.mjs` (new), `src/mcp/node-version.d.mts` (new), `src/mcp/node-version.ts` (delete), `src/mcp/server.ts`, `tests/mcp/node-version.test.ts`, `tests/e2e/mcp-server.test.ts` |
| 3 Guard origin | 1 | parallel | omnis-developer | `src/core/recording.ts`, `tests/core/recording.test.ts` |
| 4 Render-failed note | 1 | parallel | omnis-developer | `src/mod/pane-model.ts`, `src/mod/pane-pull.ts`, `src/mod/pane-draw.ts`, `src/mod/pane.ts`, `src/mod/pane-draw.test.ts` (new), `docs/design/pane.md` (§9 only) |
| 5 Icon | 1 | parallel | omnis-designer | `assets/icon.svg` (new) |
| 6 Types refresh + lag warning | 1 | parallel | omnis-developer | `types/claude-code/index.d.ts`, `types/claude-code-tools/index.d.ts`, `types/claude-code-mcp/index.d.ts`, `tests/core/vendored-types.test.ts` |
| 7 README + notices | 1 | parallel | omnis-writer | `README.md` (new), `THIRD-PARTY-NOTICES` (new) |
| 9 Spend compaction (optional, recommended) | 1 | parallel | omnis-developer | `src/core/feed-reply.ts`, `tests/core/feed-reply.test.ts` |
| 1 Manifests | 2 | serial, after 2 and 5 | omnis-integrator | `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` |
| 8 Integrate + install acceptance | 2 | serial, after 1 | omnis-integrator (merge), then lead/Rob (probe) | merges; `CLAUDE.md` move per Rob's decision |
| 10 Warm renderer (optional) | 3 | serial, after 4 | omnis-developer | `src/mod/pane-draw.ts`, `src/mod/pane-draw.test.ts` |
| 11 Engine timing harness (optional) | 3 | parallel with 10 | omnis-developer | `scripts/bench-engine.ts` (new), `bench/pane-tick.test.ts` (new) |

Wave 1 runs seven tasks at once (six if Task 9 is skipped). No two share a file. Task 4 edits `docs/design/pane.md`, which currently has uncommitted edits in the main working copy from other work. Its worktree branches from `master`, and the integrator merges §9 by hand if those edits land first.

---

### Task 1: Manifests (integrator, wave 2)

**Files:**
- Modify: `.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`

**Interfaces:**
- Consumes: `src/mcp/start.mjs` (Task 2), `assets/icon.svg` (Task 5).
- Produces: the install id `omnis-swarm@omnis-swarm`; the MCP server launched through `start.mjs`.

- [ ] **Step 1: Edit `marketplace.json`.** Add a top-level `description` after `"name"`:

```json
{
  "name": "omnis-swarm",
  "description": "Fortitude Omnis plugins for Claude Code. One so far: OmnisSwarm, swarm coordination with a live pane that shows every agent at work.",
  "owner": { "name": "Fortitude Omnis" },
  "plugins": [
    {
      "name": "omnis-swarm",
      "source": "./",
      "description": "Swarm coordination and a live read-only swarm pane for Claude Code."
    }
  ]
}
```

(omnis-writer may reword both description strings in Task 7's report. Use its wording if it gives one.)

- [ ] **Step 2: Edit `plugin.json`.** Add these keys after `"description"`, and point the server at the launcher:

```json
  "displayName": "OmnisSwarm",
  "repository": "https://github.com/Fortitude-Group/OmnisSwarm",
  "keywords": ["swarm", "agents", "coordination", "pane"],
  "icon": "./assets/icon.svg",
```

```json
      "args": ["${CLAUDE_PLUGIN_ROOT}/src/mcp/start.mjs"],
```

Leave `"version": "0.1.0"`, `"license"` and `userConfig` alone.

- [ ] **Step 3: Validate.** Run: `claude plugin validate .`
Expected: no `⚠` line about `description` or any manifest field, and no `✘` line about `README.md` once Task 7 is merged. The `CLAUDE.md` warning is Task 8's job.

- [ ] **Step 4: Gate.** Run `npm test && npm run test:mod`. Expected: all pass. The e2e test from Task 2 spawns `start.mjs` directly, so nothing else depends on the manifest path.

- [ ] **Step 5: Commit**

```bash
git add .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "Describe the marketplace and start the server through the Node check"
```

---

### Task 2: Node launcher that fails clearly on an old Node

**Files:**
- Create: `src/mcp/node-version.mjs`, `src/mcp/node-version.d.mts`, `src/mcp/start.mjs`
- Delete: `src/mcp/node-version.ts`
- Modify: `src/mcp/server.ts:4,9-13` (drop the check)
- Modify: `tests/mcp/node-version.test.ts`, `tests/e2e/mcp-server.test.ts`

**Interfaces:**
- Produces: `nodeVersionProblem(version: string): string | null` from `src/mcp/node-version.mjs`; `src/mcp/start.mjs` as the server entry Task 1 points `plugin.json` at.

- [ ] **Step 1: Write the failing tests.** Replace `tests/mcp/node-version.test.ts` with:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { nodeVersionProblem } from '../../src/mcp/node-version.mjs'

const START = fileURLToPath(new URL('../../src/mcp/start.mjs', import.meta.url))

test('Nodes that strip types by default pass: 22.18+, 23.6+, 24+', () => {
  for (const v of ['24.0.0', 'v24.1.0', '25.3.1', '22.18.0', '22.20.1', '23.6.0', 'v23.11.1']) assert.equal(nodeVersionProblem(v), null, v)
})

test('older Node gets one clear line naming what it needs and what it found', () => {
  assert.equal(nodeVersionProblem('22.17.9'), 'omnis-swarm needs Node 22.18 or newer (24 recommended); found v22.17.9')
  assert.equal(nodeVersionProblem('v23.5.0'), 'omnis-swarm needs Node 22.18 or newer (24 recommended); found v23.5.0')
  assert.equal(nodeVersionProblem('v20.11.0'), 'omnis-swarm needs Node 22.18 or newer (24 recommended); found v20.11.0')
  assert.match(nodeVersionProblem('garbage') ?? '', /needs Node 22\.18/)
})

test('start.mjs is plain JavaScript that any Node can parse, and loads the server only by dynamic import', () => {
  const source = readFileSync(START, 'utf8')
  assert.doesNotMatch(source, /^\s*import\s[^(]*['"]\.\/server\.ts['"]/m, 'a static import of server.ts would fail before the check runs')
  assert.match(source, /await import\('\.\/server\.ts'\)/)
  const check = spawnSync(process.execPath, ['--check', START], { encoding: 'utf8' })
  assert.equal(check.status, 0, check.stderr)
})
```

In `tests/e2e/mcp-server.test.ts`, add below the `NOISY` constant (line 14):

```ts
const START = fileURLToPath(new URL('../../src/mcp/start.mjs', import.meta.url))
const MANIFEST = JSON.parse(readFileSync(fileURLToPath(new URL('../../.claude-plugin/plugin.json', import.meta.url)), 'utf8')) as { version: string }
```

and add this test after the stdio-guard test (line 115):

```ts
test('start.mjs runs the server: initialize answers with the manifest version, and stdout stays protocol-only', async () => {
  const root = tmpRoot()
  const s = start(START, { OMNIS_PROJECT_DIR: root })
  try {
    const reply = await s.call(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0' } }) as { serverInfo?: { name: string; version: string } }
    assert.deepEqual(reply.serverInfo, { name: 'omnis-swarm', version: MANIFEST.version })
    for (const line of s.stdoutLines) assert.doesNotThrow(() => JSON.parse(line), `non-JSON on stdout: ${line}`)
  } finally {
    await s.stop()
    rmSync(root, { recursive: true, force: true })
  }
})
```

Before writing it, read the `start()` helper at line 16 and check what `s.call` resolves to. If it resolves to the whole JSON-RPC message rather than `result`, read `.result.serverInfo` instead. Use whichever shape the other tests in the file already use.

- [ ] **Step 2: Run to see them fail.**
Run: `node --test tests/mcp/node-version.test.ts tests/e2e/mcp-server.test.ts`
Expected: FAIL. `Cannot find module .../node-version.mjs` and `.../start.mjs`.

- [ ] **Step 3: Implement.** `src/mcp/node-version.mjs`:

```js
// Plain JavaScript on purpose: start.mjs imports this before anything TypeScript loads, so it must parse on any Node.

/** A one-line complaint if `version` (like "v22.4.0") can't run TypeScript files directly, else null. */
export function nodeVersionProblem(version) {
  const m = /^v?(\d+)\.(\d+)/.exec(version)
  const major = m === null ? 0 : Number(m[1])
  const minor = m === null ? 0 : Number(m[2])
  const ok = major >= 24 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18)
  return ok ? null : `omnis-swarm needs Node 22.18 or newer (24 recommended); found v${version.replace(/^v/, '')}`
}
```

`src/mcp/node-version.d.mts`:

```ts
/** A one-line complaint if `version` (like "v22.4.0") can't run TypeScript files directly, else null. */
export function nodeVersionProblem(version: string): string | null
```

`src/mcp/start.mjs`:

```js
// The MCP server's entry point: `node start.mjs`. Plain JavaScript so a Node too old to strip types still runs it and
// says why, instead of failing on the .ts file before any check could run. Writes nothing to stdout.
import { nodeVersionProblem } from './node-version.mjs'

const problem = nodeVersionProblem(process.versions.node)
if (problem !== null) {
  process.stderr.write(`${problem}\n`)
  process.exit(1)
}
await import('./server.ts')
```

In `src/mcp/server.ts`, delete line 4 (`import { nodeVersionProblem } from './node-version.ts'`) and lines 9-13 (the `versionProblem` block). Keep `import './stdio-guard.ts'` as the first import. Change the header comment to `/** OmnisSwarm MCP server, started by start.mjs. Logs only to stderr; stdout carries the protocol. */`. Then delete `src/mcp/node-version.ts`:

```bash
git rm src/mcp/node-version.ts
```

- [ ] **Step 4: Run to see them pass, then the gate.**
Run: `node --test tests/mcp/node-version.test.ts tests/e2e/mcp-server.test.ts && npm run typecheck && npm test && npm run test:mod`
Expected: PASS. If typecheck can't resolve `node-version.mjs`, check the `.d.mts` sits next to it with the same base name. `tsconfig.json` uses `nodenext`, which pairs them.

- [ ] **Step 5: Commit**

```bash
git add src/mcp tests/mcp/node-version.test.ts tests/e2e/mcp-server.test.ts
git commit -m "Check the Node version from a plain JS launcher, where an old Node can still run it"
```

Report to the integrator: `plugin.json` `mcpServers.omnis-swarm.args` must become `["${CLAUDE_PLUGIN_ROOT}/src/mcp/start.mjs"]` (Task 1).

---

### Task 3: The guard's origin check survives an install id

**Files:**
- Modify: `src/core/recording.ts:35-38`
- Test: `tests/core/recording.test.ts`

**Interfaces:**
- Produces: `guardVerdict(tool: string, origin: string, self: string): 'pass' | 'deny'` (same signature). It now compares the names before any `@`.

- [ ] **Step 1: Write the failing test.** Append to `tests/core/recording.test.ts`:

```ts
test('the guard matches this plugin by name with or without an @marketplace suffix, on either side', () => {
  assert.equal(guardVerdict(RECORD, 'omnis-swarm@omnis-swarm', 'omnis-swarm'), 'pass')
  assert.equal(guardVerdict(RECORD, 'omnis-swarm', 'omnis-swarm@omnis-swarm'), 'pass')
  assert.equal(guardVerdict(FEED, 'omnis-swarm@other-market', 'omnis-swarm@omnis-swarm'), 'pass')
  // Look-alikes stay out: a longer name, our name after the @, an empty origin.
  assert.equal(guardVerdict(RECORD, 'omnis-swarm-evil', 'omnis-swarm'), 'deny')
  assert.equal(guardVerdict(RECORD, 'evil@omnis-swarm', 'omnis-swarm'), 'deny')
  assert.equal(guardVerdict(RECORD, '', 'omnis-swarm'), 'deny')
  assert.equal(guardVerdict(RECORD, 'engine', 'omnis-swarm'), 'deny')
})
```

- [ ] **Step 2: Run to see it fail.**
Run: `node --test tests/core/recording.test.ts`
Expected: FAIL on the first assertion (`'deny' !== 'pass'`).

- [ ] **Step 3: Implement.** Replace `guardVerdict` in `src/core/recording.ts`:

```ts
/** A plugin name without an `@marketplace` suffix. Plugin names can't contain `@`, so the part before it is the name. */
const bareName = (name: string): string => name.split('@', 1)[0] ?? ''

/**
 * An internal tool may be called only from this plugin's own hooks. Every other tool is not the guard's business.
 * Both names come from the host: $.plugin.name and next.origin.plugin are the manifest name today, and the match
 * also holds if either ever carries the install id (`omnis-swarm@omnis-swarm`).
 */
export function guardVerdict(tool: string, origin: string, self: string): 'pass' | 'deny' {
  if (!INTERNAL_TOOL.test(tool)) return 'pass'
  return origin !== '' && bareName(origin) === bareName(self) ? 'pass' : 'deny'
}
```

`recording.ts` is in `tsconfig.mod.json`. `String.prototype.split` is a plain web API, so the mod rules allow it.

- [ ] **Step 4: Run to see it pass, then the gate.**
Run: `node --test tests/core/recording.test.ts && npm run typecheck && npm test && npm run test:mod`
Expected: PASS, including the existing guard tests at lines 47-52 and `src/mod/guard.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/core/recording.ts tests/core/recording.test.ts
git commit -m "Let the guard recognise the plugin by name when the host adds the marketplace"
```

---

### Task 4: A render that throws gets its own note

**Files:**
- Modify: `src/mod/pane-model.ts:11` (the `Degraded` type)
- Modify: `src/mod/pane-pull.ts:12,105-113` (`periodFailed` takes a reason)
- Modify: `src/mod/pane-draw.ts:28-31,46,161-163` and `show()` (`RENDER_FAILED_TEXT`, `safeFrameAt`, `waitingText`)
- Modify: `src/mod/pane.ts:12,66` (`ui.render` uses `safeFrameAt`)
- Create: `src/mod/pane-draw.test.ts` (kit test)
- Modify: `docs/design/pane.md` §9, the degraded-note line (469)

**Interfaces:**
- Produces: `type Degraded = 'too-large' | 'unreadable' | 'render-failed'`; `periodFailed(s: PullState, host: PullHost, stop: () => void, why?: Degraded): void` (default `'unreadable'`); `RENDER_FAILED_TEXT: string`; `safeFrameAt(now: number): Frame | null`.

- [ ] **Step 1: Write the failing kit test.** Create `src/mod/pane-draw.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'
import { emptyState, type SwarmState } from '../core/fold.ts'
import { emptyModel } from './pane-model.ts'
import { resetRuntime, rt } from './pane-runtime.ts'
import { RENDER_FAILED_TEXT, safeFrameAt, waitingText } from './pane-draw.ts'
import { KIT } from './test-engine.ts'

// An agent entry that is null makes render() throw (it reads fields off every agent), as a render bug would.
const broken = (): SwarmState => ({ ...emptyState('s1'), agents: { a1: null } }) as unknown as SwarmState

test('a render that throws marks the pane render-failed, and the note says so instead of "Waiting for the swarm"', KIT, async () => {
  resetRuntime('command')
  rt.size = { columns: 120, rows: 44 }
  rt.model = { ...emptyModel(), swarm: 's1', state: broken() }
  expect(safeFrameAt(1_000)).toBe(null)
  expect(rt.model.degraded).toBe('render-failed')
  expect(waitingText()).toBe(RENDER_FAILED_TEXT)
  expect(RENDER_FAILED_TEXT.includes('Waiting for the swarm')).toBe(false)
})

test('the next frame that draws clears render-failed', KIT, async () => {
  resetRuntime('command')
  rt.size = { columns: 120, rows: 44 }
  rt.model = { ...emptyModel(), swarm: 's1', state: emptyState('s1'), degraded: 'render-failed' }
  expect(safeFrameAt(1_000)).not.toBe(null)
  expect(rt.model.degraded).toBe(null)
})

test('an unreadable read still says "Waiting for the swarm"', KIT, async () => {
  resetRuntime('command')
  rt.model = { ...emptyModel(), degraded: 'unreadable' }
  expect(waitingText()).toBe('⚠ Waiting for the swarm…')
})
```

- [ ] **Step 2: Run to see it fail.**
Run: `npm run test:mod`
Expected: FAIL. `pane-draw.ts` has no export `RENDER_FAILED_TEXT` / `safeFrameAt`. If the first test then fails because `render()` does not throw on `broken()`, change `broken()` to `{ ...emptyState('s1'), agents: { a1: null }, byName: { a: 'a1' } }`. Confirm it throws by calling `render` directly in a scratch test before you move on.

- [ ] **Step 3: Implement.**

`src/mod/pane-model.ts:11`:

```ts
/** Why the pane shows its last good state: a reply too big to send, one that failed to read, or a render that threw. */
export type Degraded = 'too-large' | 'unreadable' | 'render-failed'
```

`src/mod/pane-pull.ts`: change the import on line 12 to `import { applyReply, feedArgs, markDegraded, type Degraded, type PaneModel } from './pane-model.ts'` and `periodFailed` to:

```ts
export function periodFailed(s: PullState, host: PullHost, stop: () => void, why: Degraded = 'unreadable'): void {
  try {
    stop()
    s.model = markDegraded(s.model, why).model
    host.invalidate()
  } catch {
    // Nothing more to do: the next ui.render starts over.
  }
}
```

`src/mod/pane-draw.ts`: import `markDegraded` from `./pane-model.ts` (add it to the existing import from that file, or add one), then replace `waitingText` (lines 28-31):

```ts
/** What the pane says when a render threw: not a read problem, so not "Waiting for the swarm". */
export const RENDER_FAILED_TEXT = "⚠ Couldn't draw the swarm. Trying again…"
export const waitingText = (): string =>
  rt.model.degraded === 'render-failed'
    ? RENDER_FAILED_TEXT
    : rt.model.degraded !== null
      ? '⚠ Waiting for the swarm…'
      : rt.model.swarm === null ? 'No swarm yet. One starts with the first agent, or with omnis_swarm_init.' : 'Reading the swarm…'
```

In `frameAt`, line 46, keep `'render-failed'` out of the header notes (render's `Notes.degraded` doesn't take it, and a frame that draws has nothing to report):

```ts
  const frame = render(state, viewOf(pinned), now, rt.size, { degraded: degraded === 'render-failed' ? null : degraded, degradedAgents, hiddenFinished, replay }, budgetFps(rt.renderAvgMs))
```

Add after `frameAt`:

```ts
/** frameAt for the paths with no catch of their own: a throw marks the pane render-failed and gives null, so the caller draws the note. */
export function safeFrameAt(now: number): Frame | null {
  try {
    const frame = frameAt(now)
    if (frame !== null && rt.model.degraded === 'render-failed') rt.model = { ...rt.model, degraded: null }
    return frame
  } catch {
    rt.model = markDegraded(rt.model, 'render-failed').model
    return null
  }
}
```

In the frame-loop catch (line 162): `periodFailed(rt, host, stopFrames, 'render-failed')`. In `show()`, replace `const frame = frameAt(now)` with `const frame = safeFrameAt(now)`.

`src/mod/pane.ts`: add `safeFrameAt` to the import on line 12 and change line 66 to `const frame = safeFrameAt(started)`. Leave `frameAt` in the import only if something else in the file still uses it.

`docs/design/pane.md` line 469: replace it with

```
  1. the degraded note, `⚠ Swarm too large to draw (n agents)` or `⚠ Waiting for the swarm…`, in `STATUS.warn`.
     A render that throws has no header to put a note in: the pane body is the line `⚠ Couldn't draw the swarm.
     Trying again…` (dim text, as the other waiting lines), until a frame draws again;
```

- [ ] **Step 4: Run to see it pass, then the gate.**
Run: `npm run typecheck && npm test && npm run test:mod`
Expected: PASS, including the existing `pane-pull.test.ts` periodFailed test at line 60 (its default reason is still `'unreadable'`).

- [ ] **Step 5: Commit**

```bash
git add src/mod/pane-model.ts src/mod/pane-pull.ts src/mod/pane-draw.ts src/mod/pane.ts src/mod/pane-draw.test.ts docs/design/pane.md
git commit -m "Say the pane couldn't draw when a render throws, rather than blaming the swarm"
```

---

### Task 5: Plugin icon (omnis-designer)

**Files:**
- Create: `assets/icon.svg`

**Interfaces:**
- Produces: `assets/icon.svg`, which Task 1 names as `"icon": "./assets/icon.svg"` and Task 7's README shows with `![OmnisSwarm](assets/icon.svg)`.

**Brief for the designer.** The platform takes any image path inside the plugin and lists SVG, PNG, JPEG, GIF and WebP. It sets no size. Only Anthropic's directory reads the icon; Claude Code doesn't show it. Deliver one hand-written SVG:

- Square `viewBox="0 0 512 512"` with `width="512" height="512"`. Self-contained: no `<script>`, no external `href`, no embedded raster, no fonts (draw letterforms as paths if you use any). Under 16 KB.
- Reads at 32×32: one silhouette, two or three colours from the pane palette in `docs/design/pane.md` §3 (`CANVAS`, `ACCENT`, a status colour). Works on both light and dark backgrounds, so give it its own filled background shape rather than relying on transparency.
- The subject is the swarm: a few linked nodes around a lead, in the pane's globe style. **Not Clawd and nothing derived from it.** Clawd is Anthropic's mascot and we have no permission (`.superpowers/sdd/clawd-usage-research.md`). An original robot is fine if it doesn't share Clawd's silhouette or colours.
- Colour-blind safe under deuteranopia and protanopia (§11 checklist).

- [ ] **Step 1:** Write `assets/icon.svg`.
- [ ] **Step 2:** Check it. Run `node -e "const s=require('fs').readFileSync('assets/icon.svg','utf8'); if(/<script|href=\"http|<image/i.test(s)||s.length>16384) throw new Error('icon breaks the brief'); console.log('ok', s.length)"`. Expected: `ok <bytes>`. Draw it with `scripts/preview.ts` or a browser at 512 and 32 px, and attach both renders to the report.
- [ ] **Step 3: Commit**

```bash
git add assets/icon.svg
git commit -m "Add the plugin icon"
```

---

### Task 6: Refresh the vendored types and warn when they fall behind

**Files:**
- Modify: `types/claude-code/index.d.ts`, `types/claude-code-tools/index.d.ts`, `types/claude-code-mcp/index.d.ts` (refresh to 2.1.308)
- Modify: `tests/core/vendored-types.test.ts`

**Interfaces:**
- Produces: a `node:test` diagnostic (a warning, not a failure) when `.claude-plugin/types/claude-code/index.d.ts` names a newer Claude Code than `types/claude-code/index.d.ts`.

**Where the warning lives, and why:** in the suite, as a diagnostic. Validate can't run our code. A runtime warning would bother users about a file only developers use. A script nobody runs gets forgotten. The engine rewrites `.claude-plugin/types/` every time it loads the mod from this folder, so comparing two first lines catches the lag on the next `npm test` without spawning `claude`. It's a warning, not a failure, so a Claude Code update never turns the gate red by itself.

- [ ] **Step 1: Write the test.** Append to `tests/core/vendored-types.test.ts` (it already imports `test`, `assert`, `readFileSync`, `join`, `dirname`, `fileURLToPath` and defines `typesDir`):

```ts
import { existsSync } from 'node:fs'

const WRITTEN_BY = /^\/\/ Written by Claude Code (\d+)\.(\d+)\.(\d+)\./
const versionOf = (file: string): [number, number, number] | null => {
  const m = WRITTEN_BY.exec(readFileSync(file, 'utf8').split(/\r?\n/, 1)[0] ?? '')
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])]
}
/** Negative when a is older than b. */
const compareVersions = (a: readonly number[], b: readonly number[]): number => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!

test('compareVersions orders major, then minor, then patch', () => {
  assert.ok(compareVersions([2, 1, 307], [2, 1, 308]) < 0)
  assert.ok(compareVersions([2, 2, 0], [2, 1, 999]) > 0)
  assert.equal(compareVersions([2, 1, 308], [2, 1, 308]), 0)
})

test('the vendored types are not older than the ones the engine last laid down (warns, never fails)', t => {
  const engineFile = join(typesDir, '..', '.claude-plugin', 'types', 'claude-code', 'index.d.ts')
  if (!existsSync(engineFile)) {
    t.skip('no engine-laid types here (they appear once Claude Code loads the mod from this folder)')
    return
  }
  const vendored = versionOf(join(typesDir, 'claude-code', 'index.d.ts'))
  const engine = versionOf(engineFile)
  assert.ok(vendored !== null && engine !== null, 'both type files start with a "Written by Claude Code x.y.z." line')
  if (compareVersions(vendored, engine) < 0) {
    t.diagnostic(`WARNING: types/claude-code is from Claude Code ${vendored.join('.')}, the engine laid down ${engine.join('.')}. ` +
      'Refresh: copy .claude-plugin/types/claude-code{,-tools,-mcp}/index.d.ts over types/ (keep the vendored headers), then npm run check.')
  }
})
```

Move the `existsSync` import up into the file's existing `node:fs` import line.

- [ ] **Step 2: Run it and see the warning.**
Run: `node --test tests/core/vendored-types.test.ts`
Expected: PASS, with a `# WARNING: types/claude-code is from Claude Code 2.1.307, the engine laid down 2.1.308` diagnostic.

- [ ] **Step 3: Refresh.**

```bash
cp .claude-plugin/types/claude-code/index.d.ts types/claude-code/index.d.ts
```

`types/claude-code-tools/index.d.ts` and `types/claude-code-mcp/index.d.ts` carry a hand-written "Vendored from…" header above the engine text. Copy the engine body under the existing header, and update the version the header names to 2.1.308. Diff before and after, and say in the report what changed in the API (`git diff --stat types/` and the names of any added or removed members).

- [ ] **Step 4: Gate, warning gone.**
Run: `npm run typecheck && node --test tests/core/vendored-types.test.ts && npm test && npm run test:mod`
Expected: PASS, no WARNING diagnostic. If typecheck fails on a changed engine API, stop and report the errors. Don't fix mod code in this task: those files belong to other tasks.

- [ ] **Step 5: Commit**

```bash
git add types tests/core/vendored-types.test.ts
git commit -m "Refresh the engine types to 2.1.308 and warn in the suite when they fall behind"
```

---

### Task 7: README and third-party notices (omnis-writer)

**Files:**
- Create: `README.md` (repo root, which is the plugin root)
- Create: `THIRD-PARTY-NOTICES`

**Interfaces:**
- Consumes: the facts below. Read the cited files to confirm them; don't take this list on trust.
- Produces: `README.md` of at least 40 words outside code blocks (the validate `README_MISSING` check). Optional: reworded marketplace and plugin description strings, in the report, for Task 1.

Invoke the **writing-no-slop** skill first. British English, Rob's voice.

**README must cover, in this order:**

1. What it is, in two or three sentences: swarm coordination for Claude Code (topology, shared memory, a task board), all recorded to an event log that a live, read-only pane draws. Show the icon: `![OmnisSwarm](assets/icon.svg)`.
2. Requirements: Claude Code 2.1.271 or later (`userConfig.options` needs it, per plugins-reference), and Node 22.18 or newer on PATH, 24 recommended (Task 2's check). Say what an old Node looks like: the server fails to start and `/mcp` shows the one-line reason.
3. Install: `/plugin marketplace add Fortitude-Group/OmnisSwarm`, then `/plugin install omnis-swarm@omnis-swarm`, or in one go `/plugin install omnis-swarm --marketplace Fortitude-Group/OmnisSwarm`. The repo is private, so you need read access on GitHub. Updates: the version is pinned, so `claude plugin update omnis-swarm@omnis-swarm` picks up a release once the version goes up.
4. Commands: `/omnis pane`, `/omnis style`, `/omnis replay`, `/omnis export gif`, `/omnis budget [usd]`, and `/omnis-swarm:watch`. Take each one's exact behaviour and arguments from `src/mod/commands.ts`, `src/mod/pane-commands.ts`, `src/mod/replay-command.ts`, `src/mod/export-command.ts`, `src/mod/budget-command.ts` and `commands/watch.md`.
5. The budget guard and its defaults, from `.claude-plugin/plugin.json` `userConfig` and `src/core/budget.ts`: agent time-box 30 min (warned at two thirds), agent budget $5 approximate (warned at three fifths), swarm budget $20 (warns at half; past it the lead can't start new agents until `/omnis budget <usd>` raises it). Say the dollar figures are estimates from token counts and `src/core/prices.ts`.
6. Settings (`userConfig`), one line each: `panel` (`command` default, `auto`, `off`), `budgetAgentMinutes`, `budgetAgentUsd`, `budgetSwarmUsd`, with their ranges. Where to change them: `/config`, or `/plugin` → OmnisSwarm → configure.
7. Limits, said plainly:
   - The pane draws about 45 to 50 agents doing real work. Past that it shows "Swarm too large to draw". The feed reply is capped at 40,000 bytes (`FEED_REPLY_MAX`, `src/core/feed-reply.ts`). If Task 9 hasn't landed when you write this, ask the lead which figure to give.
   - Each recorder event and each pane pull is an MCP tool call, so it raises PreToolUse hooks. If you have a catch-all PreToolUse **command** hook, each of those calls starts a process. The pane pulls up to four times a second while it's visible and slows to one every 1.5 s once the swarm goes quiet (`src/mod/pane-pull.ts`).
   - `MAX_MCP_OUTPUT_TOKENS`: what it governs and when you'd raise it, from `docs/spikes/2026-10-21-recorder-live.md` around line 137.
8. The robot skin: `/omnis style` offers a robot node style. The Clawd skin is Anthropic's mascot, used here for private use only, until Anthropic gives permission or we ship an original skin. Take the wording from `.superpowers/sdd/clawd-usage-research.md` and check the skin names in `src/render/sprites.ts` and `docs/design/pane.md` §12.4.
9. What it runs and sends (the directory's security scan asks for this, and it's honest anyway): a local Node MCP server; files written only under `<project>/.omnis-swarm/`; no network calls. Check `src/mcp/**` for any `fetch` or `http` before you claim this, and say what you checked.
10. Licence: proprietary (`UNLICENSED`), and see `THIRD-PARTY-NOTICES`.

**THIRD-PARTY-NOTICES:** a plain-text file. A short header line, then a section for Spleen 8x16 2.2.0 by Frédéric Cambus (https://github.com/fcambus/spleen), BSD 2-Clause, what we use it for (glyphs in rasterised frames, the GIF export; generated into `src/render/font/spleen8x16.ts` by `scripts/build-font.ts`), followed by the full licence text copied verbatim from `src/render/font/LICENSE-spleen.txt`. Check `src/` and `scripts/` for any other third-party material (`grep -ri "licen[cs]e\|copyright" src scripts`) and list what you find, or say there is none.

- [ ] **Step 1:** Write both files.
- [ ] **Step 2:** Run `claude plugin validate .` and confirm the `README_MISSING` line is gone. Count the words outside code blocks; there must be at least 40.
- [ ] **Step 3: Commit**

```bash
git add README.md THIRD-PARTY-NOTICES
git commit -m "Add the README and third-party notices"
```

---

### Task 8: Integrate and accept the install (integrator, then lead/Rob)

**Files:** merges only, plus `CLAUDE.md` per Rob's decision (see "Needs Rob's decision").

- [ ] **Step 1: Merge wave 1, in this order:** Task 3, 2, 6, 9 (if done), 4, 5, 7. Then apply Task 1 on `master`. Run the gate after each merge: `npm run typecheck && npm test && npm run test:mod`.
- [ ] **Step 2: Clear the CLAUDE.md warning** as Rob decides. Recommended: the file is untracked, so a plain move does it: `mv CLAUDE.md .claude/CLAUDE.md`. Claude Code reads `./.claude/CLAUDE.md` as project instructions too, so nothing is lost.
- [ ] **Step 3: Validate clean.** Run `claude plugin validate .` and paste the full output into the report, unfiltered. Expected: no `⚠` and no `✘`. Then run `git stash -u` (or `git worktree add ../omnis-clean master`) and validate the clean tree too.
- [ ] **Step 4: Install probe from a git URL** (copies into the cache the way a GitHub install does, without pushing):

```bash
cd /c/projects/personal/OmnisSwarm
git clone --bare . "$TEMP/omnis-probe.git"
claude plugin marketplace add "file:///$(cygpath -m "$TEMP/omnis-probe.git")"
claude plugin install omnis-swarm@omnis-swarm
claude plugin list --json
ls -la ~/.claude/plugins/cache/omnis-swarm/omnis-swarm/*/
ls ~/.claude/plugins/cache/omnis-swarm/omnis-swarm/*/node_modules 2>/dev/null | head
```

If `marketplace add` refuses a `file://` URL, push to `master` and use `Fortitude-Group/OmnisSwarm` instead. Pushing is allowed: we push straight to master.

Record: the install id, the cache path, the version folder name (expect `0.1.0`), whether `node_modules` appeared and how big it is (`du -sh`), and how long the install took. **If `node_modules` holds `typescript`, stop and report to the lead.** That's a Rob decision (see below), not something to fix here.

- [ ] **Step 5: Live check in a session** started from a scratch folder with no `--plugin-dir` (or the dev copy will shadow the install): `/mcp` lists `plugin:omnis-swarm:omnis-swarm` connected; `/omnis pane` opens the pane; ask for two background agents and watch them appear (that proves `omnis_record` passed the guard under the installed name); ask the model to call `omnis_record` directly and see it refused with the `DENY_REASON` text.
- [ ] **Step 6: Clean up the probe:** `claude plugin marketplace remove omnis-swarm` (this uninstalls the plugin), then `rm -rf "$TEMP/omnis-probe.git"`.
- [ ] **Step 7: Push.** `git push origin master`.

---

### Task 9 (optional, recommended): Compact the spend list in trimmed feed replies

**Files:**
- Modify: `src/core/feed-reply.ts` (`cut()`, new `compactSpend`)
- Test: `tests/core/feed-reply.test.ts`

**Interfaces:**
- Produces: `compactSpend(spend: SwarmState['spend']): SwarmState['spend']` and `SPEND_BUCKET_MS = 10_000`, both exported from `src/core/feed-reply.ts`.

- [ ] **Step 1: Write the failing tests.** Append to `tests/core/feed-reply.test.ts`, and add `compactSpend` and `SPEND_BUCKET_MS` to its import from `../../src/core/feed-reply.ts` and `BURN_WINDOW_MS` from `../../src/core/stats.ts`:

```ts
const inWindow = (spend: { at: number; usd: number }[], latest: number) =>
  spend.filter(s => s.at >= latest - BURN_WINDOW_MS).reduce((t, s) => t + s.usd, 0)

test('compactSpend keeps only the burn window and merges it into 10 s buckets, losing at most one bucket of edge', () => {
  const spend = Array.from({ length: 3000 }, (_, i) => ({ at: 1_000_000 + i * 200, usd: 0.001 }))
  const latest = spend.at(-1)!.at
  const out = compactSpend(spend)
  assert.ok(out.length <= BURN_WINDOW_MS / SPEND_BUCKET_MS + 1, `${out.length} buckets`)
  assert.ok(out.every(s => s.at >= latest - BURN_WINDOW_MS - SPEND_BUCKET_MS))
  const before = inWindow(spend, latest)
  const after = inWindow(out, latest)
  assert.ok(after <= before + 1e-9 && before - after <= (SPEND_BUCKET_MS / 200) * 0.001 + 1e-9, `${before} vs ${after}`)
  assert.deepEqual(compactSpend([]), [])
})

test('a busy 10-agent swarm with ten minutes of calls still gets a state, not too-large', () => {
  const state = bigState(10, 0)
  state.spend = Array.from({ length: 3000 }, (_, i) => ({ at: 1_000_000 + i * 200, usd: 0.001 }))
  const r = freshReply('big', 1, state)
  assert.equal(r.kind, 'state')
  assert.ok(r.kind === 'state' && isSwarmState(r.state, 'big'))
  assert.ok(Buffer.byteLength(JSON.stringify(r)) <= FEED_REPLY_MAX)
})
```

- [ ] **Step 2: Run to see them fail.**
Run: `node --test tests/core/feed-reply.test.ts`
Expected: FAIL. `compactSpend` isn't exported, and with it stubbed the second test gets `'too-large'`.

- [ ] **Step 3: Implement** in `src/core/feed-reply.ts`. Import `BURN_WINDOW_MS` from `./stats.ts` and add:

```ts
/** Width of the buckets a trimmed reply merges per-call spend into. */
export const SPEND_BUCKET_MS = 10_000

/**
 * The per-call spend list as a trimmed reply sends it: only the burn window before the latest entry (all the pane
 * reads), merged into SPEND_BUCKET_MS buckets stamped at their earliest call, so the burn can only read a little low.
 */
export function compactSpend(spend: SwarmState['spend']): SwarmState['spend'] {
  if (spend.length === 0) return []
  let latest = -Infinity
  for (const s of spend) if (s.at > latest) latest = s.at
  const buckets = new Map<number, { at: number; usd: number }>()
  for (const s of spend) {
    if (s.at < latest - BURN_WINDOW_MS) continue
    const key = Math.floor(s.at / SPEND_BUCKET_MS)
    const b = buckets.get(key)
    if (b === undefined) buckets.set(key, { at: s.at, usd: s.usd })
    else {
      b.at = Math.min(b.at, s.at)
      b.usd += s.usd
    }
  }
  return [...buckets.values()].sort((a, b) => a.at - b.at)
}
```

In `cut()`, change the return to `return { ...state, agents, byName, links, edits, feed: last(state.feed, keep.feed), spend: compactSpend(state.spend) }`. `cut()` only runs once the untrimmed state is over the cap, so a reply that fits is still sent untouched. Update the `freshReply` doc comment to say the spend list is compacted at every trimming stage.

- [ ] **Step 4: Run to see them pass, then the gate.** Run `node --test tests/core/feed-reply.test.ts && npm test && npm run test:mod`. Expected: PASS, including the existing ceiling tests (they have little spend, so their numbers shouldn't move; if they do, report the new figures).
- [ ] **Step 5: Commit**

```bash
git add src/core/feed-reply.ts tests/core/feed-reply.test.ts
git commit -m "Send only the burn window of per-call spend when a feed reply has to be trimmed"
```

---

### Task 10 (optional): Warm the renderer when the pane opens

**Files:**
- Modify: `src/mod/pane-draw.ts` (`warmRenderer`, called from `openPane`)
- Test: `src/mod/pane-draw.test.ts`

**Interfaces:**
- Consumes: Task 4's `pane-draw.ts` and `pane-draw.test.ts`.
- Produces: `warmRenderer(size: Size): void`.

- [ ] **Step 1: Write the failing kit test.** Append to `src/mod/pane-draw.test.ts`, and add `warmRenderer` to the import from `./pane-draw.ts`:

```ts
test('warming the renderer draws a throwaway frame and leaves the pane state alone', KIT, async () => {
  resetRuntime('command')
  const before = JSON.stringify({ model: rt.model, last: rt.last, spot: rt.spot, tween: rt.tween })
  warmRenderer({ columns: 120, rows: 44 })
  expect(JSON.stringify({ model: rt.model, last: rt.last, spot: rt.spot, tween: rt.tween })).toBe(before)
})
```

- [ ] **Step 2:** Run `npm run test:mod`. Expected: FAIL, no export `warmRenderer`.
- [ ] **Step 3: Implement** in `src/mod/pane-draw.ts`. Import `makeEvent` from `../core/events.ts` and `foldAll` from `../core/fold.ts` (both are in `tsconfig.mod.json`), and `Size` from `../render/types.ts`:

```ts
/** Three agents, enough to run the graph, spotlight and feed paths once. */
const warmState = () => foldAll('warm', ['a1', 'a2', 'a3'].map(id =>
  makeEvent({ type: 'agent.started', swarm: 'warm', src: 'recorder', agent: id, data: { name: id, role: 'coder', description: '', parent: 'lead' } })))

/** Draws one throwaway frame so the first real one isn't JIT-cold. Keeps nothing and never throws. */
export function warmRenderer(size: Size): void {
  try {
    render(warmState(), { pinned: null, spotlight: null, pulses: [], lagMs: 0, tween: null, style: rt.style, still: false, budget: null }, Date.now(), size)
  } catch {
    // The first real frame reports a render problem; warming has nothing to add.
  }
}
```

Check the `View` fields against `viewOf` (line 25) and match them exactly. In `openPane`, after `startLive(...)`, add `(rt.host ?? hostOf($)).after(0, () => warmRenderer(rt.size ?? { columns: 120, rows: 44 }))`, so the warm-up runs on `$.clock` after `open` returns and never in the render hook.

- [ ] **Step 4:** Run `npm run typecheck && npm test && npm run test:mod`. Expected: PASS. Then compare the first frame's time with `node scripts/bench-render.ts` before and after, and report both numbers.
- [ ] **Step 5: Commit**

```bash
git add src/mod/pane-draw.ts src/mod/pane-draw.test.ts
git commit -m "Draw one throwaway frame when the pane opens so the first real one isn't cold"
```

---

### Task 11 (optional): Engine-level timing harness, outside the suite

**Files:**
- Create: `scripts/bench-engine.ts`, `bench/pane-tick.test.ts`

**Interfaces:**
- Consumes: `src/mod/test-engine.ts` (`opened`, `KIT`), `scripts/test-mod.ts`'s launcher logic (copy it, don't import it, since that script runs on import).

`scripts/bench-render.ts` already times `render()` directly. This harness times what the engine adds on top: a pull through the stub MCP server, `ui.render`, and a blit, all under `claude plugin test`. It lives in `bench/` so neither `npm test` (`tests/**`) nor `npm run test:mod` (stages `.claude-plugin`, `hooks`, `types`, `src`, `tests/fixtures`) ever picks it up.

- [ ] **Step 1: Spike (10 minutes, time-boxed).** Find out whether a kit test's `console.log` reaches `claude plugin test`'s output. Write a one-line kit test in a scratch stage and run `claude plugin test <stage>`. If nothing comes through, write timings with `expect(...)` failure messages instead, or stop and report that the harness isn't feasible. Report which.
- [ ] **Step 2:** Write `bench/pane-tick.test.ts`. Use `opened($, on, true)` from `src/mod/test-engine.ts`, advance the mock clock 250 ms at a time for 200 ticks, time each `clock.advance` with `performance.now()`, and print mean, median and p95 in the way the spike found works.
- [ ] **Step 3:** Write `scripts/bench-engine.ts`. Copy the stage-and-launch logic from `scripts/test-mod.ts` (the `SHIPPED` list plus `bench/`), run `claude plugin test` on the stage, print the output, and clean up the stage in a `finally`.
- [ ] **Step 4:** Run `node scripts/bench-engine.ts` twice and report both runs. Confirm `npm test && npm run test:mod` don't run it.
- [ ] **Step 5: Commit**

```bash
git add scripts/bench-engine.ts bench/pane-tick.test.ts
git commit -m "Add an engine-level pane timing harness, kept out of the suites"
```

---

## Needs Rob's decision

1. **Untracked `CLAUDE.md` at the root** makes validate warn in this working copy (it isn't in git, so installs never see it). **Recommend:** move it to `.claude/CLAUDE.md`. Claude Code still loads it as project instructions, and validate stops warning. The alternative is to accept that the warning shows only in dev checkouts.
2. **Dev dependencies on users' machines.** If Task 8's probe shows Claude Code installing `typescript` into the cache (the lockfile at the plugin root triggers an install), **recommend** moving the plugin into a `plugin/` subfolder with its own dependency-free layout. Only do that if the probe says so. It's churn, so don't do it speculatively. Cheaper fallback: accept the install (it's capped at 60 s and runs no scripts).
3. **Node floor.** The plan keeps what phase 1 allowed (22.18+, 23.6+, 24+) and fixes the message to match. `package.json` `engines` says `>=24`. **Recommend** keeping 22.18 as the real floor, since it's what users have, and leaving `engines` as the dev floor. If you'd rather support only what CI runs, change both to 24.
4. **Version pinning.** `plugin.json` pins `0.1.0`, so users get nothing until it's bumped. **Recommend** keeping the pin and bumping it with each release you mean people to take. The new e2e test keeps `server.ts`'s `serverInfo.version` in step with it.
5. **Task 9's status.** The ledger has it as optional. Fact 11 shows a busy 10-agent swarm can already fail a fresh pull. **Recommend** doing it in this phase.
6. **Icon need.** Only Anthropic's directory shows the icon, and a private marketplace never does. **Recommend** keeping Task 5 small (one SVG), so it's ready if the plugin ever goes to the directory.
