# Pandora's Box

> A local control plane where you talk to **Pandora** and she releases her Evils — Envy, Toil, Greed, War — to do the work.

## About

You chat with **Pandora** in her tmux session. She queues up work; her Evils
claim it, run in their own Claude or Pi harness sessions, and report back.
You don't run shell commands in the loop — Pandora does.

**Key features**

- **One conversation, many runs.** Pandora is the one you talk to. Her Evils
  come and go as work demands.
- **Durable memory.** Every task, design, and decision is stored. Crash
  recovery and audit are free, and Pandora gets sharper as context
  accumulates.
- **Replaceable harnesses.** Claude Code and Pi both work today.
- **tmux-based control plane.** HITL Evils live in named tmux sessions you
  can attach to.

**The Evils**

| Evil    | Mode | Claims             | Role                                                     |
| ------- | ---- | ------------------ | -------------------------------------------------------- |
| Pandora | HITL | `escalate`         | Long-lived. Talks to you. Routes the chain.              |
| Envy    | AFK  | `intake`           | Classifies external signals into follow-up work.         |
| Toil    | AFK  | `triage`           | Decomposes incoming work; routes to design or execute.   |
| Greed   | HITL | `design`, `review` | Produces design briefs and explicitly requested reviews. |
| War     | AFK  | `execute`          | Runs in a repo/worktree and changes code.                |

**Built with**

- [tmux](https://github.com/tmux/tmux) — HITL session host
- [Claude Code](https://docs.claude.com/claude-code) and [Pi](https://pi.dev/) — harness runtimes

## Getting Started

### Prerequisites

- Node `24.15.0` (pinned via Volta in root `package.json`)
- `pnpm` v10+
- macOS or Linux, Git
- `tmux` and `claude` (Claude Code CLI) or `pi` on PATH

### Installation

```sh
git clone https://github.com/codethread/pandoras-box.git
cd pandoras-box
pnpm install
pnpm run build
```

`pnpm run build` links the bins onto your global PATH.

If `pnpm`'s global link doesn't work on your setup (Nix, restricted PATH,
etc.), use the Makefile to symlink the bins into `~/.local/bin` directly:

```sh
make local
```

Requires `~/.local/bin` to be on your `PATH`.

### Configuration

Repo defaults live in [`./templates/`](./templates/) and are documented in
[`./templates/README.md`](./templates/README.md).

Run `pdx init` to create the data dir and seed the bundle-owned canonical
config before Pandora starts:

- `<data-dir>/agents.toml`
- `<data-dir>/templates/`

`pdx init` and `pdx open` always re-seed those bundle-owned files from repo
defaults.

User customisation lives in `<user-data-dir>/`, where `<user-data-dir>` is
`$PDX_USER_DATA_DIR` or defaults to `<data-dir>/config`. That directory is
scaffolded once with `AGENTS.md`, `CLAUDE.md`, and `README.md` so you can `cd`
into it and ask a direct harness session to edit config safely.

Typical files:

- `<user-data-dir>/agents.toml` — optional user-wide manifest partial
- `<user-data-dir>/templates/` — optional user-wide prompt assets
- `<user-data-dir>/scopes/global|repo|worktree/` — scope-kind overrides

Project-local overrides live in `<repo-root>/.pdx/` and are layered for repo
and worktree launches.

You can also ask an agent to reconfigure Pandora's Box for you:

```sh
pdx init
cd ~/.pdx/config
claude
# or your preferred harness
```

Use the scaffolded `AGENTS.md` in that user config directory as the guide.
Validate changes with `pandora-spawn preview`.

Useful reset modes:

- `pdx init` or `pdx open` — re-seed `<data-dir>/agents.toml` and `<data-dir>/templates/`; keep user config, DB, runs, and logs
- `pdx init --clean` or `pdx open --clean` — wipe runtime state only (DB, runs, logs); keep bundle-owned config and user config
- `pdx init --nuke` or `pdx open --nuke` — wipe pdx-owned runtime/bundled state, preserve `<user-data-dir>`, then reseed fresh canonical config

### Uninstall

The supervisor writes its data directory to `~/.pdx`. Remove the bins and
that directory:

```sh
rm -rf ~/.pdx
# if installed via pnpm:
pnpm -r unlink
# if installed via `make local`:
rm ~/.local/bin/{pithos,pdx,pandora-spawn}
```

## Usage

Two commands:

```sh
pdx init    # create editable config without starting Pandora
pdx open    # release the Evils
pdx close   # back in the jar
```

First time meeting her, get the lay of the land:

- _"Tell me about yourself."_
- _"Tell me about scopes, tasks and chains."_
- _"How do we get work done around here?"_

Then put work into the queue through her:

- _"Create a design task in the frontend repo to figure out a WebSocket
  implementation."_
- _"Build out a spec with Greed for our new persistence layer, then queue a
  task for Toil to break it down and delegate execution in a worktree of the
  backend repo."_

Every conversation deposits durable context — scopes, tasks, artifacts,
chain edges — that survives runs. Old work stays queryable, so the next
delegation needs less re-explaining. Pandora gets sharper as you go.

Reviews are explicit work, not automatic gates: ask Pandora or Toil to queue a
`review` task when you want Greed to walk through scoped work with you.

When something goes sideways, she also drives the cleanup:

- _"Go kill Greed, she's chasing the wrong plan."_
- _"Toil's stuck — interrupt her and re-triage."_

**Respawn**: an Evil killed mid-task doesn't lose the work. The supervisor
respawns her with a fresh, blank harness context but the same claimed task,
and she (hopefully) picks up where the previous incarnation left off. Use
kill as a "try again from clean state" lever, not as a delete.

If Pandora herself is wedged, `pdx --help` lists the raw escape hatches.

## Roadmap

Pre-v1; expect breaking changes.

- [ ] First-class recipes — named, repeatable workflows the Evils follow for common shapes of work
- [ ] Promote/demote an Evil between AFK and HITL mid-session
- [ ] Interactive pickers for kill/show/transcript so you don't copy ids by hand
- [ ] Pluggable control-plane backends — swap tmux for Zellij, remote SSH, etc. (the architecture is already decoupled)
- [ ] Dockerized control-plane smoke tests — encapsulate tmux/harness-adjacent runs for safer end-to-end validation

See [open issues](https://github.com/codethread/pandoras-box/issues).

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md), plus:

- `UBIQUITOUS_LANGUAGE.md` — shared domain terms.
- `AGENTS.md` — engineering rules for coding agents working on this repo.
- `specs/README.md` — design specs index.
- `packages/*/README.md` — per-package docs.

## Licence

MIT — see [`LICENCE`](./LICENCE).

## Acknowledgements

> [...] after a while I realized I just wanted someone to talk to, while the system was working. And perhaps, as occasion might demand, someone to yell at.
>
> — Steve Yegge: [Gas Town: from Clown Show to v1.0](https://steve-yegge.medium.com/gas-town-from-clown-show-to-v1-0-c239d9a407ec)

- The Effect community for the patterns this codebase leans on.
- All the AI researchers building amazing LLMs.
