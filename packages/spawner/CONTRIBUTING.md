# Contributing to `@pithos/spawner`

Spawner-specific quality bar and change checklist. Read `README.md` first for what this package does. Root-level rules (`../../AGENTS.md`) apply.

The spawner is glue: it turns a versioned agent template into a session in a real harness. It never touches SQLite directly — state goes through the `pithos` CLI subprocess. The current implementation already uses Effect, `@effect/cli`, schemas, and tagged errors; follow those patterns rather than introducing new ones.

## Quality bar

- Keep the package small and glue-focused. No DB imports.
- Follow the existing pattern when touching modules: Effect-based CLI handlers, schema-decoded boundaries, tagged `SpawnerError` failures.
- Prefer extending the existing harness/template/status seams over inventing new abstractions.
- Tests stay light but real: snapshot/integration smoke for spawn shape plus focused unit tests for harness/template/status parsing.
- Hooks are not tested directly; manual spawn proves they fire.
- Lint and typecheck still apply. No `any`.

If you find yourself adding speculative orchestration beyond the existing harness/template/status seams, **stop**. This is still glue.

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

1. Add a `templates/<agent>.md.tmpl` file.
2. Add an entry under `agents` in `templates/agents.json`. All required fields populated; `harness` present. Use `kind: "claude"` with Claude tool names or `kind: "pi"` with Pi tool names.
3. If the template uses a new include filename, list it in `includes` and reference it as `{{filename.md}}` in the body.
4. Update the snapshot test if you've added a new agent it should cover (one per harness shape is enough).
5. Manual smoke: `pandora-spawn --agent <name> --scope repo:... --preview | jq .`.

## Touching the harness

The real `claude` and `pi` harnesses write a wrapper bash script and launch it via `tmux new-session -d -s pithos-<agent>-<short>`. The detached tmux gives the harness a TTY regardless of how `pandora-spawn` was invoked. Pi session files are explicitly placed under Pi's cwd-encoded default layout (`~/.pi/agent/sessions/--<canonical-cwd>--/<session-id>.jsonl`) so `pi -r` and `pandora-spawn status` can find them.

If you change argv building, prompt position, env injection, or hook wiring:

1. Update `src/harness.ts` and the injected harness service.
2. Update `src/main.ts` envelope shape if you add output fields.
3. Update `README.md` plus the harness-specific README (`claude-plugin/` or `pi-extension/`) when the shared contract changes.
4. Refresh tests/snapshots.
5. Manual real-spawn smoke — confirm the agent actually starts working, not idle at `❯`.
