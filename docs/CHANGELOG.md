# Changelog

What changed in each OmnisSwarm release, newest first. The [README](../README.md) has how each part works.

## 0.8.0

**Model defaults.** A confession, because it's the reason this release exists. Our own `CLAUDE.md` tells the lead to pass a cheaper model for builds, tests and commits. We counted what it really did, in our Claude Code logs from 13 to 20 Nov 2026, with `scripts/subagent-models.mjs` (it reads the model each subagent's own responses were answered by):

- 55 Agent calls. 9 passed `model: sonnet` and answered on Sonnet, 256 requests between them. 2 passed `opus`.
- 44 passed no model at all, and 43 of those answered on Opus, the main session's model. The one on Haiku was claude-code-guide, whose built-in definition already sets Haiku.
- The 44 by type: general-purpose 37, Explore 6, claude-code-guide 1.

So the rule was followed about one call in six. A written rule is a request.

The fix: when an Agent call names no model, OmnisSwarm now fills one in from a few rules, and only when the rule's model is cheaper than the lead's and the agent's own definition doesn't set one. By default Explore agents go to Sonnet, and so does any agent whose description says test, commit, lint, format, typecheck, run the build or build and test. Plan agents and anything described as review, security or audit are left alone. So are an explicit `model`, `CLAUDE_CODE_SUBAGENT_MODEL`, forks, resumes, teammates and workflow agents. The feed, the run report and the new `/omnis models` show what it did, and two new settings, `modelDefaults` and `modelDefaultRules`, turn it off or change the rules.

We left `build` out of the default words on purpose. Against those 44 calls it would have moved 13 agents, 7 of them general-purpose ones titled things like "Build film mode core", which were feature work, not running the build. The narrower words move 6, all Explore.

The caveats. Agents defined with `--agents` or in managed settings aren't read, so one that shares a name with a built-in or an agent file is judged by that one. The rules only see the call's description, so a general-purpose agent with a title for a description stays on the lead's model. And we haven't measured it on real runs yet: [[RUN: agents given a model by the defaults, and how many of those finished clean, from the first real runs on 0.8.0]]

## 0.7.0

**The spawn hold.** Start several agents of one type together and the first goes alone. The rest wait until it starts answering (4 minutes at most), then read the prompt cache it wrote instead of each writing their own. `cacheHold: off` turns it off.

## 0.6.3

The pane shows the plugin's version in its header, so you can tell at a glance whether an update has loaded.

## 0.6.2

A wide row of agents wraps onto more lines instead of the robot view giving up and falling back to the agent list.

## 0.6.1

A resumed agent no longer shows up twice. It keeps its name when it comes back in a new swarm.

## 0.6.0

**Model hints.** A new swarm is told which roles finished just as cleanly on a cheaper model in past run reports, and which didn't.
