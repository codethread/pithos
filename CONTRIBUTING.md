# Contributing

Build and verify baseline for human contributors. Engineering rules and agent workflow live in `AGENTS.md`.

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

## Package boundaries

See `UBIQUITOUS_LANGUAGE.md` for the control-plane vocabulary and `packages/*/README.md` for package-local developer boundaries. Design-level composition lives in `specs/README.md`.

## Doc map

| When you want to…                                  | Read…                    |
| -------------------------------------------------- | ------------------------ |
| Understand the product and Evil model              | `README.md`              |
| Engineering rules and agent workflow               | `AGENTS.md`              |
| Domain terms (task, claim, run, escalation, chain) | `UBIQUITOUS_LANGUAGE.md` |
| Design specs                                       | `specs/README.md`        |
| Per-package detail                                 | `packages/*/README.md`   |
