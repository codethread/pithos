# Pithos MVP tracer-bullet slices

**Status:** Core MVP slices built; slice 21 pending  
**Source specs:** `docs/specs/mvp-spec.md`, `docs/specs/technical-design.md`

## User stories covered

- **US0 — Repo foundation:** As a maintainer, I can clone/open the Pithos repo and run lint/tests consistently without touching my real local agent sessions/state.
- **US1 — Bootstrap:** As Adam, I can initialise a local Pithos store and verify it is ready.
- **US2 — Register context:** As Pandora/Toil/Envy, I can register scopes and runs so work is attributable.
- **US3 — Queue and claim:** As an agent, I can enqueue work and atomically claim it with a lease/fencing token.
- **US4 — Track liveness:** As the system, I can record run heartbeats and end runs cleanly.
- **US5 — Finish work:** As an agent, I can complete/fail work and attach an artifact/report.
- **US6 — Inspect state:** As Adam/Pandora, I can inspect tasks/runs/events/artifacts.
- **US7 — Brief Pandora:** As Pandora, I can receive a concise briefing with an event watermark.
- **US8 — Recover stale work:** As the system, I can requeue/dead-letter expired work deterministically.
- **US9 — Claude integration:** As an agent launched through Claude Code, I can be tracked through env vars/hooks.
- **US10 — Agent config:** As a maintainer, I can define agents/Skills and rely on CLI `--help` rather than giant prompts.
- **US11 — Manual end-to-end demo:** As Adam, I can run one complete manual Pandora → Envy → worker-style loop.

## Slices

1. **Title:** Create repo workspace and baseline checks  
   **Status:** Built  
   **Type:** AFK  
   **Blocked by:** none  
   **User stories covered:** US0  
   **Vertical slice:** Create `~/dev/pithos` as a git repo with pnpm workspace layout, Node LTS TypeScript config, stable Effect v3 dependencies, ESLint flat config, Vitest, a tiny `packages/cli` package, a placeholder `pithos --version`, and CI-style scripts (`lint`, `typecheck`, `test`). ESLint must ban explicit `any` and unsafe `any` usage. No SQLite, Docker, Claude, tmux, or real agents yet.

2. **Title:** Add dependency-injected service seams  
   **Status:** Built  
   **Type:** AFK  
   **Blocked by:** 1  
   **User stories covered:** US0  
   **Vertical slice:** Add initial Effect service/layer structure for clock, IDs, filesystem, process execution, DB placeholder, and future Claude harness. Include fast Vitest unit tests with fake services to prove commands can be tested without real filesystem/process/Claude dependencies.

3. **Title:** Add isolated Docker/Podman DB smoke harness  
   **Status:** Built  
   **Type:** AFK  
   **Blocked by:** 1, 2  
   **User stories covered:** US0  
   **Vertical slice:** Add a basic Docker/Podman-compatible smoke test that runs through Vitest against an isolated temp DB/container context. This proves containerised DB/process tests can run without touching `~/.pandora/pithos.sqlite`. This slice must not spawn Claude, tmux, or real agents.

4. **Title:** Initialise SQLite through the real CLI  
   **Status:** Built  
   **Type:** AFK  
   **Blocked by:** 1, 2, 3  
   **User stories covered:** US1  
   **Vertical slice:** Add executable `packages/cli/bin/pithos`, SQLite path resolution, initial migration table, `pithos init`, idempotency tests, and smoke demo: `PITHOS_DB=<temp> pithos init` creates a DB without touching `~/.pandora/pithos.sqlite` during tests.

5. **Title:** Register a repo scope and inspect it  
   **Status:** Built  
   **Type:** AFK  
   **Blocked by:** 4  
   **User stories covered:** US2, US6  
   **Vertical slice:** Add `scopes` table migration, home-relative scope ID derivation (`repo:work/...`), `pithos scope upsert --path`, `pithos inspect scope`, JSON output, tests for path canonicalisation and idempotent upsert.

6. **Title:** Register and end a Claude run  
   **Status:** Built  
   **Type:** AFK  
   **Blocked by:** 4, 5  
   **User stories covered:** US2, US4, US6  
   **Vertical slice:** Add `runs` table, `pithos run register`, `pithos run end`, lifecycle events for register/end, `pithos inspect run`, tests proving ended runs get `ended_at` and a lifecycle event. No separate `run resume` command; repeated registration with a known run ID should be idempotent if needed.

7. **Title:** Enqueue one scoped task and view it  
   **Status:** Built  
   **Type:** AFK  
   **Blocked by:** 4, 5  
   **User stories covered:** US3, US6  
   **Vertical slice:** Add `tasks` + `events` minimum schema, `pithos enqueue --scope --capability --title`, task-created event, `pithos inspect task`, tests for required fields and JSON output.

8. **Title:** Claim a queued task with a fenced lease  
   **Status:** Built  
   **Type:** AFK  
   **Blocked by:** 6, 7  
   **User stories covered:** US3  
   **Vertical slice:** Implement atomic `pithos claim --run --scope --capability`, lease timestamp, fencing token increment, task-claimed event, no-work exit code, concurrency/race test proving only one run claims one task.

9. **Title:** Heartbeat an active run and task  
   **Status:** Built  
   **Type:** AFK  
   **Blocked by:** 8  
   **User stories covered:** US4  
   **Vertical slice:** Implement `pithos heartbeat --run [--task --token --hook]`, update mutable run heartbeat, move claimed task to running when token matches, extend lease, reject stale token, and implement `--throttle-seconds` by comparing against `runs.last_heartbeat_at`. Tests cover throttled/no-event heartbeat behaviour.

10. **Title:** Complete or fail a claimed task safely  
    **Status:** Built  
    **Type:** AFK  
    **Blocked by:** 8  
    **User stories covered:** US5  
    **Vertical slice:** Implement `pithos complete` and `pithos fail` with fencing-token checks, result JSON/reason storage, completed/failed events, stale-token exit code, tests for success and stale completion rejection.

11. **Title:** Attach a worker completion artifact  
    **Status:** Built  
    **Type:** AFK  
    **Blocked by:** 7, 10  
    **User stories covered:** US5, US6  
    **Vertical slice:** Add `artifacts` table, `pithos artifact add --task --run --kind --title --body-file`, show artifacts in `inspect task`, tests for adding and retrieving a worker-completion report.

12. **Title:** Tail recent events for debugging  
    **Status:** Built  
    **Type:** AFK  
    **Blocked by:** 6, 7, 8, 10  
    **User stories covered:** US6  
    **Vertical slice:** Implement `pithos tail --limit`, render event rows in stable JSON/text, include task/run references, test ordering and limit behaviour.

13. **Title:** Sweep expired leases into retry/dead-letter state  
    **Status:** Built  
    **Type:** AFK  
    **Blocked by:** 8, 10, 12  
    **User stories covered:** US8  
    **Vertical slice:** Implement `pithos sweep`, requeue expired tasks under `max_attempts`, dead-letter exhausted tasks, mark stale runs by heartbeat age, append events, tests for requeue and dead-letter paths.

14. **Title:** Render a minimal Pandora briefing  
    **Status:** Built  
    **Type:** AFK  
    **Blocked by:** 7, 10, 11, 12, 13  
    **User stories covered:** US7  
    **Vertical slice:** Implement `pithos briefing --agent pandora`, markdown output with `as_of_event_id`, sections for active/done/failed/stale based on current DB rows, tests for watermark and inclusion of completed artifact summary.

15. **Title:** Provide agent-usable CLI help contracts  
    **Status:** Built  
    **Type:** AFK  
    **Blocked by:** 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14  
    **User stories covered:** US10  
    **Vertical slice:** Ensure top-level and subcommand `--help` exists for all MVP commands, includes examples and exit codes, snapshot/help tests, and validates the design principle that agents use help instead of memorised flags.

16. **Title:** Scaffold `@pithos/spawner` package with templates and dispatch hook
    **Status:** Built
    **Type:** AFK
    **Blocked by:** 15
    **User stories covered:** US10
    **Spec:** `docs/specs/spawner-spec.md` (authoritative — read this before starting).
    **Vertical slice:** Create a new workspace package `packages/spawner` (workspace name `@pithos/spawner`, global bin `pandora-spawn`). Ship template files `templates/{_common.md, envy.md.tmpl, toil.md.tmpl}`, a single hook script `hooks/claude-code/dispatch.sh`, frontmatter parser + `{{var}}` renderer, and a claude/fake harness module. Default verb is spawn (`pandora-spawn --agent envy --scope ...`); fake harness emits `{ env, argv, prompt }` JSON instead of execing claude. **Quality bar is intentionally lower than `@pithos/cli`** — minimal Effect plumbing, no tagged-error hierarchy, ONE Vitest snapshot smoke test exercising the fake harness end-to-end. No agent files in `.claude/agents/`; templates live entirely inside this package so they don't leak into consumer repos. Drop the `skills/pithos-cli/SKILL.md` direction — its content moves into `templates/_common.md` as a partial. See spec §2 for the strict simplicity bar.

17. **Title:** Wire heartbeat/SessionEnd hook via `pandora-spawn hooks install`
    **Status:** Built
    **Type:** AFK
    **Blocked by:** 9, 16
    **User stories covered:** US4, US9
    **Vertical slice:** Add `pandora-spawn hooks install` (and `uninstall`) which idempotently merges two entries into `~/.claude/settings.json`: `PreToolUse` (no matcher) and `SessionEnd` (matcher `prompt_input_exit` only — `Stop` would fire every assistant turn, and `clear`/`resume` matchers don't end the process). Both call `hooks/claude-code/dispatch.sh` with the hook name as argv. The script no-ops unless `PITHOS_AGENT` is set, then dispatches to `pithos heartbeat --throttle-seconds 60` (default) or `pithos run end --status ended` (SessionEnd). No tests for the bash script — manual smoke after install. Hooks live globally, not per-repo, so consumer repositories stay clean.

18. **Title:** Reuse spawner fake harness for deterministic spawn tests
    **Status:** Built
    **Type:** AFK
    **Blocked by:** 16
    **User stories covered:** US9, US10
    **Vertical slice:** The fake harness from slice 16 is the deliverable. This slice is the conceptual hook for any _additional_ tests outside `packages/spawner` that need to assert against spawn behaviour without real Claude. Likely no new code is required; close as "subsumed by 16" if no other consumer needs it by the time we get here.

19. **Title:** Document explicit spawn flow for Envy
    **Status:** Built
    **Type:** AFK
    **Blocked by:** 6, 15, 16
    **User stories covered:** US9, US10
    **Vertical slice:** Write a `packages/spawner/README.md` with the demo command sequence: `pithos init && pithos scope upsert ... && pithos enqueue ... && pandora-spawn --agent envy --scope ...`. Verify the spawned run appears in `pithos inspect run`. Include a `--harness fake` variant for offline reproduction. No automatic spawning; explicit only.

20. **Title:** Run the first manual end-to-end Pithos demo  
    **Status:** Built  
    **Type:** HITL  
    **Blocked by:** 13, 14, 16, 17, 19  
    **User stories covered:** US11  
    **Vertical slice:** Human/Pandora runs one complete flow: init, scope, Pandora → Toil → Envy → worker delegation, artifact add, complete, briefing. This flow has now been proven end-to-end with Envy claiming `implement`, a separate worker sub-session performing the repo mutation, `worker-completion` artifact attachment, and successful final verification.

21. **Title:** Prove real Claude can run in an isolated container test  
    **Status:** Blocked - current implementation needs refining from user, do not build this step
    **Type:** HITL  
    **Blocked by:** 20  
    **User stories covered:** US9, US11  
    **Vertical slice:** First experimental full-suite test that spawns real Claude inside a Docker/Podman container or otherwise isolates Claude/tmux-like integration from Adam's real sessions. Use `--model haiku`. Adam must be present because auth, filesystem mounts, tool permissions, session logging, networking, and container/Podman quirks may require live decisions. This is explicitly not part of the AFK repo-foundation smoke test; most harness tests should continue to use fake Claude.
