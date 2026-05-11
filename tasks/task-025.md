# Task 025: Auto dependency chain continuation

## Scope

Type: AFK

Make default `--chain auto` preserve ordinary task-chain continuation by adding a blocking dependency from newly enqueued ordinary follow-up work to the actor run's held ordinary task.

Ordinary means `triage`, `design`, or `execute`. The task should deliver the complete path from a held task through enqueue, dependency persistence, claim blocking, inspect lineage, and event/output metadata while keeping graph-policy coverage primarily in fast pure tests.

## Must implement exactly

- During enqueue, resolve the actor run's current held task after run authorization and before final dependency validation.
- Feed the held-task snapshot into the pure chain-policy resolver from task 023.
- For held `triage`/`design`/`execute` tasks enqueuing new `triage`/`design`/`execute` work with `--chain auto`, add an implicit blocking dependency on the held task.
- Ensure manual `--depends-on` values combine with the implicit held-task dependency for fan-in.
- Reject duplicate dependency ids after manual and implicit dependencies are combined, following the current spec decision.
- Implement DB-backed `--chain held` for ordinary follow-up: require a held task and add it as a blocking dependency; fail loudly if no task is held or the new task is `escalate`.
- Preserve the existing cross-scope dependency rules and cycle checks.
- Update enqueue output and `task.created` payload chain metadata to distinguish implicit held-task dependency from intentionally flat/manual-only enqueue.
- Add minimal DB/engine integration tests proving claimability is blocked until the held upstream task is `done` and lineage includes the upstream dependency.
- Expand pure tests if integration reveals any chain-policy branch not already covered.

## Done when

- A Toil/Greed/War run holding ordinary work can enqueue ordinary follow-up without manually passing `--depends-on <held-task-id>`, and the follow-up is blocked on the held task.
- Manual fan-in with default auto records both the implicit held dependency and the explicit extra dependency.
- `--chain held` fails loudly when its preconditions are not met.
- Relevant pure, task lifecycle, and CLI tests pass.

## Out of scope

- Escalation source-link creation.
- Handoff from held escalation back to its source.
- Prompt/template changes.
- Changing claim scheduling beyond existing dependency readiness rules.

## References

- `specs/task-graph.md`
- `UBIQUITOUS_LANGUAGE.md`
- `packages/pithos/src/engine.ts`
- `packages/pithos/src/db.ts`
- `packages/pithos/test/task-lifecycle.test.ts`
- `packages/pithos/test/cli.test.ts`
