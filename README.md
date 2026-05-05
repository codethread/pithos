# Pandora's Box - agent orchestration tool

> [...] after a while I realized I just wanted someone to talk to, while the system was working. And perhaps, as occasion might demand, someone to yell at.
>
> -- Steve Yegge: [Gas Town: from Clown Show to v1.0](https://steve-yegge.medium.com/gas-town-from-clown-show-to-v1-0-c239d9a407ec)

The idea is you talk with a primary agent, 'Pandora', who will then delegate out your work (via the 'Evils' in Pandora's Box); crucially you are still able to interact with any other agents within the orchestra (light factory).

Different Evils perform different focused roles, such as designing, planning, implementation, etc

At this time the mane control plane is `tmux` but the implementation is such that in theory another control plane (like remove SSH boxes) could be added. The precise mechanics are abstracted from the agents

Again, at this time only Claude Code and Pi agent harnesses are implemented.

## Packages

- **`pithos`** — the state CLI. Owns the SQLite store, queue, leases, events, artifacts, and briefing.
- **`pandora-spawn`** — the agent spawner. Owns templates, manifest config, launcher recipes, hooks, and harness argv construction.

Agents register runs, claim fenced tasks, heartbeat, attach artifacts, and complete or fail — all through `pithos`. Nothing else writes to the database.

Supported harnesses today:

- Claude Code (`--harness claude`)
- Pi (`--harness pi`)

## Agent model

All agents are visible through the control plane. Today that means tmux-backed sessions plus JSONL session logs; the design keeps the state layer separate from the harness.

Agents fall into two categories:

- AFK: away from keyboard, we want as many of these as possible
- HITL: human-in-the-loop, expensive but important

The whole point of Pandora's Box is to distill down the HITL time to maximise busy work while the human user provides clear direction

### Implemented roster

| Agent   | Type | Claims      | Current harness | Role                                                                   |
| ------- | ---- | ----------- | --------------- | ---------------------------------------------------------------------- |
| Pandora | HITL | —           | Pi              | Global orchestrator. Delegates, inspects, asks questions.              |
| Toil    | AFK  | `triage`    | Claude Code     | Breaks goals down, finds repos, enqueues concrete work.                |
| Envy    | AFK  | `implement` | Claude Code     | Coordinator. Claims implementation work, spawns workers, reports back. |
| Worker  | AFK  | —           | Claude Code     | Ephemeral executor. Performs repo/worktree mutation, reports, exits.   |

### Planned roster

| Agent | Type | Intended claims | Role                                                                    |
| ----- | ---- | --------------- | ----------------------------------------------------------------------- |
| Greed | HITL | `design`        | Design/research partner for risky or unclear work. Not yet implemented. |

### Delegation chain

```text
Adam
 │  high-level goal
 ▼
Pandora ─── orchestrates, never owns queue work directly
 │  if scope unknown: spawns Toil in ~/.pandora to break it down
 │  if scope known: goes straight to per-repo Toil
 ▼
Toil ─── discovers repos, decomposes work, enqueues queue-facing tasks
 │
 ▼
Envy ─── claims implement work, spawns workers, watches, reports
 │
 ▼
Workers ─── perform the actual repo/worktree mutation
```

Each handoff is deliberate: Pandora should not burn context on repo discovery, and Envy should not burn context doing the mutation herself.

### Claim routing

Queue capabilities describe the requested outcome class, not the agent's internal execution style.

```text
pithos enqueue --capability triage     -> Toil claims
pithos enqueue --capability implement  -> Envy claims
pithos enqueue --capability design     -> Greed claims once implemented
```

Pandora does not claim queue work. She coordinates across scopes and capabilities.

### Per-agent detail

#### Pandora

Pandora is the human-facing bridge. She consumes briefings, inspects tasks/runs/artifacts, decides where attention is needed, and spawns the right specialist. She should not personally track every worker session in context.

#### Toil

Toil claims `triage`. In `~/.pandora`, she can do broad repo discovery and breakdown. In a concrete repo scope, she turns goals into actionable queue work and then exits.

#### Envy

Envy claims `implement`. She is the coordinator, not the mutating worker. For repo/worktree changes she spawns a separate worker session, watches progress, and records the result as a `worker-completion` artifact before completing or failing the task.

#### Worker

Workers are intentionally Pithos-unaware. They do the mutation, produce a completion report, and exit. Envy translates that result back into Pithos state.

#### Greed

Greed is the planned design-quality agent. She will own `design` tasks and run in a more human-in-the-loop style.

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

This initialises the store, upserts a repo scope, spawns Pandora into a detached tmux session, and attaches.

Harness hook setup:

Real spawned sessions rely on tiny harness adapters for two jobs only:

- liveness: native harness activity becomes throttled `pithos heartbeat`
- clean shutdown: real session termination becomes `pithos run end --status ended`

Claude Code and Pi use different native hook APIs, but both forward into the same shared dispatcher. The adapters no-op in normal non-Pithos sessions because `pandora-spawn` only activates them when it injects the required `PITHOS_*` environment.

- Claude Code: install the marketplace plugin once — [`packages/spawner/claude-plugin/README.md`](packages/spawner/claude-plugin/README.md)
- Pi: spawned Pithos sessions inject the extension automatically; optional manual/dev install docs live at [`packages/spawner/pi-extension/README.md`](packages/spawner/pi-extension/README.md)
- Shared hook details: [`packages/spawner/README.md#harness-hooks`](packages/spawner/README.md#harness-hooks)

Claude Code install:

```sh
/plugin marketplace add https://github.com/codethread/pithos
/plugin install pithos@codethread/pithos
```

## Documents

| File                                       | Purpose                                                                |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| `AGENTS.md`                                | Non-negotiable engineering rules                                       |
| `CONTRIBUTING.md`                          | Setup, verify, commit hygiene, doc map                                 |
| `packages/cli/README.md`                   | `pithos` CLI surface and runtime contract                              |
| `packages/cli/CONTRIBUTING.md`             | CLI package quality bar and add-a-command checklist                    |
| `packages/spawner/README.md`               | `pandora-spawn` CLI, templates, harnesses, hooks, status, session logs |
| `packages/spawner/CONTRIBUTING.md`         | Spawner package constraints and change checklist                       |
| `packages/spawner/claude-plugin/README.md` | Claude Code plugin install/use                                         |
| `packages/spawner/pi-extension/README.md`  | Pi extension install/use                                               |
| `references/README.md`                     | Copied prior art; read-only reference behaviour                        |
| `.claude/commands/smoke.md`                | Claude Code manual smoke-test command                                  |
| `.pi/prompts/smoke.md`                     | Pi manual smoke-test prompt                                            |

## Current architecture rule of thumb

- Read the code for exact behavior.
- Read package READMEs for the supported surface.
- Read `AGENTS.md` for engineering invariants.
