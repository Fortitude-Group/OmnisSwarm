# OmnisSwarm

![OmnisSwarm](assets/icon.png)

OmnisSwarm gives a Claude Code lead and its agents what a swarm actually needs: a topology, shared memory and a task board. Everything they do goes into an event log in your project, and a live, read-only pane draws that log as it grows. So you watch the swarm work instead of guessing what it's up to.

## What you need

- **Claude Code 2.1.271 or later.** The plugin's settings use `userConfig` options, and older versions don't support them.
- **Node on your PATH:** 22.18 or later on the 22 line, or 23.6 or later. Node 24 is the one to pick if you're installing fresh.

What does a too-old Node look like? The OmnisSwarm server doesn't start, and `/mcp` shows it as failed. The reason is one line in its error output, naming the Node it found. Upgrade Node, restart Claude Code, done.

## Install

The repo is private, so you need read access to `Fortitude-Group/OmnisSwarm` on GitHub first.

```
/plugin marketplace add Fortitude-Group/OmnisSwarm
/plugin install omnis-swarm@omnis-swarm
```

Or in one go:

```
/plugin install omnis-swarm --marketplace Fortitude-Group/OmnisSwarm
```

The version is pinned (0.2.0 right now) and goes up with each release. This picks a release up, but only once the version number has moved:

```
claude plugin update omnis-swarm@omnis-swarm
```

## Commands

- `/omnis pane` opens the live swarm pane, and `/omnis pane close` hides it. If the `panel` setting is `off`, it tells you so and opens nothing.
- `/omnis pane style robot|globe` picks how agents are drawn: globes (the default) or small pixel robots. The choice is saved, and an open pane redraws straight away.
- `/omnis replay [swarm] [speed]` replays a recorded swarm in the pane. Leave the swarm out and you get the most recent one. Speed is 1 to 60, and 10× if you don't say. `/omnis replay stop` goes back to live.
- `/omnis export gif [swarm]` renders a swarm (the most recent, by default) to a looping GIF in `.omnis-swarm/exports/`, drawn in your saved style. It runs in the background and a toast gives you the path when it's written. If the server hasn't answered after 5 minutes, it gives up and says so.
- `/omnis budget` shows the limits, the swarm's spend so far and whether new agents are allowed. `/omnis budget <usd>` sets the swarm budget, above 0 and at most 1000 (`30`, `$30` and `2.50` all work). With no swarm running, it applies to the next one.
- `/omnis report` writes the run report now, without waiting for the swarm to go quiet.
- `/omnis-swarm:watch` does the same as `/omnis pane`. It doubles as a fallback: if mods aren't running in your session, Claude tells you there's no pane to open and that policy settings such as `disableAllHooks`, `allowManagedHooksOnly` or `allowManagedModsOnly` turn them off.

## The budget guard

Three limits, each with a warning before it acts:

| Limit | Default | Warns at | Then |
|---|---|---|---|
| Agent time-box | 30 minutes | two thirds (20 min) | The agent is asked to wrap up, report to the lead and stop. The lead hears about it too. |
| Agent budget | $5 | three fifths ($3) | The same. |
| Swarm budget | $20 | half ($10) | The lead can't start new agents until you raise it with `/omnis budget <usd>`. |

Warnings show up as toasts. The dollar figures are estimates (hence the ≈ in front of them). They're worked out from token counts and the price table in `src/core/prices.ts`, not read off your bill. Once Claude Code reports its own session cost, the swarm total uses that, counted from when the swarm began.

## The clash guard

When a subagent edits a file, it holds that file until it finishes or goes 10 minutes without editing it. Anyone else who tries (the lead included) is refused with `<holder> is editing <path>. Message them, or wait until they finish.` The lead never holds files. Agents in their own git worktree edit different paths, so they never clash. The pane marks a refusal `! clash (blocked) <path>` on the spotlight card.

One blind spot, and it's a real one. The guard only sees Edit, Write and NotebookEdit, so writes made through Bash (`sed -i`, `>`, `mv`) sail straight past it.

## Stuck nudges

An agent counts as stuck if its last 5 tool calls failed, or it ran the same tool on the same thing 4 times with no edit in between. It's asked once to step back and try another approach, or report to main. The lead gets a one-line note, and the pane shows the agent's stuck look while it lasts.

## The run report

Every run leaves a short markdown report in `.omnis-swarm/reports/<swarm>-<yyyymmdd>-<hhmm>.md`. It covers who ran, the outcome, time, approximate cost, tokens, files edited, problems (budget guard, clashes, stuck nudges, failures), routing savings if OmnisRouter answered, and tasks. It's written when a run goes quiet (30 seconds after the last subagent finishes), when `omnis_swarm_end` is called, and on `/omnis report`. The lead gets a one-line pointer, not the report.

## Settings

Five of them, all in `userConfig`:

- `panel`: `command` (the default) opens the pane only when you ask, with `/omnis pane` or `/omnis-swarm:watch`. `auto` also opens it when a swarm starts. `off` never opens it.
- `budgetAgentMinutes`: the agent time-box, 1 to 1440 minutes. Default 30.
- `budgetAgentUsd`: the agent budget in dollars, above 0 and at most 1000. Default 5.
- `budgetSwarmUsd`: the swarm budget in dollars, above 0 and at most 1000. Default 20.
- `clashGuard`: `block` (the default) refuses an edit to a file another agent holds. `warn` lets the edit go ahead and tells the lead. `off` turns the guard off.

Change them in `/config`, or under `/plugin` → OmnisSwarm → configure. `/omnis budget <usd>` changes the budget of the swarm that's running and leaves the setting alone.

## Limits

**Swarm size.** The pane draws about 50 to 60 agents doing real work. Past that you get "⚠ Swarm too large to draw" with the agent count, and no graph. Why? Every reply the server sends the pane is capped at 40,000 bytes (`FEED_REPLY_MAX` in `src/core/feed-reply.ts`), because Claude Code swaps anything much over 50,000 characters for a "saved to a file" notice. Older finished agents get left out first, so it's the busy ones that count.

**Hooks.** Each recorder event and each pane pull is an MCP tool call, so each one runs your PreToolUse hooks. Got a catch-all PreToolUse *command* hook? Then every one of those calls starts a process. The pane pulls up to four times a second while it's visible, slows to once every 1.5 seconds once the swarm goes quiet, and doesn't call the server at all while it's hidden (`src/mod/pane-pull.ts` has the details).

**`MAX_MCP_OUTPUT_TOKENS`.** This sets Claude Code's cap on MCP tool output, and it applies to the pane's calls exactly as it does to the model's. Past the cap the pane gets the "saved to a file" notice instead of its data, keeps showing the last good state and flags it as degraded. The default is fine, since every reply stays under 40,000 bytes. If you've set it lower than the default, put it back or unset it. Raising it above the default won't let the pane draw bigger swarms, because the 40,000-byte cap is ours, not Claude Code's.

## The robot style

`/omnis pane style robot` draws each agent as a small pixel robot instead of a globe. There's one robot skin at the moment, `clawd`, drawn after Clawd, the Claude Code mascot.

Clawd is Anthropic's character. OmnisSwarm isn't affiliated with or endorsed by Anthropic, and nothing here grants any rights to Clawd. The skin is in here for private use only, until Anthropic gives permission or we ship an original robot of our own. Globes, the default, are all ours.

## What it runs and what it sends

- **A local Node MCP server**, which Claude Code starts and talks to over stdio.
- **Files only under `<project>/.omnis-swarm/`:** the event logs, the shared memory, the current-swarm marker and the GIF exports. The one exception is your `.gitignore`. If `.omnis-swarm/` isn't listed there, the server adds it (and creates the file if you haven't got one). The pane's saved style and pin are kept in Claude Code's own mod state, not in your project.
- **No network calls.** There's no `fetch`, no `http`, `https`, `net`, `tls` or `dgram` import, no WebSocket and no child process anywhere in `src/`.

## Licence

Proprietary (`UNLICENSED`). The third-party material it includes, and that material's licence, are listed in [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES).
