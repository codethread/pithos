# Task 5: Graph inspect docs convergence

## Scope

Type: AFK

After the graph inspect behavior is implemented, make the durable documentation agree with the code. Fold the planned graph-inspection contract into the implemented task graph spec and remove contradictions around `--hide-terminal`, default hidden terminal nodes, and supported filters.

## Must implement exactly

- Update `specs/task-graph.md` so its `pithos graph inspect` interface and readable-output behavior match the implemented contract.
- Update `specs/pithos-graph-inspection.md` to reflect its post-implementation status, either by marking it implemented as the focused contract or by clearly noting that the contract has been folded into `task-graph.md`.
- Update `specs/README.md` so the spec index no longer implies conflicting authoritative graph-inspect contracts.
- Check `packages/pithos/README.md` and update only if its graph/help guidance is now misleading.
- Preserve the boundary that `briefing` owns agenda-style ready/blocked summaries while `graph inspect` owns graph interrogation.
- Run formatting on touched docs.

## Done when

- No spec claims that `pithos graph inspect` supports `--hide-terminal`.
- No spec claims readable graph output hides terminal nodes by default.
- The documented graph inspect CLI includes `--status`, `--search`, and `--since` with the implemented composition semantics.
- The spec index clearly points readers to the authoritative graph-inspection contract.
- Documentation formatting passes for touched files.

## Out of scope

- Code changes to graph inspect behavior.
- New filters or command aliases.
- Rewriting unrelated task graph sections.
- Changing prompts or templates unless a direct contradiction is discovered.

## References

- `specs/pithos-graph-inspection.md`
- `specs/task-graph.md`
- `specs/README.md`
- `packages/pithos/README.md`
