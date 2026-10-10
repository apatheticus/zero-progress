# Live test: `/zero-selftest`

Goal: prove the bar reads Claude's real todo list, tools and subagents, not just the test kit's fakes.
The mod runs the test itself, in the session you start it from, and grades it.
Time: about 10 minutes. No input from you after the command.

## Run it

In a new terminal, from this repo:

```sh
cd /Volumes/Data/dev/zero-progress
CLAUDE_CODE_ENABLE_TODO_TOOLS=1 claude --plugin-dir /Volumes/Data/dev/zero-progress
```

Then type `/zero-selftest` and keep your hands off.

- The first line names the plugin folder and version under test. A `--plugin-dir` run shows this repo. Otherwise it's the installed copy.
- It also names the path:
  - **todo:** `TodoWrite` or `TaskCreate` is offered.
  - **progress:** neither is offered, so the bar reads `mcp__zero-progress__progress`. Run without the env var to test this one.

## What it does

It types six prompts, one per step. Each goes in once the session has been quiet for 3 seconds: no main turn and no subagent running.

| Step | Prompt | Checks |
|---|---|---|
| s1 | Read `hooks/hooks.json`, one line | Bar titled with the prompt's first line. `Thinking` or `N steps`, no `%`. Ends on `Done`. |
| s2 | A 4-step plan, one step at a time | Count reaches 4 and only climbs. Names the current step. `%` matches the count. Todo path: the main agent never calls the progress tool. Progress path: it does. Pane shows `Plan · d/4` with ✓ and ○. |
| s3 | A 3-step plan with an Explore and a general-purpose subagent in parallel | Pane opens at the first spawn. Explore wears the pirate crab. The general-purpose row reaches `3/3` with a step name. Main bar stays at 3 steps. `Waiting · N` if the main turn ends first. Ends on `Done`. |
| s4a | A 3-step plan, stop after step 1 | Bar sits at `1/3`, not `Done`. |
| s4b | "Delete step 2 from the list, then finish step 3." | Same bar (same title and start). Total drops to 2. Ends on `Done`. |
| s5 | "Say OK." after the mod dismisses the bar | The bar is gone after the dismiss. The prompt brings a new bar. |

Before s1 it dismisses any old bar. Before s2 it opens the agents pane. Before s3 it closes the pane, so the first spawn has to reopen it.

While the run is live:
- Prompt suggestions are hidden. There is nothing to Tab into.
- `Edit`, `Write`, `NotebookEdit`, `Bash` and `AskUserQuestion` are denied. Nothing gets written or pushed, and no dialog can stall the run.
- A prompt from anyone else (you, a peer session, another plugin) goes through but ends the run as interrupted.
- Each step has 5 minutes. A step that runs over ends the run.

## The report

`~/.claude/zero-progress/selftest-<time>.json` is written after every step, so a crash still leaves evidence. It holds:
- `events`: every turn, todo or progress call, spawn and pane check. Every change the band or the pane drew. A snapshot of the bar and the agents at each step boundary.
- `results`: one row per check, `pass`, `fail` or `skip`, with its evidence.

At the end:
1. The transcript gets one dim line per check (✓ pass, ✗ fail, – skip).
2. The mod sends one last prompt. The model reads the trace and judges each fail and skip: is the mod wrong, or did the model not follow the scenario?
3. The model ends with `Zero Progress self-test: passed __ / failed __ / skipped __. Notes: __`.

A release needs `failed 0`. A skip says why: for example, the pane waits undrawn on a terminal under 144 columns.

On the todo path, if everything passed, the verdict recommends adding `"CLAUDE_CODE_ENABLE_TODO_TOOLS": "1"` to the env block in `~/.claude/settings.json`. Nothing edits that file for you.

## Stop it

`/zero-selftest stop` ends a run at once. It writes a partial report and skips the model review.

## Eyes only (optional)

Two things the trace can't see:
- [ ] On the desktop app, the crab art draws in the band and in the pane rows.
- [ ] A real click on the ✕ hides the bar. The test presses it through the same code, but not with a mouse.
