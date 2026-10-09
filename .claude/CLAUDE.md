# zero-progress

A Claude Code mod (hooks-module plugin). This repo is the plugin and its own marketplace.

## Layout
- `.claude-plugin/plugin.json`: the manifest. `version` must match the entry in `marketplace.json`.
- `.claude-plugin/marketplace.json`: one entry, `source: "./"`.
- `hooks/register.tsx`: the whole mod.
- `types/index.d.ts`: the `$.state` contract. Every `$.state` key the module uses is declared here.
- `tests/*.test.ts`: run by `claude plugin test`.

## Develop
- Run it live: `claude --plugin-dir /Volumes/Data/dev/zero-progress`. Edits hot-reload at the end of each turn.
- That first load writes `.claude-plugin/types/` (gitignored). `tsc` needs it.

## Check before every commit
```sh
claude plugin validate .
claude plugin test .
npx -y -p typescript@5.6.3 tsc -p .
```

## Release
1. Run `docs/live-test.md` in a real session if the change touches how the bar reads todos, tools or subagents.
2. Bump `version` in both `plugin.json` and `marketplace.json`.
3. Commit and push to `main`.
4. Update the installed copy: `claude plugin marketplace update zero-progress`, then `claude plugin update zero-progress@zero-progress`.

## Gotchas
- The terminal has no `Svg` element. Guard desktop drawing with `e.surface === 'desktop'`.
- The test kit has no `$.state`: tests read what the UI draws (`$.ui.mount` then `findAll({ type: 'Text' })`).
- Hooks that gate a call (`tool.call`, `agent.spawn`) need a `.catch` that passes the call on, so a bug here never blocks a tool.
- The validator only lets `$` reach top-level function declarations.
- The engine writes its MCP tool-name types before this mod registers `progress`, so the `tool.call` matcher casts `TOOL as never`. Keep the cast or `tsc` fails.
