# @pdx/pithos

Developer documentation for the Pithos package: the durable state system for Pandora's Box.

## Package role

`@pdx/pithos` exposes the `pithos` binary and the typed library boundary used by `pdx`.

For the generated CLI surface, use help instead of copying command lists here:

```sh
pithos --help
pithos --help-json
pithos scope --help
pithos run --help
pithos task --help
pithos graph --help
pithos events --help
pithos briefing --help
```

`pithos --help-json` is consumed by Spawner when rendering role-filtered command cards for Agent run prompts.

## What Pithos is

Pithos is the durable source of truth for:

- Scopes
- Agent kinds and Capabilities
- Tasks and Claims
- Runs and Held tasks
- Fencing tokens and Attempts
- Dependencies, Source links, and Supersessions
- Artifacts and Events
- Task graph invariants and text/JSON inspection views

## What Pithos is not

- Not the local supervisor. `pdx` owns Registry state, live process/tmux resources, Kill policy, Cleanup, Interrupt orchestration, and Nudges.
- Not a Harness launcher. Spawner renders prompts, builds Harness argv/env, launches Harness sessions, and parses Harness session logs.
- Not a Control-plane backend. tmux is the current backend for HITL mode; Pithos only stores durable Run metadata.
- Not a prompt/template system. Pithos exposes state transitions and inspection surfaces; Agent instructions live in Spawner templates.

## Relation to other packages

| Package                       | Pithos integration                                               | Boundary                                                            |
| ----------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| `@pdx/pdx`                    | imports `makeEngine` and `liveServices` through the package root | typed in-process durable state transitions; no subprocess parsing   |
| `@pdx/spawner`                | imports `@pdx/pithos/builtins` and calls `pithos --help-json`    | validates render config against built-ins and renders command cards |
| Harness CLIs (`claude`, `pi`) | no direct integration                                            | Harness sessions are represented only by Run transcript metadata    |

The composed behavior is specified in [`../../specs/control-plane-supervision.md`](../../specs/control-plane-supervision.md) and Task graph semantics in [`../../specs/task-graph.md`](../../specs/task-graph.md). Use [`../../UBIQUITOUS_LANGUAGE.md`](../../UBIQUITOUS_LANGUAGE.md) for terms.

## Public package surface

Exported from `@pdx/pithos`:

- CLI helpers: `makePithosCommand`, `runPithosCli`, `renderPithosHelpJson`.
- Engine boundary: `makeEngine`, `Engine`, render helpers for briefing/graph/task inspect text.
- Schema/DB helpers: `migrate`, `openDb`, row schemas, decoded row helpers.
- Chain helpers: chain-policy resolution and graph dependency utilities.
- Config/services/errors: `loadConfig`, `liveServices`, `PithosError`.

Exported from `@pdx/pithos/builtins`:

- built-in Agent kinds
- system actors
- spawnable Agent kinds
- Capabilities
- claim/enqueue authorization contract

Consumers should import from package roots, not sibling `src/*` internals.

## Implemented module design

### `src/main.ts` — process boundary

Loads runtime config from environment, wires live services, and runs the CLI. Unexpected top-level failures are printed as tagged JSON errors.

### `src/config.ts` — runtime config parsing

Parses process environment into typed config:

- `PITHOS_DB` — required database path
- `PITHOS_RUN_ID` — optional default actor Run id for mutating Agent commands

If both `PITHOS_RUN_ID` and `--run` are present for a command, Engine code fails loudly when they conflict.

### `src/cli.ts` — CLI and output contract

Defines the human CLI and machine-readable help tree with `@effect/cli`.

Important details:

- `--help-json` prints the command tree used by Spawner.
- Protocol/state-transition commands return JSON by default for Agent consumption.
- Context commands (`task inspect`, `graph inspect`, `briefing`) render readable text by default and expose `--json` for structured output.
- Payload-bearing task mutations read redirected stdin only when `--stdin` is present and fail on empty/missing stdin.

### `src/engine.ts` — durable state transitions

Owns the Pithos domain API used by both the CLI and `pdx`:

- scope upsert/list/archive, including repo/worktree directory admission checks
- Run upsert/inspect/Cleanup/Interrupt/timeout/launch-abort
- task enqueue/claim/heartbeat/complete/fail/cancel/supersede, including active-scope and repo/worktree directory admission checks
- library-only pdx repair escalation creation with `repair_source` provenance
- artifact add
- graph inspect
- briefing
- event tail
- text renderers for task/graph/briefing views

Engine code opens the SQLite DB, runs migrations, executes transition logic, and closes the DB per operation. Race-sensitive updates run inside SQLite transactions and use fenced preconditions so stale writes fail rather than drifting state. Scope/task admission validates external filesystem state at the Pithos boundary: repo/worktree paths must exist as directories when scopes are upserted and when tasks are enqueued or superseded into those scopes.

### `src/db.ts` — schema and seed data

Defines the SQLite schema and migration entrypoint.

Key tables:

- `scopes`
- `agent_kinds`, `capabilities`, `agent_claims`, `agent_enqueues`
- `runs`
- `tasks`
- `task_dependencies`
- `task_sources`
- `task_supersessions`
- `artifacts`
- `events`

`migrate` enables foreign keys, creates/updates schema, and seeds the built-in global scope, Agent kinds, Capabilities, claim rules, and enqueue rules.

### `src/builtins.ts` — durable built-in contract

Defines the pre-v1 built-in contract for Agent kinds and Capabilities. Spawner validates its manifest against this file, and Pithos seeds/enforces the same contract in SQLite.

### `src/chain-policy.ts` — Task chain rules

Pure helpers for Dependency, Source link, and Supersession behavior:

- `--chain auto|none|held|source` resolution
- implicit Dependency selection
- Source link preservation for Escalation task handoff
- dependency dedupe
- acyclicity checks
- graph closure and unresolved dependency helpers

Use this file for chain semantics before editing Engine enqueue/supersede logic.

### `src/rows.ts` — DB row parsing

Schemas for rows crossing the SQLite boundary. Malformed rows fail with `INTERNAL_ERROR`; missing rows fail with `NOT_FOUND`.

### `src/services.ts` — IO boundary

Defines the service interface used by CLI/Engine code:

- filesystem reads/removes and directory status checks
- stdin reading
- stdout/stderr writing
- ID generation — `task`, `run`, and `artifact` IDs use three random English words (`task_pear-orange-tree`); `event` IDs keep hex (`event_8f64959bbf004fda`)
- clock

`liveServices` is the Node implementation. Tests use deterministic service objects with real isolated SQLite DB files.

### `src/errors.ts` — error contract

Defines `PithosError` and exit-code mapping. Keep new runtime failures tagged with existing machine-readable codes unless a new code is intentionally added.

## DB and invariant notes

Pithos owns durable invariants, not live resource observation. Important rules to preserve:

- A Run may hold at most one Held task (`runs.task_id`).
- A Task has exactly one Capability.
- A Task must reference an existing Scope row; the database foreign key is the integrity backstop for row existence.
- Engine prechecks require the Scope to be active and provide tagged JSON errors for missing or archived scopes.
- Scopes carry an optional `description` field for operator context; set via `--description` on `scope upsert`, surfaced in `scope list` and `briefing` output.
- Repo/worktree Scope paths are validated as directories at scope upsert and task enqueue/supersede time. The filesystem can change later, so pdx still owns launch-time runtime-path checks.
- Claim authorization is enforced by seeded `agent_claims`.
- Enqueue authorization is enforced by seeded `agent_enqueues`.
- Dependencies are satisfied only by upstream Tasks in `done`.
- Source links are non-blocking provenance; `chain_source` supports normal continuation, while `repair_source` points at broken work for supersession/replan.
- Supersessions preserve history while replacing work with a fresh Task.
- Fencing tokens invalidate stale task writes.
- Cleanup is for confirmed natural Run death; Interrupt is for deliberate Kill of a live Run; Cancel is for non-held Task abandonment.

## Environment and runtime files

Required for normal CLI execution:

```sh
export PITHOS_DB=/path/to/pithos.sqlite
```

Optional for Agent commands:

```sh
export PITHOS_RUN_ID=run_...
```

Use isolated DBs for development and smoke tests:

```sh
export PDX_DATA_DIR="$(mktemp -d)/pdx"
export PITHOS_DB="$PDX_DATA_DIR/pithos.sqlite"
mkdir -p "$PDX_DATA_DIR"
pnpm --filter @pdx/pithos start -- init --fresh
```

## Development

```sh
pnpm --filter @pdx/pithos typecheck
pnpm --filter @pdx/pithos test
pnpm --filter @pdx/pithos start -- --help
pnpm --filter @pdx/pithos start -- --help-json
```

Basic isolated CLI check:

```sh
export PITHOS_DB="$(mktemp -d)/pithos.sqlite"
pnpm --filter @pdx/pithos start -- init --fresh
pnpm --filter @pdx/pithos start -- scope list
```

Prefer real isolated SQLite fixtures for behavior tests. Do not replace DB invariant tests with broad mocks.
