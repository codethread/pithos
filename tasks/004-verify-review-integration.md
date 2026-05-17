# Task 4: Verify review integration

## Scope

Type: AFK

Run project validation for the completed `review` capability and repair any integration misses surfaced by tests, typechecking, linting, build, or generated prompt/help contracts.

## Must implement exactly

- Inspect the final diff and ensure only the intended `review` capability changes are present.
- Run `pandora-spawn preview` for Greed, Pandora, and Toil in an isolated smoke configuration to verify rendered prompt/manifest integration.
- Run the project’s standard validation suite.
- If validation fails, make minimal fixes that preserve the scoped review design:
  - Greed claims `review`;
  - Pandora and Toil enqueue `review`;
  - Greed, War, and Envy do not enqueue `review`;
  - `review` behaves as ordinary non-escalation chain work;
  - `escalate` behavior and Repair Alerts remain unchanged.
- Re-run failed checks until they pass.
- If snapshots are the only failing contract and the new output is correct, update snapshots using the project’s normal test command rather than manual snapshot editing.

## Done when

- `pandora-spawn preview` succeeds for Greed, Pandora, and Toil in an isolated smoke configuration.
- `pnpm verify` passes from the repo root.
- `git status --short` shows only intended review capability, prompt, docs, and test changes.
- No temporary change spec remains after Task 3.
- The final state is ready for a human to inspect and commit.

## Out of scope

- Broad refactors unrelated to the `review` capability.
- New workflow policy beyond the scoped review MVP.
- Smoke-testing live tmux/pdx sessions; deterministic `pandora-spawn preview` is still in scope.

## References

- `AGENTS.md`
- `package.json`
- `specs/task-graph.md`
- `specs/control-plane-supervision.md`
- `templates/README.md`
- `packages/pithos/test/`
- `packages/spawner/src/spawner.test.ts`
