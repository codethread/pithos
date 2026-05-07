# Slice 12 — Test tightening for v1

## What to build

Per the plan, earlier slices intentionally focused tests on contracts that schema cannot enforce: authorization, transition outcomes, atomic invariants, runtime preconditions. Now that the MVP is working end-to-end, broaden coverage so the system survives future change.

This slice adds tests only — no behavior changes. If a test reveals a behavioral gap, file a follow-up issue rather than fixing it inside this slice.

Areas to cover:

- **MVP integration test** end-to-end:
  - `pdx open`, observe Pandora alive
  - `pithos task enqueue --capability triage` from a seeded scope
  - reconcile spawns Toil, Toil claims and decomposes (enqueues `design` and `escalate`)
  - reconcile spawns Greed, Greed claims and produces a design artifact
  - new claimable escalate triggers wakeup; Pandora claims and completes
  - `pdx kill --run <war-or-greed>` mid-flight; observe interrupt → escalate from pdx system run → Pandora picks it up
  - `pdx close` tears everything down
- **Snapshot tests** for stable surfaces:
  - `pithos --help`, `pdx --help`, every `--help` subcommand
  - `pdx status --json` shape (top-level keys + per-entry minimums)
  - `pithos task inspect`, `pithos run inspect`, `pithos graph inspect` JSON shapes
- **Event payload coverage**: every event emitted by the system has at least one assertion against its full required-payload schema (per spec §11)
- **Edge cases**:
  - concurrent claim attempts; only one wins; loser receives `NO_CLAIMABLE_WORK`
  - fenced update race (`STALE_TOKEN_RACE` rolls back transaction, does not partially mutate)
  - `task supersede` with mixed dependent states (queued + cancelled + done) → fails loud per spec §6
  - `pdx kill` racing with natural death (run already terminal by the time interrupt runs)
  - orphan discovery when both tmux orphans and pidfile orphans coexist
- **Error-message wording assertions** for tagged `PithosError` codes most likely to drift (`STALE_TOKEN_RACE`, `VALIDATION_ERROR` variants, `NO_CLAIMABLE_WORK`)
- **Performance smoke** (not load testing): `pithos graph inspect --all` against ~few-hundred tasks completes promptly

## Test focus

This entire slice is the test focus. Earlier slices' tests should not be retroactively expanded — instead, add coverage here so each slice stays scoped to behavior and contracts that block its acceptance.

## Acceptance criteria

- [ ] MVP integration test covers the full happy + kill paths described above
- [ ] Snapshot tests stable for `--help` outputs and JSON-emitting commands
- [ ] Every event kind has at least one full-payload assertion
- [ ] Concurrency / race edge cases covered
- [ ] Error-message wording locked for the most-grepped error codes
- [ ] Performance smoke runs in CI without timing out
- [ ] `pnpm verify` green

## Blocked by

- Slice 11 (task-011)
