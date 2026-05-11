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
pithos --help-json
pithos init --fresh
```

## Scope

This package owns Pithos DB schema, seeded built-ins, task/run transitions, graph invariants, and the agent/operator CLI surface. `pdx` supervises live processes and reuses this package through its typed library boundary; Spawner only renders and launches harness sessions.

## Output modes

`pithos --help` prints human-readable CLI help. `pithos --help-json` prints the machine-readable command tree used by Spawner prompt generation.

Pithos separates protocol commands from context commands:

- Lifecycle/protocol commands such as `task claim`, `task enqueue`, `task complete`, and `run upsert` return JSON by default because agents need stable ids, tokens, and transition results.
- Read-only context commands such as `task inspect`, `graph inspect`, and `briefing` render readable Markdown/text by default. Pass `--json` for the full structured object.

Examples:

```sh
pithos task inspect <task-id>
pithos task inspect <task-id> --json
pithos graph inspect --scope <scope-id>
pithos graph inspect --scope <scope-id> --json
pithos briefing --agent war
pithos briefing --agent war --json
```

## Task graph, chains, and source links

`pithos task enqueue` accepts `--chain auto|none|held|source` and defaults to `auto`.

- Dependencies (`--depends-on <task-id>`) block claimability until upstream tasks are `done`.
- Source links are non-blocking provenance; they connect related work without affecting claimability.
- `--chain auto` preserves the current chain from the actor run. Ordinary held work becomes an implicit dependency; held escalations with a source route follow-up back to that source.
- `--chain none` disables implicit chaining. Use it alone for unrelated work, or with `--depends-on <task-id>` for manual-only dependencies.
- `--chain held` and `--chain source` are advanced fail-loud modes for callers that require a held task or held escalation source.

Enqueue JSON includes `chain` metadata with the selected policy, applied decision, held/source task ids, implicit dependencies, and final dependency ids.

## Scope lifecycle

- `pithos scope list` shows active scopes; pass `--all` to include archived history.
- `pithos scope archive <scope-id>` archives referenced repo/worktree scopes and physically deletes never-used ones.
- Re-running `pithos scope upsert` for the same repo/worktree path reactivates an archived scope.

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
