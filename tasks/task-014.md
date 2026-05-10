# Task 014: Run versus agent nomenclature follow-up

## Status

Pending follow-up after task 013. Do not opportunistically rename during API cleanup.

## Scope

Revisit user/operator-facing nomenclature around `run`, `agent`, `agent run`, and harness session after the API cleanup lands.

## Acceptance

- `UBIQUITOUS_LANGUAGE.md` clearly distinguishes durable invocation records from user-facing agent operations.
- Pithos and pdx CLI/API names are reviewed for places where `agent` is clearer than `run`.
- Any rename plan accounts for DB schema, events, specs, README docs, templates, tests, and task language.
- No opportunistic partial rename: either keep current terms with clarified rationale or execute a complete planned rename.
