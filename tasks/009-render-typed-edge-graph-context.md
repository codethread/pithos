# Task 9: Render typed edge graph context

## Scope

Type: AFK

Make typed edges and dynamic gate state understandable to agents through task inspection, graph inspection, and briefing output, including JSON contracts and readable text.

## Must implement exactly

- Update `task inspect` JSON and readable output to group relationships by edge kind:
  - direct `after` dependencies;
  - coordination `gate` edges with clear/open/broken state;
  - attached `about` context;
  - attached `repair` context;
  - Supersession context.
- For open or broken gates, include the relevant branch members causing the gate state without dumping unrelated graph history.
- Update `graph inspect` closure and JSON edges so every edge carries its typed kind.
- In readable graph output, distinguish branch-membership edges (`after`, `about`, `repair`) from coordination gates (`gate`) so gates are not narrated as ordinary chain history.
- Update scope-seeded graph inspection so closure may include global `about`/`repair` escalation tasks and global checkpoint escalations whose `gate` target is in the selected scoped closure.
- Update `briefing` blocked-work summaries to distinguish direct after blockers, open gates, and broken gated branches.
- Render the inspection-visible late-growth marker created by Task 8 so allowed late growth after a prior gate release is visible in task/graph context.
- Keep output deterministic: stable ordering by created time/id or explicit edge kind ordering where needed.
- Add broad snapshot coverage for human-readable graph display variations, especially `graph inspect` output. Cover at least:
  - plain `after` chain;
  - open `gate`;
  - clear `gate`;
  - broken `gate`;
  - branch-attached `about` escalation;
  - branch-attached `repair` alert;
  - scoped graph that pulls attached global attention/checkpoint tasks;
  - Supersession context in a typed-edge graph;
  - allowed late-growth marker after a prior gate release.
- Use `vitest run --update` when intentionally accepting changed display snapshots; do not hand-edit generated snapshots.
- Update renderer and CLI output tests for readable, snapshot, and JSON contracts.

## Done when

- Inspecting a task with mixed `after`, `gate`, `about`, and `repair` edges shows each group under distinct labels.
- Inspecting a gated task identifies whether each gate is clear, open, or broken and names the open/broken branch members.
- `graph inspect --json` exposes typed edges and gate state for scripts.
- Scope graph tests prove attached global escalation/repair/checkpoint tasks are visible according to the typed-edge spec.
- Snapshot tests make the major readable `graph inspect` variations easy to review in diffs and easy to update intentionally.
- Readable graph/task output surfaces allowed late-growth markers from Task 8.
- Briefing tests prove gated blocked work is agent-readable and not collapsed into generic dependency language.
- Relevant Pithos tests pass.

## Out of scope

- Agent prompt/template prose.
- Canonical spec fold-in.
- New graph visualization commands.
- Priority/admission scheduling output.

## References

- `specs/task-graph-typed-edges-diff.md`
- `packages/pithos/src/engine/render.ts`
- `packages/pithos/src/engine/graph-inspect.ts`
- `packages/pithos/src/engine/task-read-model.ts`
- `packages/pithos/src/engine/types.ts`
- `packages/pithos/test/render.test.ts`
- `packages/pithos/test/cli.test.ts`
- `packages/pithos/test/task-lifecycle.test.ts`
