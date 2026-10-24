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

The version is pinned (0.4.0 right now) and goes up with each release. This picks a release up, but only once the version number has moved:

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

On a subscription (Pro, Max and so on) the dollar limits make no sense: you've paid already, and what actually runs out is your 5-hour window. So once Claude Code reports that window, the two dollar limits switch off. You still see the costs, the time-box still applies, and `/omnis budget` shows the window's use instead of a budget. The `billing` setting overrides the guesswork either way.

Warnings show up as toasts. The dollar figures are estimates (hence the ≈ in front of them). They're worked out from token counts and the price table in `src/core/prices.ts`, not read off your bill. Once Claude Code reports its own session cost, the swarm total uses that, counted from when the swarm began.

## The clash guard

When a subagent edits a file, it holds that file until it finishes or goes 10 minutes without editing it. Anyone else who tries (the lead included) is refused with `<holder> is editing <path>. Message them, or wait until they finish.` The lead never holds files. Agents in their own git worktree edit different paths, so they never clash. The pane marks a refusal `! clash (blocked) <path>` on the spotlight card.

One blind spot, and it's a real one. The guard only sees Edit, Write and NotebookEdit, so writes made through Bash (`sed -i`, `>`, `mv`) sail straight past it.

## Stuck nudges

An agent counts as stuck if its last 5 tool calls failed, or it ran the same tool on the same thing 4 times with no edit in between. It's asked once to step back and try another approach, or report to main. The lead gets a one-line note, and the pane shows the agent's stuck look while it lasts.

## The run report

Every run leaves a short markdown report in `.omnis-swarm/reports/<swarm>-<yyyymmdd>-<hhmm>.md`. It covers who ran, the outcome, time, approximate cost, tokens, files edited, problems (budget guard, clashes, stuck nudges, failures), routing savings if OmnisRouter answered, and tasks. It's written when a run goes quiet (30 seconds after the last subagent finishes), when `omnis_swarm_end` is called, and on `/omnis report`. The lead gets a one-line pointer, not the report.

## The verification gate

A task can't be marked done while the build or tests fail. When `omnis_task_update` sets `state: "done"`, the server runs the gate first, and the task only closes if it passes.

**Where.** In the task's worktree (the `worktree` on this call, else the one stored on the task), or the project root if it has none. A worktree has to be the project or one of its registered git worktrees.

**What.** The `gateCommand` setting, if you've set one. Otherwise the first of these it finds in that folder:

1. `scripts/build-test.ps1` → `pwsh -NoProfile -File scripts/build-test.ps1`
2. `scripts/build-test.sh` → `bash scripts/build-test.sh`
3. a `check` script in `package.json` → `npm run check`
4. a `test` script in `package.json` (not npm's "no test specified" placeholder) → `npm test`
5. exactly one `*.slnx`, else exactly one `*.sln` → `dotnet test <file>`

Nothing found? The task closes and the reply says no gate was run. The command never comes from a tool argument, so a model can't pick what runs.

**How long.** `gateMinutes`, 10 by default. Past that the whole process tree is killed, and a timeout is treated like a failure. One gate per folder at a time, three at most across folders. For long runs the server sends a progress ping every 30 seconds (`gate running, <m> min`), which keeps Claude Code from giving up on the call.

**What happens.** With `verifyGate` on `block` (the default), a failed gate leaves the task in its state and the reply is an error with the last 40 lines of output. `warn` closes the task anyway and puts the failure in the reply. `off` is the old behaviour: no gate.

**Skipping it.** `skipGate: true` with a `note` (the reason) closes the task without running anything. Only main can do this. A subagent that tries gets `Only main can skip the gate. Report the problem to main instead.`

**Permission.** Before the gate runs, the mod asks your Bash permission rules about the exact command, as if main had typed it into Bash. So:

- An explicit allow rule for the command (say `Bash(npm run check)`) lets it run without a prompt. Add one for your gate, or you'll be asked every time.
- Only an explicit rule counts. An allow that comes from a mode or the sandbox turns into a question for you. In auto mode it's a person who's asked, not the classifier, and where nobody can be asked (headless, a background subagent) it's refused.
- A deny rule refuses the update: `The gate command is not allowed by your permission rules: <command>.`
- The check skips PreToolUse hooks and per-agent limits. It's main's rules, and nothing else.

Worth saying plainly: an allow rule for `npm test` lets the gate run whatever the test scripts (and the tests) contain at that moment. It approves the command, not what's behind it.

**It needs the mod.** No mod, no permission check, so no gate. With mods off, `done` is refused with `The gate needs OmnisSwarm's mod to check permission first, and no check arrived.` Mark the task done with `skipGate` and a note instead. (That check is a speed bump, not a wall: a model that calls the plugin's internal tools on purpose can get past it with mods off.)

**Pinned gates.** The gate's definition (the script, the `package.json` entry it uses, or the command) is pinned when a task is created. If it has changed by the time the task is marked done, `done` is refused with `the gate changed since the task was created`, in `warn` mode too. In a worktree the gate also has to match the project root's copy. So a task whose job is changing the gate script can't pass its own gate, and neither can any open task created before the change. Main closes those with `skipGate`. The pins live in the server's memory, so a server restart drops them.

**Logs and notes.** Every run's output goes to `.omnis-swarm/gates/<swarm>-<task>-<n>.log`, capped at 2 MiB (the middle goes first). If the assignee changed source files and no test files in this swarm, the reply gets one more line: `Note: <assignee> changed <n> source file(s) and no test files.` It never changes the result.

**Stopping.** A gate is killed, tree and all, on its time limit, when the call is cancelled, or when Claude Code closes the server. A hard kill of Claude Code (Task Manager's End task, or `SIGKILL`) can leave a gate running.

## The scope fence

Give a task `owns` on `omnis_task_create` and its agent can only edit those files. Up to 20 patterns, relative to the repo root, with `/` between folders:

- `*` matches anything inside one folder name, `**` any number of folders, `?` one character.
- A trailing `/` means everything under that folder, so `docs/` covers `docs/a/b.md`.

**Who's fenced.** A subagent with at least one task assigned to it that owns paths, in any state (done and failed included). Its fence is all of those tasks' patterns put together. Main is never fenced, and an agent with no such task isn't either.

**What it checks.** Edit, Write and NotebookEdit, across the project and its git worktrees. A path outside all of those (a scratch or temp file) passes. If every fencing task names a worktree, the agent is held to those worktrees too. A path that looks like a Windows short name (`PROJEC~1`, and yes, `notes~2.md` as well) is refused, because it might be another spelling of a fenced file. Use the long name.

**What happens.** `scopeFence` on `block` (the default) refuses the edit with `<path> is outside the files your task owns (<tasks>: <patterns>). Ask main to widen the task, or leave it to the agent that owns it.` `warn` lets it through and tells main. `off` turns the fence off. The fence runs before the clash guard, so a refused edit never holds a file.

**Only main changes it.** A subagent can't set `owns`, `assignee` or `worktree` on a task: `Only main can change what a task owns. Ask main instead.` To free an agent, main clears the task's patterns (`owns: []`) or gives the task to someone else. Reusing an agent's name for new work? Its old tasks still fence it until main does one or the other.

Same blind spot as the clash guard: writes through Bash (`sed -i`, `>`, `mv`) aren't seen.

## Settings

Ten of them, all in `userConfig`:

- `panel`: `command` (the default) opens the pane only when you ask, with `/omnis pane` or `/omnis-swarm:watch`. `auto` also opens it when a swarm starts. `off` never opens it.
- `billing`: `auto` (the default) works it out: a subscription once Claude Code reports your 5-hour or 7-day usage window, pay-as-you-go otherwise. `subscription` turns the dollar limits off. `api` keeps every limit on.
- `budgetAgentMinutes`: the agent time-box, 1 to 1440 minutes. Default 30.
- `budgetAgentUsd`: the agent budget in dollars, above 0 and at most 1000. Default 5.
- `budgetSwarmUsd`: the swarm budget in dollars, above 0 and at most 1000. Default 20.
- `clashGuard`: `block` (the default) refuses an edit to a file another agent holds. `warn` lets the edit go ahead and tells the lead. `off` turns the guard off.
- `verifyGate`: `block` (the default) keeps a task open when its gate fails. `warn` closes it and reports the failure. `off` runs no gate.
- `gateCommand`: the command the gate runs. Empty by default, which means it's detected from the project's files.
- `gateMinutes`: the gate's time limit, 1 to 60 minutes. Default 10.
- `scopeFence`: `block` (the default) refuses an edit outside the files a subagent's task owns. `warn` lets the edit go ahead and tells the lead. `off` turns the fence off.

Change them in `/config`, or under `/plugin` → OmnisSwarm → configure. `/omnis budget <usd>` changes the budget of the swarm that's running and leaves the setting alone.

## Limits

**Swarm size.** The pane draws about 50 to 60 agents doing real work. Past that you get "⚠ Swarm too large to draw" with the agent count, and no graph. Why? Every reply the server sends the pane is capped at 40,000 bytes (`FEED_REPLY_MAX` in `src/core/feed-reply.ts`), because Claude Code swaps anything much over 50,000 characters for a "saved to a file" notice. Older finished agents get left out first, so it's the busy ones that count.

**Hooks.** Each recorder event and each pane pull is an MCP tool call, so each one runs your PreToolUse hooks. Got a catch-all PreToolUse *command* hook? Then every one of those calls starts a process. The pane pulls up to four times a second while it's visible, slows to once every 1.5 seconds once the swarm goes quiet, and doesn't call the server at all while it's hidden (`src/mod/pane-pull.ts` has the details).

**Bash writes.** Neither the clash guard nor the scope fence sees files changed through Bash.

**Gate cleanup off Windows.** Killing a gate's process tree on Linux and macOS has been written but not yet run on either. Everything else about the gate has been tested on Windows only.

**Gate pins.** They're held in the server's memory, so a restart forgets them and tasks created before it lose the changed-gate check.

**`MAX_MCP_OUTPUT_TOKENS`.** This sets Claude Code's cap on MCP tool output, and it applies to the pane's calls exactly as it does to the model's. Past the cap the pane gets the "saved to a file" notice instead of its data, keeps showing the last good state and flags it as degraded. The default is fine, since every reply stays under 40,000 bytes. If you've set it lower than the default, put it back or unset it. Raising it above the default won't let the pane draw bigger swarms, because the 40,000-byte cap is ours, not Claude Code's.

## The robot style

`/omnis pane style robot` draws each agent as a small pixel robot instead of a globe. There's one robot skin at the moment, `clawd`, drawn after Clawd, the Claude Code mascot.

Clawd is Anthropic's character. OmnisSwarm isn't affiliated with or endorsed by Anthropic, and nothing here grants any rights to Clawd. The skin is in here for private use only, until Anthropic gives permission or we ship an original robot of our own. Globes, the default, are all ours.

## What it runs and what it sends

- **A local Node MCP server**, which Claude Code starts and talks to over stdio.
- **One child process: the gate command.** Only when a task is marked done, chosen as described under "The verification gate", in the project or one of its git worktrees. (On Windows, stopping a gate also runs `taskkill` on that gate's own process.) Nothing else is started.
- **Files only under `<project>/.omnis-swarm/`:** the event logs, the shared memory, the current-swarm marker, the gate logs and the GIF exports. The one exception is your `.gitignore`. If `.omnis-swarm/` isn't listed there, the server adds it (and creates the file if you haven't got one). The pane's saved style and pin are kept in Claude Code's own mod state, not in your project.
- **No network calls.** There's no `fetch`, no `http`, `https`, `net`, `tls` or `dgram` import, and no WebSocket anywhere in `src/`.

## Licence

Proprietary (`UNLICENSED`). The third-party material it includes, and that material's licence, are listed in [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES).
