# Contributing to `@pithos/spawner`

This package is **intentionally less robust** than `@pithos/cli`. Read `../../docs/specs/spawner-spec.md` §2 before adding anything.

The spawner is glue: it turns a versioned agent template into a Claude Code or Pi session. It never touches SQLite. It calls the `pithos` CLI subprocess for state.

## Quality bar (intentionally low)

- Plain TypeScript and a few small modules. The one allowed Effect abstraction is the injected harness service used to swap Claude/Pi/fake adapters. No DB imports.
- **No tagged-error hierarchy.** Throw with a clear message; the wrapper prints it; the user re-runs.
- Keep tests light: snapshot/integration smoke for spawn shape plus focused unit tests for harness-specific parsing/mapping.
- Hooks are not tested. They are ~10 lines of bash (`hooks/dispatch.sh`); manual spawn proves they fire.
- Lint and typecheck still apply. No `any`. Beyond that, prefer the smallest correct code.

If you find yourself adding speculative abstractions beyond the harness adapter seam, **stop**. This is glue.

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
2. Add an entry under `agents` in `templates/agents.json`. All required fields populated; `harness` present. Use `kind: "claude"` with Claude tool names or `kind: "pi"` with Pi tool names.
3. If the template uses any new include filename, list it in `includes` and reference it as `{{filename.md}}` in the body.
4. Update the snapshot test if you've added a new agent that the test should cover. (One per harness shape is enough.)
5. Manual smoke: `pandora-spawn --agent <name> --scope repo:... --preview | jq .`.

## Touching the harness

The real `claude` and `pi` harnesses write a wrapper bash script and launch it via `tmux new-session -d -s pithos-<agent>-<short>`. The detached tmux gives the harness a TTY regardless of how `pandora-spawn` was invoked. Pi session files are explicitly placed under Pi's cwd-encoded default layout (`~/.pi/agent/sessions/--<canonical-cwd>--/<session-id>.jsonl`) so `pi -r` and `pandora-spawn status` can find them.

If you change argv building, prompt position, env injection, or hook wiring:

1. Update `src/harness.ts` and the injected harness service.
2. Update `src/main.ts` envelope shape if you add output fields.
3. Update `HOOKS.md` plus the harness-specific README (`claude-plugin/` or `pi-extension/`) when the shared contract changes.
4. Update `../../docs/specs/spawner-spec.md` §8 step 10 + §9.
5. Refresh tests/snapshots.
6. Manual real-spawn smoke (HITL) — confirm the agent actually starts working, not idle at `❯`.
