# Task 027: Escalation source handoff

## Scope

Type: AFK

Complete automatic chain continuation through Pandora by routing ordinary follow-up work from a held escalation back to that escalation's source task.

When Pandora holds an escalation with a source link and enqueues `triage` or `design` follow-up with default `--chain auto`, the new task should depend on the escalation's source task, not on the escalation itself. This preserves the task chain without making unrelated Pandora Qs inherit the source when she uses `--chain none`.

## Must implement exactly

- For a held `escalate` task with a source link, default `--chain auto` on new `triage`/`design`/`execute` work must add a blocking dependency on the source task.
- For a held `escalate` task without a source link, default `--chain auto` must create no implicit relationship and must report that no source was available in chain metadata.
- For held `escalate` enqueueing another `escalate`, default `--chain auto` must create no implicit relationship.
- Implement DB-backed `--chain source` as a fail-loud mode using the pure resolver: require a held task with a source and a non-escalate new task; add a blocking dependency on the source task.
- Preserve `--chain none` as the explicit Pandora Q escape hatch: no implicit source dependency is added, but manual `--depends-on` still works.
- Ensure source-task supersession validation is applied before writing dependency/source relationships.
- Add integration tests for Pandora resolution handoff, escalation-without-source no-op metadata, `--chain source` failure cases, and `--chain none --depends-on task_X` manual-only behavior while holding an escalation.
- Keep the full matrix in pure tests and add any missing handoff branch there before adding DB assertions.

## Done when

- A Pandora run holding an escalation with source `D` can enqueue a triage/design follow-up without passing `--depends-on D`, and the follow-up depends on `D`.
- `--chain none` while Pandora holds that escalation creates an intentionally flat/manual-only task.
- `--chain source` fails loudly when no held source exists or when the new task is `escalate`.
- Chain metadata makes each applied/no-op decision visible in enqueue output and events.

## Out of scope

- Agent prompt/documentation updates.
- Multiple source links.
- Allowing Pandora to enqueue `execute` beyond existing authorization.
- Any semantic inference from Adam's natural-language Q requests.

## References

- `specs/task-graph.md`
- `UBIQUITOUS_LANGUAGE.md`
- `packages/pithos/src/engine.ts`
- `packages/pithos/test/task-lifecycle.test.ts`
- `packages/pithos/test/cli.test.ts`
- `packages/spawner/templates/pandora.md.tmpl`
