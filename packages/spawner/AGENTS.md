# @pithos/spawner agent notes

Tiny TypeScript CLI that turns versioned agent config + prompt templates into an agent-harness session.

## Shape

- Bin: `pandora-spawn`
- Real harnesses: Claude Code and Pi
- Test/debug harness: `fake`
- State boundary: never touch SQLite; call `pithos` CLI subprocess only
- Config API: `templates/agents.json` + `templates/*.md.tmpl` + includes like `_common.md`

## Design notes

- Keep this package simple: the only allowed Effect abstraction is the injected harness service. No DB imports, no daemon logic.
- Fail loudly on bad JSON, unknown template vars, missing template files, bad includes.
- Includes are explicit vars: listing `_common.md` makes `{{_common.md}}` available; placement is controlled by the prompt template.
- `--preview` must not register a run or spawn a harness.

## Manual test

```sh
pnpm --filter @pithos/spawner start --agent envy --scope repo:work/example --preview | jq .
```

With built/link bin:

```sh
pnpm run build
pandora-spawn --agent envy --scope repo:work/example --preview | jq .
```
