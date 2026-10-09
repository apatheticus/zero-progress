# Live test: Zero Progress with the todo tools on

Goal: prove the bar reads Claude's real todo list, not just the test kit's fake one.
Time: about 15 minutes. Tick each box as you go.

## 0. Start

Run this in a new terminal. It runs the session in this repo, turns the todo tools on, and logs to a file:

```sh
cd /Volumes/Data/dev/zero-progress
CLAUDE_CODE_ENABLE_TODO_TOOLS=1 claude --debug-file /Volumes/Data/scratch/zp-debug.log
```

- [ ] `/plugin` lists `zero-progress` as enabled, and `savvy-progress` is gone.

## 1. No plan: activity bar

Paste:
```
What does hooks/hooks.json contain? One line, no tools besides Read.
```

- [ ] A bar appears titled with your prompt's first line.
- [ ] It shows a sweeping segment and a step count or time, not a percentage.
- [ ] It ends on Done.

## 2. Todo list drives the bar

Paste:
```
Don't edit any files. Make a todo list with these 4 steps, then work through them one at a time, marking each in progress and then done:
1. Count the lines in hooks/register.tsx
2. List every on('...') hook it registers
3. Count the tests in tests/bar.test.ts
4. Summarize in 3 lines
```

- [ ] The bar shows `0/4` (or `1/4`) early, then climbs to `4/4`.
- [ ] It names the current step ("Counting lines…"), not just the prompt.
- [ ] The percentage moves with the count.
- [ ] Claude never calls `mcp__zero-progress__progress`. The todo list is the only source.
- [ ] `/zero-agents` shows a "Plan" section with ✓ and ○ marks.

## 3. Subagents, with and without their own list

Paste:
```
Don't edit any files. Make a 3-step todo list: (1) spawn an Explore subagent to find the longest function in hooks/register.tsx, (2) spawn a general-purpose subagent that makes its own 3-step todo list and uses it to count the tests, constants, and type exports in this repo, (3) combine both answers. Run both subagents in parallel.
```

- [ ] `/zero-agents` opens by itself at the first subagent, or opens when you type it.
- [ ] The Explore row wears the pirate crab.
- [ ] The general-purpose row shows its own `d/3` bar and step name.
- [ ] The main bar does not jump to the subagent's list.
- [ ] If the main turn ends first, the bar reads `Waiting · N`, then Done when the subagents finish.

## 4. Carry over and delete

Paste:
```
Don't edit any files. Make a 3-step todo list: (1) read README.md, (2) read LICENSE, (3) read types/index.d.ts. Do step 1 only, then stop and ask me whether to continue.
```

- [ ] The bar sits at `1/3` and does not show Done.

Then paste:
```
Delete step 2 from the list, then finish step 3.
```

- [ ] It's the same bar (same title), not a new one.
- [ ] The total drops to 2 and ends on Done.

## 5. Dismiss

- [ ] The ✕ on the bar hides it.
- [ ] Your next prompt brings a new bar back.

## 6. Report

If anything fails, run this in a normal terminal and paste the output back:

```sh
grep -iE 'zero-progress|ui.render \(' /Volumes/Data/scratch/zp-debug.log | tail -40
```

Then paste this into the new session, or bring it back to the old one:

```
Zero Progress live test: sections passed: __ / failed: __ . Notes: __
If all passed, add "CLAUDE_CODE_ENABLE_TODO_TOOLS": "1" to the env block in ~/.claude/settings.json.
```
