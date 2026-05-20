# Task 8: Enforce released gate protection

## Scope

Type: AFK

Protect already-started downstream work from late upstream branch growth after a gate has released, including growth caused by new branch-member edges and Supersession.

## Must implement exactly

- On insertion of any new `after`, `about`, or `repair` edge, detect affected released gates according to the diff spec:
  - the canonical target of the new edge appears in a release member snapshot; or
  - the canonical target appears in the current `branchClosure(release.target_task_id)`.
- On Supersession of any task, detect affected released gates when the superseded canonical task appears in a release member snapshot or current gated closure.
- For each affected release, compute the downstream impact closure from the gate owner:
  - start at the canonical gate owner;
  - traverse incoming `after`, `about`, and `repair` branch-membership edges;
  - also traverse owners of already-released gate edges whose target is in the impact set;
  - repeat to fixed point.
- Fail loudly when any task in the downstream impact closure is non-terminal.
- Allow the upstream growth when the full impact closure is terminal, and write a durable `task_gate_late_growth_markers` row that identifies the prior gate release it followed. Do not introduce a new event contract in this task.
- Expose late-growth marker rows through the Pithos read model with enough structured data for Task 9 to render: gate task id, gate target id, gate attempt, mutation kind, affected edge or Supersession ids, creating run id, and timestamp.
- Keep all checks inside the same SQLite transaction as the edge insertion or Supersession mutation that would change the graph.
- Add regression tests for late edge insertion under direct and transitive released gates, Supersession under released gates, allowed late growth after downstream terminal work, and failure rollback.

## Done when

- New branch-member work cannot be attached under a released gate while the gated task or any downstream dependent work is queued, claimed, or running.
- Supersession cannot reopen a released-gate branch while downstream gated work is still active.
- Late growth is allowed only after all impacted downstream work is terminal and leaves a durable marker tied to the prior gate release.
- The marker read model exposes enough structured data for task/graph inspection to render it without inferring from timestamps alone.
- Failed late-growth attempts leave no partial edge, Supersession, marker, or event drift.
- Relevant Pithos tests pass.

## Out of scope

- Changing the gate release schema beyond what Task 7 introduced unless tests prove it is insufficient.
- Priority or admission control.
- Manual graph rewiring commands.
- Canonical spec fold-in.

## References

- `specs/task-graph-typed-edges-diff.md`
- `packages/pithos/src/engine.ts`
- `packages/pithos/src/engine/claim-loop.ts`
- `packages/pithos/src/engine/task-read-model.ts`
- `packages/pithos/src/engine/event-log.ts`
- `packages/pithos/test/task-lifecycle.test.ts`
