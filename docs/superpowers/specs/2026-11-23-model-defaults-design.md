# Model defaults: a subagent gets a cheaper model when the lead names none

Rob's brief, 23 Nov 2026. Version 0.8.0.

## Why

From Rob's Claude Code logs, 13 to 20 Nov, counted with `scripts/subagent-models.mjs` (each subagent's own assistant
messages record the model that answered; requests counted by unique message id):

- 55 Agent calls. 9 passed `model: sonnet` and answered on Sonnet (256 requests). 2 passed `opus`.
- 44 passed no model. 43 answered on Opus, the main session's model. The one on Haiku was claude-code-guide, whose
  built-in definition sets Haiku.
- The 44 by type: general-purpose 37, Explore 6, claude-code-guide 1.

CLAUDE.md asks the lead to pass a cheaper model for mechanical work. It did 9 times in 55. A written rule is a
request; this makes it a control.

## The mechanism, as the engine allows it

Settled from `.claude-plugin/types/claude-code/index.d.ts` and the sub-agents docs, not guessed.

1. **Where.** `agent.spawn`, not `tool.call`. Its `model` is "the Agent tool's `model` parameter as given ...;
   undefined lets the agent's own model, then the parent's, decide", and "a hook sets this to pick the subagent's
   model". The docs: "A mod's `agent.spawn` hook model replaces the per-invocation parameter". `tool.check` can't change
   a call at all.
2. **Precedence** (docs): the call's `model`, then the agent definition's `model` (including `inherit`), then
   `CLAUDE_CODE_SUBAGENT_MODEL`, then the parent's model. `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` outranks the first two.
   A filled-in `model` is a level-1 choice, so the hook must not fill it when level 2 or 3 already decided.
3. **Built-ins with a model of their own** (docs): claude-code-guide Haiku, statusline-setup Sonnet, web-fetch Haiku.
   general-purpose, Explore, Plan and `claude` follow the order (the parent, in practice).
4. **No API answers a type's own model.** The hook reads the definitions itself with `$.fs`: the project's
   `.claude/agents/` (walking up from the working directory, subfolders included, matched on frontmatter `name:`, else
   the file name), then `<config dir>/agents/`, then for `<plugin>:<name>` the plugin's `agents/<name>.md` (this
   plugin's root, or the install path in `<config dir>/plugins/installed_plugins.json`). A type it can't find and
   isn't a known built-in is left alone. `--agents` and managed-settings agents aren't visible to it: they're left
   alone only if they share a name with nothing it can read, which is the known gap.
5. **Hook order.** "A plugin's registrations nest in order, first outermost." The default hook is registered before
   the spawn hold, so the hold sees the filled-in model and groups on type plus the model that will answer.
6. **Evidence.** `next(e)` answers `{ model, agentId }`, the model core resolved. The event records both, and the
   recorder's `agent.usage` already records the model of every response.

## What it does

On `agent.spawn` (not a fork, a resume, a teammate or a workflow agent), when the call passed no `model`:

1. `CLAUDE_CODE_SUBAGENT_MODEL` or `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` set: leave it (the person chose).
2. Find the first rule that matches the type and description. None, or `none`: leave it.
3. The type's own definition sets `model` (any value, `inherit` too), or the type can't be found: leave it.
4. The chosen model isn't cheaper than the parent's (haiku < sonnet < opus < fable/mythos; an unknown family counts as
   not cheaper): leave it. A default never makes an agent dearer, and filling in the model it would get anyway isn't
   counted as a default.
5. Otherwise spawn with `model` set to the rule's alias and record `model.defaulted`.

Every failure (a read that throws, a bad setting) leaves the call as it was.

## The rules

Setting `modelDefaultRules`, a string. Rules split on `;` or new lines. Each is `<type> = <model>` or
`<type> ~ <words> = <model>`:

- `<type>`: an agent type as the Agent call names it, matched ignoring case, or `*` for any.
- `<words>`: comma-separated words or phrases. The rule matches when the description contains one as whole words,
  ignoring case.
- `<model>`: `haiku`, `sonnet`, `opus`, `fable`, or `none` (leave it alone and stop looking).

The first rule that matches wins. At most 20 rules, 30 words each. A rule that doesn't parse is skipped and shown by
`/omnis models`.

Defaults:

```
Plan = none
* ~ review, security, audit = none
Explore = sonnet
* ~ test, tests, testing, commit, commits, lint, linting, format, formatting, typecheck, run the build, build and test = sonnet
```

Changed from Rob's proposal, with the reason:

- **`build` is out, `run the build` and `build and test` are in.** Against the 44: matching words starting with
  build/test/commit/lint/format moves 13 agents, 7 of them general-purpose "Build chapter verse1", "Build film mode
  core" and the like, which were creative and feature work. The narrow words move 6, all Explore.
- **No `claude-code-guide = haiku`.** Its definition already sets Haiku, so step 3 leaves it alone anyway.

Setting `modelDefaults`: `on` (the default) or `off`, which registers no hook. A call that passes `model` is never
touched, so that's the per-call way out.

## Events and display

`model.defaulted`, recorder, agent-level (`agent` the started agent's id): `{ role, model, rule, resolved? }`. `role`
the type (≤64), `model` the alias (`haiku`|`sonnet`|`opus`|`fable`), `rule` the matching rule as `/omnis models`
prints it (≤120), `resolved` the model core answered (≤64).

The fold keeps the last 200 as `state.defaults` and adds a feed line: `put Explore agent on sonnet (Explore = sonnet)`.
The run report gets a `Model defaults` section, one line per type, model and rule, with the count.

## /omnis models

- `/omnis models`: on or off, the rules numbered, any that didn't parse, how many agents this swarm defaulted.
- `/omnis models on|off`, `/omnis models add <rule>`, `/omnis models remove <n>`, `/omnis models reset`.

It writes the settings with `$.config.set` (`omnis-swarm.modelDefaultRules`, `omnis-swarm.modelDefaults`) and applies
the change at once.

## Subscriptions

Not a refusal, so it applies on a subscription and on API keys alike.

## Not done

- Agents defined with `--agents` or in managed settings aren't read. One that shares a name with a built-in or a file
  the hook can read would be judged by that one.
- A description is a few words the lead chose. The words catch mechanical chores; a general-purpose agent whose
  description is a title ("Build film mode core") is left on the parent's model unless a rule names it.
