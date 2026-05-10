# Task 019: Stdin payload docs and prompts sync

## Scope

Type: AFK

Synchronize the documented agent/operator contract after the stdin payload CLI slices are implemented.

This slice makes the pending API change normative by updating specs, READMEs, demos, and agent-facing command recipes so there is no remaining instruction to use `--body`, `--body-file`, or `--result-file` for Pithos payload-bearing commands.

## Must implement exactly

- Update `specs/pithos-stdin-payload-api-change.md` status and wording to reflect implemented behavior.
- Audit the command-contract sections in `specs/control-plane-supervision.md`, `specs/task-graph.md`, and `specs/control-plane-design-notes.md` so they no longer conflict with the stdin payload contract.
- Keep domain vocabulary aligned with `UBIQUITOUS_LANGUAGE.md`: Pithos owns durable Task/Run/Artifact state; pdx is the supervisor; Spawner is launcher-only.
- Update package/root README command examples and demos that mention removed payload flags.
- Update Spawner templates or agent prompt recipes that instruct agents to stage temp files for payload submission.
- Ensure examples show exactly one stdin payload per command and explicit `--stdin` whenever stdin is consumed.
- Preserve `task complete` guidance: no `--stdin` for default `{}` metadata, `--stdin` only for JSON object metadata, long-form work products in Artifacts.
- Do not document compatibility shims or removed flags as supported alternatives.

## Done when

- Repository search finds no user-facing command examples recommending `--body`, `--body-file`, or `--result-file` for current Pithos payload workflows.
- Normative specs and control-plane design notes agree on the same `pithos task enqueue`, `task supersede`, `task artifact add`, and `task complete` payload contract, or design notes explicitly mark any obsolete command examples as historical/non-contractual.
- Agent templates/recipes use stdin payload commands and no temp-file staging solely for Pithos payload upload.
- Relevant docs/template tests or snapshots pass if affected.

## Out of scope

- New CLI behavior beyond documentation/prompt sync.
- Rewriting unrelated control-plane design content.
- Adding new compound commands.
- Changing DB schema or task graph semantics.

## References

- `specs/pithos-stdin-payload-api-change.md`
- `specs/control-plane-supervision.md`
- `specs/task-graph.md`
- `specs/control-plane-design-notes.md`
- `specs/README.md`
- `UBIQUITOUS_LANGUAGE.md`
- `README.md`
- `packages/pithos/README.md`
- `packages/spawner/templates/`
- `docs/demos/`
