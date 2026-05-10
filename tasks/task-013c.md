# Task 013c: Nested pdx CLI and run transcript command

## Status

Complete in current working tree. Re-run full verification before commit.

## Scope

Replace the flat pdx operator API with nested daemon/run/task commands and wire pdx to Pithos transcript metadata plus the Spawner transcript parser.

## Acceptance

- Public commands are:
  - `pdx open`
  - `pdx close`
  - `pdx daemon status`
  - `pdx daemon logs`
  - `pdx run kill <run-id> --reason <text>`
  - `pdx run transcript <run-id> [--limit <n>]`
  - `pdx task kill <task-id> --reason <text>`
- Old commands are removed with no aliases: `pdx status`, `pdx logs show`, `pdx kill --run|--task`.
- Internal daemon entrypoint is `pdx daemon run`; it remains available for `pdx open` and omitted from public help.
- pdx renders an agent before run upsert, persists `harness_kind` and `session_log_path`, then launches the same rendered plan.
- `pdx run transcript` inspects the run, parses non-null transcript metadata, calls `@pithos/spawner.renderSessionTranscript`, and prints the transcript.
- Help text clearly distinguishes daemon supervisor logs from agent harness transcripts.
- Tests cover parsing/help for the new command tree and fail-loud behavior for removed commands.
