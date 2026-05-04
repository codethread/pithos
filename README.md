# Pandora's Box

An agent orchestration layer modelled around the 'light-factory' model wherein a user can talk to a primary Agent (Pandora), who will then delegate work via her 'evils' (Envy, Greed, Toil etc).

> [...] after a while I realized I just wanted someone to talk to, while the system was working. And perhaps, as occasion might demand, someone to yell at.
>
> -- Steve Yegge: [Gas Town: from Clown Show to v1.0](https://steve-yegge.medium.com/gas-town-from-clown-show-to-v1-0-c239d9a407ec)

---

- All agents are visible to the user through a control plane (currently only tmux implemented, but design is decoupled for future options)
- Agents communicate through a messaging protocol defined within `pithos` cli (local sqlite db).
- **Pandora** is the primary delegate with other Evils having dedicated roles within the orchestra.
  - **Toil**: _AFK_ - breaks up Pandora's requests into tasks and sends messages them to the correct repos
  - **Envy**: _AFK_ - picks up tasks and spawns workers to complete the task(s)
  - **Greed**: _HITL_ - picks up design tasks and conducts detailed design analysis with you
- Completed work is returned to Pandora as artifacts for review (when needed with you)

Pithos is a small SQLite-backed CLI plus a thin agent spawner (Claude code implemented, Pi agent planned).

Agents register runs, claim fenced tasks, heartbeat, attach artifacts, and complete or fail — all through one `pithos` process per mutation. Nothing else writes to the database.

- **`pithos`** — the state CLI. Owns the SQLite store, queue, leases, events, artifacts, briefing.
- **`pandora-spawn`** — the agent spawner. Owns templates, manifest config, launcher recipes, hooks, and the harness adapter that builds the agent argv.

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

| File                         | Purpose                                                                   |
| ---------------------------- | ------------------------------------------------------------------------- |
| `AGENT_LOOP.md`              | Autonomous loop spec: how agents pick slices and drive `tasks.md` forward |
| `AGENTS.md`                  | Non-negotiable engineering rules (fail loudly, strict IO, observability)  |
| `CONTRIBUTING.md`            | Setup, verify, commit hygiene, where to look                              |
| `mvp-spec.md`                | MVP product/domain spec                                                   |
| `technical-design.md`        | Technical contracts and DB/CLI shape                                      |
| `spawner-spec.md`            | `@pithos/spawner` (`pandora-spawn`) package spec                          |
| `ambition.md`                | Long-term direction; do not overbuild from it                             |
| `tasks.md`                   | Numbered tracer-bullet implementation slices; primary queue               |
| `tasks-adhoc.md`             | Ad-hoc observability/repair slices; actioned before the primary queue     |
| `packages/cli/README.md`     | `pithos` CLI usage and surface                                            |
| `packages/spawner/README.md` | `pandora-spawn` CLI usage, templates, hooks                               |
| `plugin/README.md`           | Claude Code plugin — declarative hook install (Nix-safe)                  |
