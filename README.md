# Pithos

Local control plane for coordinating Claude Code agents.

Pithos is a small SQLite-backed CLI plus a thin agent spawner. Agents (Pandora, Envy, workers) register runs, claim fenced tasks, heartbeat, attach artifacts, and complete or fail — all through one `pithos` process per mutation. Nothing else writes to the database.

- **`pithos`** — the state CLI. Owns the SQLite store, queue, leases, events, artifacts, briefing.
- **`pandora-spawn`** — the agent spawner. Owns templates, manifest config, launcher recipes, hooks, and the harness adapter that builds the `claude` argv.

The two communicate only via the `pithos` CLI subprocess. The spawner never imports SQLite.

## Repo layout

```text
pithos/
  README.md            # this file
  CONTRIBUTING.md      # build, verify, commit hygiene
  AGENT_LOOP.md        # autonomous slice-loop runbook for agents
  AGENTS.md            # non-negotiable engineering rules
  mvp-spec.md          # product/domain spec
  technical-design.md  # implementation contracts
  spawner-spec.md      # @pithos/spawner spec
  ambition.md          # long-term direction (don't overbuild)
  tasks.md             # primary tracer-bullet slice queue
  tasks-adhoc.md       # ad-hoc observability/repair slices (priority)
  packages/
    cli/               # @pithos/cli — the pithos bin
    spawner/           # @pithos/spawner — the pandora-spawn bin
  scripts/             # operator scripts (e.g. pandora-start.sh)
  references/          # prior-art copies; read-only
```

## Quick start

```sh
pnpm install
pnpm run build      # builds both packages and links pithos + pandora-spawn on PATH
pithos --help
pandora-spawn templates list
```

Bring up Pandora for the current repo:

```sh
scripts/pandora-start.sh
```

This initialises the store, upserts a repo scope, installs hooks (where the global `~/.claude/settings.json` is writable), spawns Pandora into a detached tmux session, and attaches.

On Nix systems where `~/.claude/settings.json` is a read-only home-manager symlink, install hooks via the Claude Code plugin instead — see [`plugin/README.md`](plugin/README.md).

## Documents

| File                  | Purpose                                                                          |
| --------------------- | -------------------------------------------------------------------------------- |
| `AGENT_LOOP.md`       | Autonomous loop spec: how agents pick slices and drive `tasks.md` forward        |
| `AGENTS.md`           | Non-negotiable engineering rules (fail loudly, strict IO, observability)         |
| `CONTRIBUTING.md`     | Setup, verify, commit hygiene, where to look                                     |
| `mvp-spec.md`         | MVP product/domain spec                                                          |
| `technical-design.md` | Technical contracts and DB/CLI shape                                             |
| `spawner-spec.md`     | `@pithos/spawner` (`pandora-spawn`) package spec                                 |
| `ambition.md`         | Long-term direction; do not overbuild from it                                    |
| `tasks.md`            | Numbered tracer-bullet implementation slices; primary queue                      |
| `tasks-adhoc.md`      | Ad-hoc observability/repair slices; actioned before the primary queue           |
| `packages/cli/README.md`     | `pithos` CLI usage and surface                                            |
| `packages/spawner/README.md` | `pandora-spawn` CLI usage, templates, hooks                               |
| `plugin/README.md`           | Claude Code plugin — declarative hook install (Nix-safe)                  |
