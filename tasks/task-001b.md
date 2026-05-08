# Slice 1b — Nested CLI shell + scope/run foundations

## What to build

Build the public `pithos-next` command shell as a thin `@effect/cli` wrapper over the core library from task 001a.

Commands in scope:

```text
pithos-next init [--fresh]
pithos-next scope upsert --kind <global|repo|worktree> [--path <path>]
pithos-next run upsert \
  --agent <pdx|pandora|toil|greed|war> \
  --mode <afk|hitl> \
  --scope <scope-id> \
  --cwd <path> \
  --session-id <session-id> \
  [--run <run-id>]
pithos-next run inspect <run-id>
pithos-next events tail [--limit <n>]
```

CLI requirements:

- Use real nested `@effect/cli` commands/subcommands; no flat aliases.
- Parse CLI inputs into tagged command-input variants before dispatch.
- Render successful output as JSON with spec minimum keys.
- Render `PithosError` failures as JSON with machine-readable `code`.
- Do not implement removed surfaces: no `sweep`, no `run end`, no `run finish`, no top-level task aliases.
- `run upsert` validates agent kind and scope existence through Pithos, not by template convention.

`run inspect` minimum output:

```json
{ "ok": true, "run": { "id": "run_...", "agent": "war", "mode": "afk", "scope_id": "...", "status": "live", "task_id": null, "session_id": "...", "created_at": "...", "updated_at": "..." } }
```

## Test focus

- Nested help/dispatch recognizes only the new command shape.
- `scope upsert` global/repo/worktree behavior, including canonical path for repo/worktree.
- `run upsert` accepts seeded agent kinds and rejects unknown agents.
- `run upsert` rejects unknown scopes.
- `run inspect` returns the minimum output contract.
- `events tail` returns durable event rows deterministically with limit handling.

## Defer

- Mutating task commands and `PITHOS_RUN_ID` task-run resolution.
- Graph/briefing surfaces.
- Run lifecycle transitions from task 2.

## Acceptance criteria

- [ ] `pithos-next --help` exposes nested commands only.
- [ ] `init`, `scope upsert`, `run upsert`, `run inspect`, and `events tail` work through the core library.
- [ ] Errors are tagged `PithosError` JSON, not free-form strings.
- [ ] Tests cover command dispatch and output contracts for this slice.
