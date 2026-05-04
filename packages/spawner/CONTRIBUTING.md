# Contributing to `@pithos/spawner`

This package is **intentionally less robust** than `@pithos/cli`. Read `../../docs/specs/spawner-spec.md` §2 before adding anything.

The spawner is glue: it turns a versioned agent template into a Claude session. It never touches SQLite. It calls the `pithos` CLI subprocess for state.

## Quality bar (intentionally low)

- Plain TypeScript and a few small modules. **No Effect plumbing**, no service layers, no DB imports.
- **No tagged-error hierarchy.** Throw with a clear message; the wrapper prints it; the user re-runs.
- **One Vitest snapshot smoke test** (`test/spawn.snap.test.ts`) asserts the rendered prompt + composed argv against a stored snapshot. That is enough.
- Hooks are not tested. They are ~10 lines of bash (`hooks/dispatch.sh`); manual spawn proves they fire.
- Lint and typecheck still apply. No `any`. Beyond that, prefer the smallest correct code.

If you find yourself adding service tags, layers, schemas for in-process data, or speculative abstractions, **stop**. This is glue.

## Build

```sh
pnpm --filter @pithos/spawner build
pnpm --filter @pithos/spawner start -- --agent envy --scope repo:work/example --preview | jq .
```

## Tests

```sh
pnpm --filter @pithos/spawner test
pnpm --filter @pithos/spawner exec vitest run -u   # update snapshot when argv/prompt changes intentionally
```

When the snapshot updates because of a real shape change (new flag, new template, new include), include the snapshot diff in the same commit as the code change.

## Adding a template / agent

1. Add a `templates/<agent>.md.tmpl` file. The frontmatter `agent` must equal the file stem.
2. Add an entry under `agents` in `templates/agents.json`. All required fields populated; `tools` non-empty.
3. If the template uses any new include filename, list it in `includes` and reference it as `{{filename.md}}` in the body.
4. Update the snapshot test if you've added a new agent that the test should cover. (One per harness shape is enough.)
5. Manual smoke: `pandora-spawn --agent <name> --scope repo:... --preview | jq .`.

## Touching the harness

The real Claude harness writes a wrapper bash script and launches it via `tmux new-session -d -s pithos-<agent>-<short>`. The detached tmux gives `claude` a TTY regardless of how `pandora-spawn` was invoked.

If you change the argv, prompt position, or env block:

1. Update `src/harness.ts` (`buildClaudeArgv`, `runClaude`).
2. Update `src/main.ts` envelope shape if you add output fields.
3. Update `../../docs/specs/spawner-spec.md` §8 step 10 + §9.
4. Refresh the snapshot.
5. Manual real-spawn smoke (HITL) — confirm the agent actually starts working, not idle at `❯`.
