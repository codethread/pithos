# Task 013a: Pithos run transcript metadata

## Status

Complete in current working tree. Re-run full verification before commit.

## Scope

Make Pithos runs durably index their harness transcript without nullable launch metadata.

## Acceptance

- `runs` has non-null `harness_kind` and `session_log_path` columns.
- `harness_kind` is parsed as `claude | pi | system`; `session_log_path` is non-empty.
- `system` is reserved for the `pdx` system actor and is rejected by harness transcript parsing with a clear pointer to daemon logs.
- `pithos run upsert` requires `--harness-kind` and `--session-log-path`.
- `RunOutput`, row schemas, library engine input/output, CLI output, and tests include the two fields.
- Existing run lifecycle transitions preserve the transcript metadata unchanged.
- Missing or malformed DB transcript metadata fails loudly at the row/IO boundary.
