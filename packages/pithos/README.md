# @pithos/pithos

Durable Pithos state library and public `pithos` CLI.

## Commands

```sh
pnpm --filter @pithos/pithos build
pnpm --filter @pithos/pithos test
pnpm --filter @pithos/pithos start --help
```

After the root build links bins:

```sh
pithos --help
pithos init --fresh
```

## Scope

This package owns Pithos DB schema, seeded built-ins, task/run transitions, graph invariants, and the agent/operator CLI surface. `pdx` supervises live processes and reuses this package through its typed library boundary; Spawner only renders and launches harness sessions.

## Run transcript metadata

Every run record must include the transcript location needed for later inspection:

- `agent`
- `mode` (`afk` or `hitl`)
- `scope`
- `cwd`
- `sessionId`
- `harnessKind` (`claude`, `pi`, or `system`)
- `sessionLogPath`
- optional `runId` for idempotent upsert

CLI callers provide these fields via `pithos run upsert --agent ... --mode ... --scope ... --cwd ... --session-id ... --harness-kind ... --session-log-path ... [--run ...]`.
