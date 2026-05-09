# Slice 6a — Refactor pdx to reuse `@pithos/pithos` directly

## What to build

Replace pdx's subprocess-oriented Pithos integration with direct typed library reuse from `@pithos/pithos`.

Scope:

- Add `@pithos/pithos` as a workspace dependency of `packages/pdx/`.
- Replace argv/string-based `PithosClient` calls with a typed pdx-facing Pithos service or adapter backed by `@pithos/pithos` exports.
- Stop spawning `pithos-next` for pdx-owned queue inspection and state transitions.
- Stop using stdout JSON parsing and `PITHOS_DB` env plumbing as pdx's integration boundary.
- Keep the agent/operator CLI surface unchanged: agents still use `pithos`/`pithos-next` commands; pdx reuses the same underlying library directly.

Minimum pdx-facing operations to cover current and next slices:

- init
- scope upsert
- run upsert
- run cleanup
- run interrupt
- run timeout
- run inspect or equivalent typed owning-run lookup
- task heartbeat
- task enqueue
- briefing or equivalent claimable-work read

Rules:

- Do not duplicate ad hoc SQL inside pdx for Pithos-owned reads if a typed helper can live in `@pithos/pithos` instead.
- If the current `makeEngine` surface is missing one pdx-needed operation, add/export the typed library helper there rather than falling back to CLI subprocesses.
- Keep the integration behind a pdx service seam so tests can inject live/test implementations.
- pithos CLI behavior and snapshots are not the acceptance target here; this slice is an internal pdx refactor with test updates.

## Test focus

- Existing pdx substrate/open/status/Pandora tests continue to pass after the refactor.
- New/updated tests cover the typed pdx Pithos service shape rather than argv arrays.
- No pdx test depends on parsing `pithos-next` stdout/stderr for normal control-plane behavior.
- Regression check: pdx no longer launches `pithos-next` as a subprocess for Pithos operations.
- Any new helper exported from `@pithos/pithos` has focused tests in that package.

## Defer

- New pdx behavior; follow-on slices 7+ consume the refactored boundary.
- Agent-facing CLI cutover from `pithos-next` to `pithos`; task 011.

## Acceptance criteria

- [ ] `packages/pdx/` depends on `@pithos/pithos`
- [ ] pdx uses typed direct library reuse for Pithos operations
- [ ] No `execFile("pithos-next", ...)` or equivalent subprocess boundary remains for pdx-owned Pithos calls
- [ ] Existing pdx tests are updated and green
- [ ] Any newly needed Pithos helper/export is covered by tests in `packages/pithos/`
