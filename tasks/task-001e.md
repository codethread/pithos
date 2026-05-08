# Slice 1e — Foundation contract hardening + acceptance

## What to build

Close the task-001 epic by tightening contracts across the smaller foundation slices and proving the package is ready for downstream `pdx`, spawner, and lifecycle work.

This is not a feature-expansion slice. It is the acceptance gate for tasks 001a-001d.

## Hardening checklist

- Public CLI surface exactly matches the nested MVP shape from supervision spec §7 for commands implemented in task 1.
- Removed surfaces are absent:
  - no `pithos-next sweep`
  - no `pithos-next run end`
  - no `pithos-next run finish`
  - no top-level `enqueue`, `claim`, `heartbeat`, `complete`, `fail`, `supersede`, `tail`, `artifact`, or `inspect`
- All command inputs crossing CLI/env/file/DB boundaries are parsed/decoded before domain logic.
- All Pithos failures are tagged `PithosError` values with machine-readable codes.
- No silent fallbacks for missing run/scope/task/capability/agent/body/token data.
- Multi-statement mutations are transactional.
- Event writes happen in the same transaction as their state mutation.
- The old `packages/cli/` package and production `pithos` bin remain unchanged and still build.
- `packages/pithos/` exposes reusable core APIs that can be imported by later `pdx` code.

## End-to-end contract tests

Add/confirm tests for:

- `pithos-next init --fresh` creates schema and seeds.
- non-fresh init is idempotent.
- every seeded claim authorization mismatch rejects.
- enqueue authorization rejects representative disallowed pairs.
- one-held-task rejection.
- run-scope claim mismatch rejection.
- capability scope rule rejections.
- heartbeat `--task`/`--token` atomicity and idempotence.
- `PITHOS_RUN_ID` defaulting and conflict detection.
- happy-path enqueue → claim → heartbeat → artifact add → complete.
- dependency-blocked task is not claimable until upstream is `done`.
- supersede repairs a broken queued chain and preserves history.
- output minimum contracts for `run inspect`, `task inspect`, `graph inspect`, `events tail`, and `briefing`.

## Validation

Run relevant package checks, then workspace checks if feasible:

```sh
pnpm --filter @pithos/pithos typecheck
pnpm --filter @pithos/pithos test
pnpm --filter @pithos/pithos build
pnpm run build
```

If a check fails because of a real repo-wide issue outside this slice, record it explicitly with command output and do not claim the acceptance gate is complete.

## Acceptance criteria

- [ ] All task-001 child slices are complete.
- [ ] `packages/pithos/` tests, typecheck, and build pass.
- [ ] Workspace build passes or any external blocker is documented with exact command output.
- [ ] Old `packages/cli/` behavior is not regressed.
- [ ] Downstream tasks may depend on this slice instead of the original monolithic task 1.
