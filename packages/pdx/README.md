# @pithos/pdx

Local supervisor for Pandora's Box. `pdx` reconciles durable Pithos state with live AFK processes and HITL tmux sessions.

## Public CLI

```sh
pdx open [--data-dir <path>] [--interval-seconds <n>] [--max-afk <n>]
pdx close [--data-dir <path>]

pdx daemon status [--data-dir <path>]
pdx daemon logs [--data-dir <path>] [--limit <n> | --all] [--since <when>]

pdx run kill <run-id> --reason <text> [--data-dir <path>]
pdx run transcript <run-id> [--data-dir <path>] [--limit <n>]
pdx run show <run-id> [--data-dir <path>]

pdx task kill <task-id> --reason <text> [--data-dir <path>]
pdx task show <task-id> [--data-dir <path>]

pdx --help-json
```

`pdx --help-json` prints a machine-readable command tree used for Pandora prompt generation. Default `pdx --help` remains human-readable.

`pdx daemon status` reports supervisor state: daemon liveness, registry entries, queue counts, and cap usage.

`pdx daemon logs` prints pdx supervisor JSONL logs. These are control-plane logs, not agent harness transcripts.

`pdx run transcript` reads the harness transcript for a Pithos run using the run's durable `harness_kind` and `session_log_path` metadata. System runs are not harness transcripts; use `pdx daemon logs` for the `pdx` system run.

`pdx run show` switches the current tmux client to the supervised session for a run. `pdx task show` resolves the active holder run for a task, then switches to that tmux session. If a task is unclaimed or queued/done/failed already, `pdx task show` reports that status and exits non-zero.

`pdx run kill` and `pdx task kill` interrupt Pithos state first, then kill the live process/tmux resource. `pdx task kill <task-id>` means “kill the live run currently holding this task”; it is not task cancellation.

## Internal entrypoint

`pdx daemon run` is used by `pdx open` inside the daemon tmux session. It is intentionally omitted from public help and should not be invoked manually outside supervisor startup/debugging.

## Development

```sh
pnpm --filter @pithos/pdx typecheck
pnpm --filter @pithos/pdx test
pnpm --filter @pithos/pdx start --help
pnpm --filter @pithos/pdx start -- daemon --help
pnpm --filter @pithos/pdx start -- run --help
```

Use injected Pithos/Spawner/Process/Tmux services in tests; do not require real model credentials or live harness binaries.
