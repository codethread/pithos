# @pithos/cli

The `pithos` bin. SQLite-backed local control plane for Claude Code and Pi agents.

`pithos` owns state. Each mutation is a single CLI invocation — register a run, enqueue a task, claim with a fencing token, heartbeat, attach an artifact, complete or fail, sweep stale work, brief Pandora. Nothing else writes to the database; all other agents and tools shell out to this binary.

## Quick reference

```sh
pithos --help                        # top-level command index
pithos <command> --help              # per-command flags + examples + exit codes
```

`--help` is the contract — agents read it instead of memorising flags. If you find yourself wanting a "pithos cheat sheet", improve `--help` instead.

## Surface

- `pithos init` — create or migrate the SQLite store (idempotent).
- `pithos scope upsert --kind {global|repo|worktree} --path <path>` — register the unit-of-work scope.
- `pithos run register|end` — agent session lifecycle.
- `pithos enqueue` — add a task to a scope with a capability and optional repeatable `--depends-on` blockers.
- `pithos claim` — atomic claim of the oldest ready queued task in the requested scope/capability, with lease + fencing token.
- `pithos heartbeat` — extend lease while working; throttled.
- `pithos complete|fail` — terminate a claim, fenced.
- `pithos artifact add` — attach a worker-completion or other artifact to a task.
- `pithos inspect scope|run|task` — read structured state; `inspect task` includes direct dependencies, dependents, unresolved blockers, supersession links, and artifacts.
- `pithos tail [--limit N]` — recent events.
- `pithos sweep` — requeue expired leases, dead-letter exhausted tasks, mark stale runs.
- `pithos briefing --agent pandora` — markdown briefing with `as_of_event_id` watermark plus ready vs blocked queued work.

## Environment

| Variable               | Purpose                                                                          |
| ---------------------- | -------------------------------------------------------------------------------- |
| `PITHOS_DB`            | SQLite path (default `~/.pandora/pithos.sqlite`)                                 |
| `PITHOS_RUN_ID`        | Current run id (set by spawner; consumed by hooks)                               |
| `PITHOS_TASK_ID`       | Current claimed task id                                                          |
| `PITHOS_FENCING_TOKEN` | Current claim's fencing token                                                    |
| `PITHOS_SCOPE_ID`      | Scope hint for the current session                                               |
| `PITHOS_OUTPUT`        | Output-mode hint set by `pandora-spawn` for spawned sessions (currently `json`)  |
| `PITHOS_LOG_LEVEL`     | `trace`/`debug`/`info`/`warning`/`error`/`fatal`/`none`; default `none` (silent) |

## Output and exit codes

Successful structured commands write JSON `{ "ok": true, ... }` to stdout; failures write JSON errors to stderr. `pithos briefing` is the human-facing exception and renders markdown.

| Code | Meaning                   |
| ---- | ------------------------- |
| `0`  | Success                   |
| `1`  | General/user error        |
| `2`  | Validation error          |
| `3`  | Not found                 |
| `4`  | Stale lease/fencing token |
| `5`  | No claimable work         |

## Layout

```text
src/
  main.ts           # entrypoint
  version.ts        # version constant
  cli/              # @effect/cli wiring
  commands/         # one file per command + colocated tests
  db/               # SQLite connection, migrations, row decoders
  domain/           # tagged error + ID + schema types
  errors/           # PithosError taxonomy
  layers/           # Effect Layer composition
  services/         # injected services (clock, ids, fs, exec, db)
```

See `CONTRIBUTING.md` for the quality bar and add-a-command checklist.
