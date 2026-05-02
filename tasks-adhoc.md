# Pithos ad hoc tracer-bullet slices

**Status:** Unimplemented
**Priority:** Process this queue before `tasks.md`.
**Scope:** Observability, diagnostics, and quick repair slices that keep the service easy to introspect.

## Slices

1. **Title:** Centralize CLI output behind an Effect service  
   **Status:** Implemented  
   **Type:** AFK  
   **Blocked by:** none  
   **Vertical slice:** Route command JSON/text emission through a shared `Output` service with live stdout/stderr sinks and test sinks that can buffer or write to temp files. Replace direct `console.log` calls in the command path so tests can silence or capture output without noisy global interception.

2. **Title:** Separate diagnostics from user-visible output  
   **Status:** Implemented  
   **Type:** AFK  
   **Blocked by:** 1  
   **Vertical slice:** Add a small logging boundary for structured diagnostics, using Effect logging/spans for breadcrumbs, warnings, and debug context. Keep it distinct from CLI output so command contracts stay stable while observability can be turned up on demand.

3. **Title:** Add metrics and spans for high-observability runs  
   **Status:** Implemented  
   **Type:** AFK  
   **Blocked by:** 1, 2  
   **Vertical slice:** Wire Effect metrics and spans into a first-class observability layer. Track command durations, task claim/heartbeat counts, stale-token failures, and sweep outcomes with OTLP-friendly composition.

4. **Title:** Capture test output deterministically  
   **Status:** Implemented  
   **Type:** AFK  
   **Blocked by:** 1  
   **Vertical slice:** Replace raw stdout assertions and console interception in tests with output sinks or temp-file captures. Keep Vitest output quiet unless a test explicitly opts into the captured stream.

5. **Title:** Migrate all custom IO validation to Effect.Schema  
   **Status:** Implemented  
   **Type:** AFK  
   **Blocked by:** none  
   **Vertical slice:** Replace manual if/else allowlist checks at IO boundaries (CLI args, DB rows, subprocess output) with `Schema.Literal` / `Schema.Struct` / `Schema.decodeUnknown` pipelines. No hand-rolled type guards where a schema can do it. Error codes must reflect the source: `VALIDATION_ERROR` for untrusted external/user input (CLI args, stdin); `INTERNAL_ERROR` or a more specific code for DB row shape violations or unexpected subprocess output, which signal contract/integrity failures rather than user mistakes.

6. **Title:** Replace bare `throw` with `Effect.fail`  
   **Status:** Implemented  
   **Type:** AFK  
   **Blocked by:** none  
   **Vertical slice:** Audit the codebase for bare `throw new Error(...)` / `throw someValue` in application/domain/command code and replace each with `return yield * Effect.fail(new PithosError(...))`. Legitimate surviving throws: (a) SQLite transaction callbacks where throw is the only rollback mechanism, and (b) non-generator callbacks adapted by an `Effect.try` / `Effect.tryPromise` boundary, where the throw is intentionally bridging an exception-based API into Effect. Document each surviving throw with a comment explaining the constraint.

7. **Title:** Migrate DB layer to `@effect/sql-sqlite-node`  
   **Status:** Implemented  
   **Type:** AFK  
   **Blocked by:** 5  
   **Vertical slice:** Replace the hand-rolled `better-sqlite3` layer with `@effect/sql-sqlite-node` (the official Effect SQLite adapter). Use `Schema.Class<T>` from `@effect/sql` for typed row decoding at the DB boundary — eliminating manual `unknown` casts and ad-hoc row validation. Note: `updateValues` is not supported by the adapter; raw SQL must be used for those queries. This task is blocked by task 5 (Effect.Schema adoption) so row schemas are defined consistently before wiring them into the SQL layer.

8. **Title:** Spike declarative CLI parser APIs  
   **Status:** Built  
   **Type:** AFK  
   **Blocked by:** none  
   **Vertical slice:** Create explicitly throwaway scratch code to investigate both `@effect/cli` and `clipanion` for Pithos-shaped command trees: nested subcommands (`scope upsert`, `run register`, `artifact add`, `inspect task <id>`), options, positional arguments, generated help, unknown-command behavior, and whether command execution can call Effect programs cleanly. This spike is allowed to add scratch files that are not wired into production and do not need to pass the normal test suite; the output is a short written recommendation in the queue item or an adjacent note explaining which library/API to use and why. Do not migrate production parser code in this slice. Outcome: see `notes/cli-parser-spike.md`. Provisional recommendation: use `clipanion` for slice 9 only if it can preserve Pithos help invariants cleanly and the team accepts the `4.0.0-rc.4` dependency risk; otherwise fall back to `@effect/cli`.

9. **Title:** Add a declarative CLI parser layer  
   **Status:** Unimplemented  
   **Type:** AFK  
   **Blocked by:** 8  
   **Vertical slice:** Replace the hand-written `parseArgs` + hardcoded help strings in `dispatch.ts` with the declarative CLI parser library selected by slice 8. Prefer `@effect/cli` if the spike proves it supports Pithos-shaped subcommands and generated help cleanly; otherwise use `clipanion` only with its full command-execution API, not a hybrid parser adapter. Once done: (a) drop `help-cli.integration.test.ts` — the library owns help correctness, and (b) delete all per-command `--help` snapshot tests. Keep only the agent-usability invariants (every command has `--help`/`-h`, help mentions required sections) as lightweight contract checks against the library's output.
