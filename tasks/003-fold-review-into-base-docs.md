# Task 3: Fold review into base docs

## Scope

Type: AFK

After the capability and prompt behavior exist, fold the planned `review` change into the permanent project docs and remove the temporary change spec.

## Must implement exactly

- Update `UBIQUITOUS_LANGUAGE.md` with a Review task term that distinguishes:
  - `review`: Greed-claimed HITL assessment, optionally global/repo/worktree scoped, normally requested and dependency-gated;
  - `escalate`: Pandora-claimed immediate attention, repair, and routing.
- Update `specs/task-graph.md` so the implemented task graph semantics include `review` as an ordinary non-escalation Capability and keep `escalate` source-link semantics unchanged.
- Update `specs/control-plane-supervision.md` where needed to describe Greed’s review lifecycle and readiness escalation to Pandora.
- Update `specs/agent-configuration.md` only if its capability/agent examples or configuration contract mention the built-in capability set.
- Update root `README.md` and any package README that has a built-in capability/claim/enqueue table or package boundary statement affected by `review`.
- Remove `specs/scoped-review-capability.md` once the base specs contain the settled behavior.
- Remove the scoped review entry from `specs/README.md` after deleting the change spec.

## Done when

- There is no live contradiction between root README, base specs, ubiquitous language, package docs, templates, and Pithos built-ins about who claims/enqueues `review`.
- `specs/scoped-review-capability.md` no longer exists.
- `specs/README.md` indexes only the permanent specs.
- Documentation still states that raw templates do not automatically add review gates and that future `verify`/QA work is out of scope for this change.

## Out of scope

- Any code behavior change not already completed by earlier tasks.
- New examples for speculative future workflows beyond the MVP review behavior.
- Adding a `verify` Capability.

## References

- `specs/scoped-review-capability.md`
- `README.md`
- `UBIQUITOUS_LANGUAGE.md`
- `specs/task-graph.md`
- `specs/control-plane-supervision.md`
- `specs/agent-configuration.md`
- `specs/README.md`
- `packages/pithos/README.md`
- `packages/spawner/README.md`
- `packages/pdx/README.md`
