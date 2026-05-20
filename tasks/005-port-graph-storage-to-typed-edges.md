# Task 5: Port graph storage to typed edges

## Scope

Type: AFK

Replace the current dependency/source storage with the baseline typed-edge graph model while preserving existing direct dependency, immediate escalation, and Repair Alert behavior. This is the tracer-bullet storage slice: after it lands, the system should still work for current workflows, but rows are stored as typed edges.

## Must implement exactly

- Replace fresh Pithos schema tables `task_dependencies` and `task_sources` with `task_edges` as defined by `specs/task-graph-typed-edges-diff.md`.
- Include `after`, `about`, and `repair` edge kinds in this slice; `gate` may be present in the enum/schema but must not affect claimability until the gate task slice.
- Preserve edge authorship with `created_by_run_id`.
- Add typed edge row parsing/read-model helpers at the SQLite boundary; no `any` or leaked `unknown` from DB rows.
- Map current manual dependency creation to `after` edges internally.
- Map current `chain_source` behavior to `about` edges internally.
- Map current Repair Alert provenance to `repair` edges internally.
- Keep current direct claimability behavior by checking only outgoing `after` edges whose targets are not `done`.
- Preserve current Repair Alert semantics: `repair` is immediate attention for broken work, not ordinary continuation.
- Update Supersession so queued direct `after` edge owners are retargeted to replacements and `about`/`repair` edges preserve original provenance.
- Update `task.created` event payloads to record typed edge arrays by kind instead of a flat `depends_on_task_ids` list.
- Update graph and task read models enough that existing inspections, briefings, and tests compile and report equivalent information under typed edges.

## Done when

- `pithos init --fresh` creates `task_edges` and no longer creates `task_dependencies` or `task_sources`.
- Existing direct dependency tests still prove downstream tasks are not claimable until their `after` targets are `done`.
- Existing escalation and Repair Alert tests pass with `about`/`repair` edge rows replacing source rows.
- Supersession tests cover `after` retargeting and `repair` provenance preservation.
- Event tests or assertions prove `task.created` records typed edge arrays by kind.
- Relevant Pithos tests pass.

## Out of scope

- New public CLI flags such as `--after`, `--about`, `--repair`, or `--gate-on`.
- Dynamic gate branch-closure claimability.
- Gate release snapshots or late-growth enforcement.
- Agent prompt updates.
- Folding the diff spec into canonical specs.

## References

- `specs/task-graph-typed-edges-diff.md`
- `specs/task-graph.md`
- `packages/pithos/src/db.ts`
- `packages/pithos/src/engine.ts`
- `packages/pithos/src/engine/claim-loop.ts`
- `packages/pithos/src/engine/task-read-model.ts`
- `packages/pithos/src/engine/graph-inspect.ts`
- `packages/pithos/src/engine/repair-alerts.ts`
- `packages/pithos/src/chain-policy.ts`
- `packages/pithos/test/`
