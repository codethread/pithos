# Task 10: Fold typed edges into docs

## Scope

Type: AFK

After typed-edge behavior is implemented and rendered, merge the temporary diff spec into the canonical project terminology, specs, package docs, and agent-facing prompt guidance.

## Must implement exactly

- Merge accepted concepts from `specs/task-graph-typed-edges-diff.md` into `specs/task-graph.md`:
  - typed edge kinds;
  - branch closure;
  - dynamic gate claimability;
  - gate release snapshots;
  - late branch-growth protection;
  - Supersession behavior;
  - inspection contracts.
- Merge escalation/Repair Alert changes into `specs/control-plane-supervision.md`:
  - immediate escalation as `about`;
  - checkpoint escalation as `gate`;
  - Repair Alert as `repair`;
  - repair cannot ordinary-auto-continue.
- Update `UBIQUITOUS_LANGUAGE.md` so terms no longer describe Dependencies and Source links as separate durable primitives; define typed Task edges, `after`, `gate`, `about`, `repair`, branch closure, and gate release.
- Update package READMEs for changed schema, CLI, chain policy, inspection, and Repair Alert behavior.
- Update canonical agent templates so Pandora, Toil, Greed, War, and Envy use new edge flags and understand gate/about/repair semantics.
- Update resources docs for command/config references affected by the new CLI surface.
- Remove `specs/task-graph-typed-edges-diff.md` from the specs index and filesystem after its content is folded into canonical docs.
- Keep docs consistent with implemented behavior, not with earlier planning text if implementation made a justified adjustment.

## Done when

- No docs or templates instruct agents to use removed `--depends-on` or `--chain source` behavior.
- Canonical specs explain typed edges without referring readers to the temporary diff spec.
- Ubiquitous language has one coherent vocabulary for Task graph relationships.
- Package READMEs point to the canonical specs and accurately describe module boundaries after the typed-edge implementation.
- The temporary diff spec is removed from `specs/README.md` and deleted.
- Relevant docs formatting checks pass.

## Out of scope

- Code behavior changes beyond doc/template corrections required to match implemented typed-edge behavior.
- New scheduling/admission-control primitives.
- New agent kinds or capabilities.

## References

- `specs/task-graph-typed-edges-diff.md`
- `specs/task-graph.md`
- `specs/control-plane-supervision.md`
- `UBIQUITOUS_LANGUAGE.md`
- `packages/pithos/README.md`
- `packages/pdx/README.md`
- `packages/spawner/README.md`
- `resources/README.md`
- `resources/data-dir/templates/`
