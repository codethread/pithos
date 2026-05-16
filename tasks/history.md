# Task history

Compact triage notes preserved while clearing completed task noise. Completed task implementation details live in git history; this file keeps only durable observations, UX concerns, and unresolved follow-ups worth re-triaging.

## Addressed historical notes

- **CLI surface cleanup** — removed/retired command surfaces remain absent: no `sweep`, no `run end`/`run finish`, no flat task aliases, and no `pithos graph inspect --hide-terminal`. Current surfaces are nested (`pdx daemon status`, `pdx daemon logs`, `pdx run kill`, `pdx run transcript`, `pdx task kill`) and machine-readable help exists for Pithos/pdx.
- **Non-held task kill UX** — `pdx task kill <task-id>` fails loudly when the task is not held and points operators to `pithos task cancel` for non-held abandonment.
- **Supervisor lifecycle invariants** — current pdx code has evidence for spaced reconcile ticks, Pandora singleton spawning/open readiness, SIGTERM-to-SIGKILL kill retries with structured logs, cap accounting that includes terminating entries, pidfiles surviving until cleanup/orphan discovery, no-claim timeout only for never-claimed non-Pandora runs, and tmux orphan cleanup excluding `pdx--daemon`.
- **Template/rendering fixes** — pdx recursively seeds nested template directories; includes are raw text and not recursively rendered; unknown template vars fail loudly; `{{command_cards}}` renders Markdown instead of raw JSON.
- **Pandora sitrep UX** — bundled Pandora guidance now points from discovered IDs to `pithos task inspect <task-id>` and `pdx run transcript <run-id>` rather than vague daemon/supervisor inspection.
- **Graph source-link rendering decision** — readable `pithos task inspect` labels source links as continuation/repair provenance. Readable `pithos graph inspect` intentionally omits source-edge labels; source edges and `source_kind` are available in `--json`.

## Remaining triage candidates

These are the only old notes with enough evidence to remain actionable:

- **Stable surface coverage gaps** — most Pithos/pdx JSON shapes have inline assertions, but `pandora-spawn preview --help`, pdx per-subcommand human help, and a snapshot-update workflow are not covered.
- **Durable event payload schema coverage** — event row shape is parsed, but most per-event payloads lack typed schemas and full payload assertions; existing assertions are mostly ad hoc `JSON.parse` checks.
- **Race/lifecycle edge coverage** — fencing rollback and no-claim timeout have tests, but simultaneous claim races and mixed-state supersede dependents still lack direct coverage.
- **Error-code/performance hardening** — several error paths assert `PithosError` without checking the machine-readable `code`; `STALE_TOKEN_RACE` deserves explicit code coverage. No `pithos graph inspect --all` performance smoke exists.
- **Run vs agent nomenclature** — `UBIQUITOUS_LANGUAGE.md` now distinguishes Run, Agent kind, Agent run, Harness, and Harness session, but the pending follow-up remains a product/API review: either keep current terms with rationale or plan a complete rename across CLI/API, DB/events, specs, READMEs, templates, tests, and task language. No opportunistic partial rename.
