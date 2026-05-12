# Pandora's Box

> A local control plane where you talk to **Pandora** and she releases her Evils — Toil, Greed, War — to do the work.

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

| Evil    | Mode | Claims     | Role                                                   |
| ------- | ---- | ---------- | ------------------------------------------------------ |
| Pandora | HITL | `escalate` | Long-lived. Talks to you. Routes the chain.            |
| Toil    | AFK  | `triage`   | Decomposes incoming work; routes to design or execute. |
| Greed   | HITL | `design`   | Produces design briefs before execution.               |
| War     | AFK  | `execute`  | Runs in a repo/worktree and changes code.              |

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

The Evils' roster, harness kind, model, and tool surface are currently
hardcoded in [`packages/spawner/templates/agents.json`](./packages/spawner/templates/agents.json).
Edit that manifest (and the matching `*.md.tmpl` template) to change what
Pandora and her Evils run as. A proper config surface is on the roadmap.

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
