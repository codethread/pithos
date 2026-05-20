# Task 11: Verify typed edge integration

## Scope

Type: AFK

Run the full integration verification pass for the typed-edge graph redesign and repair any missed implementation, docs, prompt, snapshot, or build issues required to make the completed work coherent.

## Must implement exactly

- Run the project's standard verification suite.
- Run targeted Pithos tests for typed-edge storage, enqueue, gate claimability, late-growth protection, graph inspection, snapshots, and CLI help.
- Run targeted pdx/Spawner tests or previews affected by changed command cards and prompt guidance.
- Run isolated smoke checks for help/preview surfaces that agents consume, using temp data dirs where runtime state is needed.
- If readable output snapshots are stale because the implemented display intentionally changed, update them with `vitest run --update` and include the resulting snapshot files.
- Fix any failures caused by the typed-edge work until validation is green.
- Confirm the temporary diff spec has been removed after canonical spec fold-in.
- Append a Developer Notes entry summarizing validation commands and any repairs made.

## Done when

- `pnpm verify` passes from the repo root.
- Targeted typed-edge Pithos tests pass.
- Any changed readable display snapshots are intentionally updated and committed with the implementation.
- Agent prompt/command-card previews affected by typed-edge CLI changes succeed in an isolated configuration.
- No temporary typed-edge diff spec remains in `specs/` or `specs/README.md`.
- `git status --short` contains only intentional typed-edge implementation/docs/test changes.

## Out of scope

- New feature work beyond repairing validation failures from the typed-edge implementation.
- Live `pdx open` smoke runs unless needed to diagnose an integration failure; if used, follow isolated data-dir and tmux guidance from `AGENTS.md`.
- Performance optimization beyond fixing correctness or unacceptable test/runtime regressions found during verification.

## References

- `AGENTS.md`
- `specs/task-graph.md`
- `specs/control-plane-supervision.md`
- `packages/pithos/test/`
- `packages/pdx/test/`
- `packages/spawner/src/spawner.test.ts`
- `resources/data-dir/templates/`
