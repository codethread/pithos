# Contributing

Build, verify, and commit baseline. Engineering rules that are
non-negotiable live in `AGENTS.md`.

## Prereqs

- Node `24.15.0` (pinned via Volta in root `package.json`)
- `pnpm` v10+
- macOS or Linux, Git
- For the real Claude harness: `tmux` and `claude` (Claude Code CLI) on PATH

```sh
pnpm install
pnpm run build
```

`pnpm run build` builds every workspace package and links the `pithos`,
`pdx`, and `pandora-spawn` bins onto global PATH via `package.json#bin`.

## Verify before every commit

```sh
pnpm verify   # lint + typecheck + test + build
```

All four must be green. No "leftover issues", no "next commit". Never
`--no-verify`. Never disable a failing test to make the bar green.

To narrow to a single package while iterating:

```sh
pnpm --filter @pithos/pithos test
pnpm --filter @pithos/pdx start --help
pnpm --filter @pithos/spawner start -- preview \
  --agent war --mode afk --scope scope_repo --run run_demo \
  --session-id 123e4567-e89b-12d3-a456-426614174000 --cwd "$PWD"
```

## Commits

- Atomic. One concern per commit.
- Conventional-ish prefix: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`.
- Message body summarises the **why**, not the what — `git diff` is the what.
- Pass messages via heredoc:

  ```sh
  git commit -m "$(cat <<'EOF'
  feat(spawner): tmux-wrap real claude harness

  Detached tmux gives claude a TTY regardless of caller, and a positional
  prompt arg makes the agent start working instead of sitting at the input.
  EOF
  )"
  ```

## Package boundaries

- **Pithos** owns durable DB invariants and run/task transitions.
- **Spawner** is launcher-only glue: manifest validation, prompt rendering,
  harness argv/env construction, and launch metadata. No status, no kill,
  no DB writes.
- **pdx** owns local supervision, Registry state, operator kill, daemon
  status, and supervisor logs.

Runtime process/filesystem/tmux operations go through pdx service
interfaces. Domain/controller code should not import sibling package
internals; consume package-root APIs such as `@pithos/pithos` and
`@pithos/spawner`.

## Doc map

| When you want to…                                  | Read…                    |
| -------------------------------------------------- | ------------------------ |
| Understand the product and Evil model              | `README.md`              |
| Engineering rules (fail loudly, etc.)              | `AGENTS.md`              |
| Domain terms (task, claim, run, escalation, chain) | `UBIQUITOUS_LANGUAGE.md` |
| Design specs                                       | `specs/README.md`        |
| Per-package detail                                 | `packages/*/README.md`   |
