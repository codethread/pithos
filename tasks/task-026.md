# Task 026: Escalation source links

## Scope

Type: AFK

Add non-blocking source links for escalations so attention tasks can point at the work they are about without becoming blocked by that work.

This slice should make the source-link concept durable and inspectable: an ordinary held task enqueueing an `escalate` task with default auto creates a source link, not a dependency, and Pandora can see that source through task/graph inspection.

## Must implement exactly

- Add durable `task_sources` storage for one source task per task, using the source-link terminology from `UBIQUITOUS_LANGUAGE.md` and `specs/task-graph.md`.
- For held `triage`/`design`/`execute` tasks enqueuing `escalate` with `--chain auto`, use the pure resolver decision to create a non-blocking source link from the escalation to the held task.
- Do not create a blocking dependency for normal escalation source links.
- Validate source targets exist and have not been superseded; fail loudly with a tagged error pointing at the replacement when applicable.
- Include source-link metadata in enqueue output and `task.created` payloads.
- Extend `pithos task inspect` to show the direct source summary without adding it to dependency lineage.
- Extend `pithos graph inspect` JSON closure to include source edges and referenced source nodes.
- Ensure dependency claimability remains unchanged: an escalation with a source link is claimable immediately when otherwise queued.
- Add targeted DB integration tests for persistence, inspect output, graph output, event/output metadata, and immediate escalation claimability.
- Keep graph closure, lineage exclusion, and cycle behavior heavily covered in pure tests; add pure cases if the source-link implementation exposes missing branches.

## Done when

- Greed/Toil/War can enqueue a global escalation while holding ordinary work, and Pandora can inspect the escalation's source task.
- Source links appear in graph inspection but not as dependency lineage.
- An escalation with a source link is claimable even when the source task is still claimed/running.
- Relevant pure and pithos integration tests pass.

## Out of scope

- Handoff from a held escalation source into downstream ordinary work.
- Multiple source links per task.
- Prompt/template changes.
- Arbitrary `relates_to` or typed relation systems.

## References

- `specs/task-graph.md`
- `UBIQUITOUS_LANGUAGE.md`
- `packages/pithos/src/db.ts`
- `packages/pithos/src/engine.ts`
- `packages/pithos/src/rows.ts`
- `packages/pithos/test/task-lifecycle.test.ts`
