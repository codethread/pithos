# Contributing

This doc is the build/verify/commit baseline for both humans and agents working on Pithos. Engineering rules that are non-negotiable live in `AGENTS.md`.

## Prereqs

- Node LTS (workspace pins `24.15.0` via Volta).
- `pnpm` (workspace pins `10.x` via Volta).
- macOS or Linux. Git.
- For the real Claude harness: `tmux` and `claude` (Claude Code CLI) on PATH.

```sh
pnpm install
pnpm run build
```

`pnpm run build` builds every workspace package and links the `pithos` and `pandora-spawn` bins on global PATH via `package.json#bin`.

## Verify before every commit

```sh
pnpm verify   # lint + typecheck + test + build
```

Or run them individually:

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm run build
```

Checks must be green before every commit. No "leftover issues", no "next commit". Never `--no-verify`. Never disable a failing test to make the bar green.

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

## Doc map

| When you want to… | Read… |
| ---------------- | ----- |
| Understand the product, agent model, and current architecture | `README.md` |
| Understand engineering rules (fail loudly etc) | `AGENTS.md` |
| Touch DB schema, CLI shape, or migrations | `packages/cli/README.md`, `packages/cli/CONTRIBUTING.md` |
| Touch templates, hooks, harness wiring, or session status | `packages/spawner/README.md`, `packages/spawner/CONTRIBUTING.md` |
| Touch the Claude Code plugin manifest or hooks | `packages/spawner/claude-plugin/README.md` |
| Look at prior art | `references/` (read-only) |

## Per-package contributing notes

Each package has its own `CONTRIBUTING.md` with quality bar and add-a-feature checklist:

- `packages/cli/CONTRIBUTING.md` — full Effect quality bar (tagged errors, schemas at IO, structured logs).
- `packages/spawner/CONTRIBUTING.md` — spawner package constraints, change checklist, and harness/template guidance.
