# Pandora's Box - agent orchestration tool

> [...] after a while I realized I just wanted someone to talk to, while the system was working. And perhaps, as occasion might demand, someone to yell at.
>
> -- Steve Yegge: [Gas Town: from Clown Show to v1.0](https://steve-yegge.medium.com/gas-town-from-clown-show-to-v1-0-c239d9a407ec)

## About

Pandora's Box is a multi-agent orchestration system. You talk to a primary agent, **Pandora**, who delegates work to specialist agents called the **Evils** — each handling a focused role such as triage, design, or implementation.

The system stays visible and steerable. Pandora is the main interface, but you can inspect or interact with any agent in the orchestra directly when needed.

`tmux` is the current control plane; shared state and coordination live in the Pithos SQLite store. The control-plane layer is intended to stay replaceable, so agents do not depend on tmux-specific mechanics. Supported harnesses today: Claude Code and Pi.

```mermaid
flowchart TD
    User[User / Adam]
    DB[(Pithos SQLite DB)]

    subgraph TMUX[tmux control plane]
        Pandora[Pandora<br/>Pi]
        Toil[Toil<br/>Claude Code]
        Envy[Envy<br/>Claude Code]
        Other[Other Evils<br/>Claude Code or Pi]

        subgraph WorkerPool[Workers spawned by Envy]
            W1[Worker 1<br/>Claude Code or Pi]
            W2[Worker 2<br/>Claude Code or Pi]
            WN[Worker N<br/>Claude Code or Pi]
        end
    end

    User <--> TMUX
    Pandora <--> Toil
    Pandora <--> Envy
    Pandora <--> Other
    Toil <--> DB
    Envy <--> DB
    Other <--> DB
    Pandora <--> DB
    Envy --> W1
    Envy --> W2
    Envy --> WN
    W1 --> Envy
    W2 --> Envy
    WN --> Envy
```

## Packages

- **`pithos`** — the state CLI. Owns the SQLite store, queue, leases, events, artifacts, and briefing.
- **`pandora-spawn`** — the agent spawner. Owns templates, manifest config, launcher recipes, hooks, and harness argv construction.

Agents register runs, claim fenced tasks, heartbeat, attach artifacts, and complete or fail — all through `pithos`. Nothing else writes to the database.

Supported harnesses:

- Claude Code (`--harness claude`)
- Pi (`--harness pi`)

## Quick start

Prereqs: `tmux` plus at least one supported harness CLI on PATH (`claude`, `pi`, or both).

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

### Harness hooks

Real spawned sessions rely on tiny harness adapters for two jobs:

- **liveness** — native harness activity becomes throttled `pithos heartbeat`
- **clean shutdown** — real session termination becomes `pithos run end --status ended`

Claude Code and Pi use different native hook APIs, but both forward into the same shared dispatcher. The adapters no-op in normal non-Pithos sessions because `pandora-spawn` only activates them when it injects the required `PITHOS_*` environment.

Install per harness:

- **Claude Code** — install the marketplace plugin once:

  ```sh
  /plugin marketplace add https://github.com/codethread/pithos
  /plugin install pithos@codethread/pithos
  ```

  Plugin details: [`packages/spawner/claude-plugin/README.md`](packages/spawner/claude-plugin/README.md).

- **Pi** — spawned sessions inject the extension automatically. Manual/dev install: [`packages/spawner/pi-extension/README.md`](packages/spawner/pi-extension/README.md).

Shared hook details: [`packages/spawner/README.md#harness-hooks`](packages/spawner/README.md#harness-hooks).

## Agent model

All agents are visible through the control plane: tmux-backed sessions plus JSONL session logs. The state layer is deliberately separate from the harness.

Agents fall into two categories:

- **AFK** — away from keyboard. Cheap; we want as many of these as possible.
- **HITL** — human-in-the-loop. Expensive but important.

The point of Pandora's Box is to distill HITL time, maximising busy work while the human provides clear direction.

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

Queue capabilities describe the requested outcome class, not the agent's internal execution style. Pandora does not claim queue work — she coordinates across scopes and capabilities.

```text
pithos enqueue --capability triage     -> Toil claims
pithos enqueue --capability implement  -> Envy claims
pithos enqueue --capability design     -> Greed claims once implemented
```

### Per-agent notes

- **Pandora** — the human-facing bridge. Consumes briefings, inspects tasks/runs/artifacts, decides where attention is needed, and spawns the right specialist. Should not personally track every worker session in context.
- **Toil** — in `~/.pandora` she does broad repo discovery and breakdown; in a concrete repo scope she turns goals into actionable queue work and then exits.
- **Envy** — coordinator, not mutator. Spawns a separate worker session for repo/worktree changes, watches progress, and records the result as a `worker-completion` artifact before completing or failing the task.
- **Worker** — intentionally Pithos-unaware. Performs the mutation, produces a completion report, and exits. Envy translates that result back into Pithos state.
- **Greed** — planned design-quality agent. Will own `design` tasks and run in a more human-in-the-loop style.

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

When in doubt: read the code for exact behavior, the package READMEs for the supported surface, and `AGENTS.md` for engineering invariants.
