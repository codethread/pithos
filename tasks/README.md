# Task index

Machine-readable task dependency map lives in [`index.yml`](./index.yml).

Individual task files describe scope and acceptance only; blockers live in the YAML index.

## MVP follow-up notes

- Re-check generated CLI help before task-012b snapshots. `pithos-next --help` currently renders the nested artifact command as `task task artifact add` in the top-level command summary even though `pithos-next task artifact add --help` and the command path work. Treat as CLI-help polish unless it blocks snapshots.
- Keep verifying global bin links during demo gates. Root `pnpm run build` links `pdx` now; stale global npm links can otherwise point at another checkout and make pdx demos misleading.
- Consider pane-visible pdx daemon logs after MVP basics: structured JSONL remains source of truth, but `pdx--daemon` could tee supervisor log lines to stderr so humans attaching to the daemon tmux window see startup/reconcile/cleanup activity live.

## Stdin payload API change plan

### Problem statement / MVP goal

Implement the pending Pithos stdin payload CLI contract so payload-bearing Task mutations use explicit `--stdin` instead of payload/file flags. The MVP keeps Pithos as durable source of truth, preserves existing Task/Run/Artifact invariants, and updates agent-facing docs/prompts once behavior is complete.

### Important references

- `specs/pithos-stdin-payload-api-change.md`
- `specs/control-plane-supervision.md`
- `specs/task-graph.md`
- `specs/control-plane-design-notes.md`
- `UBIQUITOUS_LANGUAGE.md`
- `packages/pithos/src/cli.ts`
- `packages/pithos/src/services.ts`
- `packages/pithos/src/engine.ts`
- `packages/pithos/test/cli.test.ts`
- `packages/pithos/test/task-lifecycle.test.ts`
- `packages/spawner/templates/`

### Task strategy

Tasks 015-018 are AFK vertical slices through the public `pithos` CLI, service boundary, engine-facing inputs, behavior tests, and the normative command-contract text for the command each slice changes. Task 015 introduces the shared stdin/input service through the enqueue path. Tasks 016-018 reuse that boundary for supersede, artifact add, and complete. Task 019 is blocked on behavior slices and performs the final status/docs/prompts audit so no conflicting payload contract remains.

No HITL slice is required: the stdin payload decisions are already captured in the pending change spec, and the normative specs identify the exact command-contract sections to update.

## Developer Notes

Append notes here. Do not rewrite earlier notes.

### Task 015-019: Stdin payload API plan — 2026-05-10

- Plan was added after reading `specs/pithos-stdin-payload-api-change.md`, `specs/control-plane-supervision.md`, `specs/task-graph.md`, `specs/control-plane-design-notes.md`, `specs/README.md`, `UBIQUITOUS_LANGUAGE.md`, and pithos CLI/service/test context.
- Existing `tasks/index.yml` uses the repository's established `task-015` string-id dependency style rather than integer ids; new stdin tasks keep that id style but use the requested `description` and `task_file` fields for AFK loop consumption.
- Task 015 is intentionally blocked by completed concrete prerequisite `task-013c`, not epic `task-013`, so the stdin payload work is the next runnable AFK task while older pending follow-up tasks remain blocked on the epic placeholder.
- Deep review found that delaying all spec sync to task 019 would leave implemented behavior conflicting with normative specs. Tasks 015-018 now each require updating command-contract text for the command they change; task 019 remains the final audit/status/docs/prompts sync.

### Task 015: Enqueue stdin payload CLI slice — 2026-05-10

- Added the shared Pithos input service with typed stdin states and wired `task enqueue --stdin` through the CLI boundary before calling the existing engine string-body API.
- Updated enqueue command-contract specs to remove `--body`/`--body-file` from current enqueue behavior; supersede/artifact/complete payload flags remain for their later slices.
- Validation run: `pnpm verify`.

### Task 016: Supersede stdin replacement body — 2026-05-10

- `task supersede` now resolves replacement body from explicit `--stdin` at the CLI boundary and emits tagged validation JSON before config/DB access when `--stdin` is omitted or invalid.
- Public supersede CLI no longer defines `--body` or `--body-file`; the in-process engine API still accepts explicit body/bodyFile for non-CLI callers while the CLI always passes stdin text.
- Updated normative supersede command contracts in `control-plane-supervision.md` and `task-graph.md`.
- Validation run: `pnpm verify`.

### Task 017: Artifact add stdin body — 2026-05-10

- `task artifact add` now requires explicit `--stdin`, resolves artifact body through the typed input service before config/DB access, and passes resolved body text to the engine.
- Public artifact add CLI no longer defines `--body-file`; engine artifact add no longer has file-path indirection or empty-body omission behavior.
- Updated artifact add command contracts in `control-plane-supervision.md` and `control-plane-design-notes.md`.
- Validation run: `pnpm verify`.
