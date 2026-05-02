# Pithos MVP tracer-bullet slices

**Status:** Ready for implementation  
**Source specs:** `mvp-spec.md`, `technical-design.md`

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
    **Status:** Unbuilt  
    **Type:** AFK  
    **Blocked by:** 6, 7, 8, 10  
    **User stories covered:** US6  
    **Vertical slice:** Implement `pithos tail --limit`, render event rows in stable JSON/text, include task/run references, test ordering and limit behaviour.

13. **Title:** Sweep expired leases into retry/dead-letter state  
    **Status:** Unbuilt  
    **Type:** AFK  
    **Blocked by:** 8, 10, 12  
    **User stories covered:** US8  
    **Vertical slice:** Implement `pithos sweep`, requeue expired tasks under `max_attempts`, dead-letter exhausted tasks, mark stale runs by heartbeat age, append events, tests for requeue and dead-letter paths.

14. **Title:** Render a minimal Pandora briefing  
    **Status:** Unbuilt  
    **Type:** AFK  
    **Blocked by:** 7, 10, 11, 12, 13  
    **User stories covered:** US7  
    **Vertical slice:** Implement `pithos briefing --agent pandora`, markdown output with `as_of_event_id`, sections for active/done/failed/stale based on current DB rows, tests for watermark and inclusion of completed artifact summary.

15. **Title:** Provide agent-usable CLI help contracts  
    **Status:** Unbuilt  
    **Type:** AFK  
    **Blocked by:** 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14  
    **User stories covered:** US10  
    **Vertical slice:** Ensure top-level and subcommand `--help` exists for all MVP commands, includes examples and exit codes, snapshot/help tests, and validates the design principle that agents use help instead of memorised flags.

16. **Title:** Add minimal Claude agent files and pithos Skill  
    **Status:** Unbuilt  
    **Type:** HITL  
    **Blocked by:** 15  
    **User stories covered:** US10  
    **Vertical slice:** Add `.claude/agents/envy.md`, `.claude/agents/toil.md`, minimal `skills/pithos-cli/SKILL.md`, preload Skill in frontmatter, and human-review prompts for tone/scope so agents do not overreach.

17. **Title:** Wire Claude hook heartbeat wrappers  
    **Status:** Unbuilt  
    **Type:** AFK  
    **Blocked by:** 9, 15  
    **User stories covered:** US4, US9  
    **Vertical slice:** Add hook scripts that read `PITHOS_RUN_ID`, call `pithos heartbeat --hook ... --throttle-seconds 60`, and call `pithos run end` on SessionEnd; include shell tests or dry-run tests with fake env vars. For StopFailure, record a heartbeat with hook context only; no `run event` command exists in MVP. Keep all hook tests isolated from real Claude/tmux sessions.

18. **Title:** Add fake Claude harness for deterministic spawn tests  
    **Status:** Unbuilt  
    **Type:** AFK  
    **Blocked by:** 15, 17  
    **User stories covered:** US9, US10  
    **Vertical slice:** Add an injectable Claude harness interface and a fake Claude executable/process used in tests. The fake follows the expected command contract, accepts flags such as `--agent`, `--append-system-prompt`, and `--model`, emits stub responses/session IDs, and lets tests verify spawn/status flows without real Claude API calls.

19. **Title:** Document explicit spawn flow for Envy  
    **Status:** Unbuilt  
    **Type:** AFK  
    **Blocked by:** 6, 15, 16, 18  
    **User stories covered:** US9, US10  
    **Vertical slice:** Add README/demo command sequence: register run, launch `claude --agent envy --append-system-prompt ...`, pass `PITHOS_RUN_ID`, and verify run appears in `inspect run`; no automatic spawning. Include a test/demo variant using the fake Claude harness.

20. **Title:** Run the first manual end-to-end Pithos demo  
    **Status:** Unbuilt  
    **Type:** HITL  
    **Blocked by:** 13, 14, 16, 17, 19  
    **User stories covered:** US11  
    **Vertical slice:** Human/Pandora runs one complete flow: init, scope, run register, enqueue, claim, heartbeat, artifact add, complete, briefing. Capture friction and decide whether MVP is sufficient before adding daemon/spawn automation/recipe engine.

21. **Title:** Prove real Claude can run in an isolated container test  
    **Status:** Unbuilt  
    **Type:** HITL  
    **Blocked by:** 20  
    **User stories covered:** US9, US11  
    **Vertical slice:** First experimental full-suite test that spawns real Claude inside a Docker/Podman container or otherwise isolates Claude/tmux-like integration from Adam's real sessions. Use `--model haiku`. Adam must be present because auth, filesystem mounts, tool permissions, session logging, networking, and container/Podman quirks may require live decisions. This is explicitly not part of the AFK repo-foundation smoke test; most harness tests should continue to use fake Claude.
