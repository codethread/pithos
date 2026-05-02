# Pithos implementation pack

This repository is the single entrypoint for agents building Pithos.

Pithos is the from-scratch dedicated repo/CLI for Pandora's Box:

- repo: `~/dev/pithos`
- CLI: `pithos`
- runtime: Node LTS + pnpm workspaces
- language: TypeScript + Effect v3
- tests: Vitest
- lint: strict ESLint, explicit/unsafe `any` banned

## Agent loop

When asked to continue Pithos implementation:

1. Read this file.
2. Read `tasks-adhoc.md` first, then `tasks.md`.
3. Pick the first unimplemented task in `tasks-adhoc.md` whose `Blocked by` dependencies are complete; if none are available, pick the first unbuilt task in `tasks.md` whose `Blocked by` dependencies are complete.
4. Read only the supporting docs needed for that task:
   - `mvp-spec.md` for product/domain intent
   - `technical-design.md` for implementation contracts
   - `ambition.md` only for direction beyond MVP
5. If the active queue file (`tasks-adhoc.md` or `tasks.md`) and supporting specs conflict, follow the queue file and flag the conflict in the report.
6. Implement exactly that slice in `~/dev/pithos`.
7. Validate the slice's `Vertical slice` acceptance criteria plus standard checks:
   - `pnpm lint`
   - `pnpm typecheck`
   - `pnpm test`
8. Commit the work in this repo.
9. Request `reviewer` subagent check your work and report back,
   - fix any findings unless you think they are unfounded
   - repeat the linting and testing as needed
   - re-review, unless fix was trivial
10. Update the source queue file (`tasks-adhoc.md` or `tasks.md`), changing the completed slice from `Status: Unimplemented` / `Status: Unbuilt` to `Status: Built`.
11. Commit the task-status update in this repo.
12. Stop and report what changed, including commit hashes.
    - IMPORTANT: if you complete the last task, or hit a fatal blocker you can't resolve, or hit a 'human in the loop' task, return the repose `COMPLETE` and nothing else

## Rules

- Build from scratch in `~/dev/pithos`; existing vault scripts are prior art only.
- Do not skip ahead to blocked slices.
- Do not add daemon/spawn automation/recipe engine before the MVP slices ask for it.
- Do not use real Claude/tmux in AFK tests.
- Docker/Podman DB smoke tests are okay; real Claude-in-container is HITL only.
- Use dependency injection for DB, clock, IDs, filesystem, process execution, and Claude harness.
- Keep workers pithos-tracked but not pithos-aware.
- Keep prompts small; command details belong in `pithos --help`.

## Documents

| File                  | Purpose                                                          |
| --------------------- | ---------------------------------------------------------------- |
| `tasks-adhoc.md`      | Ad hoc observability/repair slices; actioned before the primary queue |
| `tasks.md`            | Numbered tracer-bullet implementation slices; primary work queue |
| `mvp-spec.md`         | MVP product/domain spec                                          |
| `technical-design.md` | Technical contracts and implementation details                   |
| `ambition.md`         | Long-term direction; do not overbuild from it                    |
| `references/`         | Copied prior art from the current Pandora prototype              |

## Current next action

Start with the first unimplemented slice in `tasks-adhoc.md`; if none are available, continue with the first unchecked/unbuilt slice in `tasks.md`.
