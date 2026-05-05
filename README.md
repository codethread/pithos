# Pandora's Box

An agent orchestration layer built around a simple idea: Adam talks to Pandora, Pandora delegates through her evils, and Pithos keeps the shared state visible and inspectable.

> [...] after a while I realized I just wanted someone to talk to, while the system was working. And perhaps, as occasion might demand, someone to yell at.
>
> -- Steve Yegge: [Gas Town: from Clown Show to v1.0](https://steve-yegge.medium.com/gas-town-from-clown-show-to-v1-0-c239d9a407ec)

Pithos is two things:

- **`pithos`** — the state CLI. Owns the SQLite store, queue, leases, events, artifacts, and briefing.
- **`pandora-spawn`** — the agent spawner. Owns templates, manifest config, launcher recipes, hooks, and harness argv construction.

Agents register runs, claim fenced tasks, heartbeat, attach artifacts, and complete or fail — all through `pithos`. Nothing else writes to the database.

Supported harnesses today:

- Claude Code (`--harness claude`)
- Pi (`--harness pi`)
- fake/test harness (`--harness fake`)

## Agent model

All agents are visible through the control plane. Today that means tmux-backed sessions plus JSONL session logs; the design keeps the state layer separate from the harness.

### Implemented roster

| Agent   | Type | Claims      | Current harness | Role |
| ------- | ---- | ----------- | --------------- | ---- |
| Pandora | HITL | —           | Pi              | Global orchestrator. Delegates, inspects, asks questions. |
| Toil    | AFK  | `triage`    | Claude Code     | Breaks goals down, finds repos, enqueues concrete work. |
| Envy    | AFK  | `implement` | Claude Code     | Coordinator. Claims implementation work, spawns workers, reports back. |
| Worker  | AFK  | —           | Claude Code     | Ephemeral executor. Performs repo/worktree mutation, reports, exits. |

### Planned roster

| Agent | Type | Intended claims | Role |
| ----- | ---- | --------------- | ---- |
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

- Claude Code: install the marketplace plugin once — [`packages/spawner/claude-plugin/README.md`](packages/spawner/claude-plugin/README.md)
- Pi: spawned Pithos sessions inject the extension automatically; optional manual/dev install docs live at [`packages/spawner/pi-extension/README.md`](packages/spawner/pi-extension/README.md)
- Shared hook contract: [`packages/spawner/HOOKS.md`](packages/spawner/HOOKS.md)

Claude Code install:

```sh
/plugin marketplace add https://github.com/codethread/pithos
/plugin install pithos@codethread/pithos
```

## Documents

| File | Purpose |
| ---- | ------- |
| `AGENT_LOOP.md` | Autonomous loop: how agents pick slices and drive the queue |
| `AGENTS.md` | Non-negotiable engineering rules |
| `CONTRIBUTING.md` | Setup, verify, commit hygiene, doc map |
| `scripts/tasks.md` | Numbered implementation slices; primary queue |
| `scripts/tasks-adhoc.md` | Ad-hoc observability/repair slices |
| `packages/cli/README.md` | `pithos` CLI surface and runtime contract |
| `packages/cli/CONTRIBUTING.md` | CLI package quality bar and add-a-command checklist |
| `packages/spawner/README.md` | `pandora-spawn` CLI, templates, harnesses, status, session logs |
| `packages/spawner/CONTRIBUTING.md` | Spawner package constraints and change checklist |
| `packages/spawner/HOOKS.md` | Shared harness hook contract |
| `packages/spawner/claude-plugin/README.md` | Claude Code plugin install/use |
| `packages/spawner/pi-extension/README.md` | Pi extension install/use |
| `skills/pithos-cli/SKILL.md` | Agent-facing Pithos CLI orientation skill |
| `references/README.md` | Copied prior art; read-only reference behaviour |
| `.claude/commands/smoke.md` | Claude Code manual smoke-test command |
| `.pi/prompts/smoke.md` | Pi manual smoke-test prompt |

## Current architecture rule of thumb

- Read the code for exact behavior.
- Read package READMEs for the supported surface.
- Read `AGENTS.md` for engineering invariants.
- Treat old planning assumptions as dead unless they still exist in code.
