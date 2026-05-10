# Slice 12e — Error wording + graph performance smoke

## What to build

Add final v1 hardening tests for greppable error wording and a small graph performance smoke.

Error wording/code assertions:

- `STALE_TOKEN_RACE`
- `VALIDATION_ERROR` for:
  - `PITHOS_RUN_ID` conflict
  - capability scope mismatch
  - claim scope mismatch
  - non-held `pdx task kill <task-id>` pointer to `pithos task cancel`
  - heartbeat `--task`/`--token` atomicity
- `NO_CLAIMABLE_WORK`
- corrupt Supervisor log JSONL
- invalid `pdx daemon logs --since`

Performance smoke:

- Create a few hundred tasks with representative dependency/supersession edges.
- `pithos graph inspect --all` completes within a CI-safe threshold.
- This is not load testing; threshold should catch accidental quadratic blowups without being flaky.

## Test focus

- Error responses keep machine-readable codes and helpful messages.
- Error messages use Ubiquitous Language terms.
- Performance smoke is deterministic and not sensitive to local machine noise.

## Acceptance criteria

- [ ] Greppable error code/message tests added
- [ ] `graph inspect --all` performance smoke added
- [ ] `pnpm verify` green for full v1 test suite
