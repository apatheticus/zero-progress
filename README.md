# zero-progress

A Claude Code mod: an always-on progress bar above the prompt and a live panel of subagents. No skill needed.

## Install

Type this at the Claude Code prompt in a terminal:

```
/plugin install zero-progress --marketplace apatheticus/zero-progress
```

Answer `y` to add the marketplace, then pick the user scope.

Or from a shell:

```sh
claude plugin marketplace add apatheticus/zero-progress
claude plugin install zero-progress@zero-progress
```

Forked from [savvy-progress](https://github.com/johnnyvizz/claude-kit/tree/main/plugins/savvy-progress) by johnnyvizz (MIT). The drawing code and the crabs are his.

## What the bar shows

Every prompt you type starts a bar. It reads the first source it finds:

1. **The todo list.** With `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`, Claude keeps `TaskCreate`/`TaskUpdate` (or `TodoWrite`) lists. The bar shows done out of total, and names the step in progress.
2. **The `progress` tool.** Without the todo tools, the mod puts its own tool, `mcp__zero-progress__progress`, in front of the model and adds one line to the system prompt asking for it on work with 3 or more steps.
3. **Activity.** With no plan, a segment sweeps across the bar with the step count and elapsed time. No made-up percentage.

When the turn ends, the bar waits for subagents still running ("Waiting · 2"), then settles to Done. A plan with steps left carries over to your next prompt. The ✕ dismisses it.

## The agents panel

`/zero-agents` toggles it. It opens on its own at the first subagent of a task (turn this off in `/config`). It lists the plan, then every subagent, Agent tool and Workflow alike: model, effort, its own plan when it keeps one, context, estimated cost and time. Each crab dresses by model: Fable the astronaut, Opus the detective, Sonnet the chef, Haiku the racer; Explore the pirate, Plan the engineer.

Cost is an estimate from token counts and the `PRICES` table in `hooks/register.tsx`, not a bill.

## Settings

`autoOpen` (default `true`): open the panel at the first subagent of each task.

```json
{ "pluginConfigs": { "zero-progress": { "options": { "autoOpen": false } } } }
```

## Notes

- Uninstall savvy-progress first, or both draw panels: `claude plugin uninstall savvy-progress@claude-kit`.
- The mod API is early access; a Claude Code update can break it.

## Develop

```sh
claude --plugin-dir .          # run it live; edits reload at the end of each turn
claude plugin validate .
claude plugin test .
npx -y -p typescript@5.6.3 tsc -p .   # needs .claude-plugin/types/, written by the first --plugin-dir load
```
