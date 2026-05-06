# Agent rules

These rules are non-negotiable.

## Build and run

```sh
pnpm install
pnpm run build
pithos --help
```

Fast dev run without the full build/link pipeline:

```sh
pnpm --filter @pithos/cli start --help
```

`pnpm run build` builds all workspace packages and links the `pithos` and `pandora-spawn` bins onto the global PATH via `package.json#bin`. The package scripts use esbuild directly; no `tsx`.

## 1. Checks pass between commits

Typecheck, lint, tests, build — all green before every commit. No "leftover issues", no "next commit". If it's broken, you broke it, you fix it now.

Never `--no-verify`. Never disable a failing test to make the bar green.

## 2. Fail loudly

No silent fallbacks. No swallowed exceptions. No defaulting to empty / zero / null when the real value is missing. Crash, raise, halt.

Errors are tagged and carry a machine-readable code, not free-form strings:

```ts
export class PithosError extends Data.TaggedError("PithosError")<{
  readonly code: ErrorCode;
  readonly message: string;
}> {}
```

### Database integrity is paramount

The DB is the source of truth. Corruption compounds — every subsequent write builds on the lie. Better everything stops than the DB drifts.

Validate fencing/preconditions, then write inside a transaction, and if a race is detected mid-transaction, throw to roll back — never "best-effort":

```ts
if (taskRows.length === 0) {
  // pre-check passed but UPDATE found no row: concurrent reclaim invalidated
  // the token. Throw to roll back the whole transaction.
  return (
    yield *
    Effect.fail(
      new PithosError({
        code: "STALE_TOKEN_RACE",
        message: "concurrent reclaim invalidated the token",
      }),
    )
  );
}
```

## 3. Strict types at the IO boundary

Anything crossing IO (stdin, CLI args, DB rows, files, subprocess output) gets parsed into a known shape before the rest of the code touches it. No `any`, no leaked `unknown`. Parse, don't validate-later. Failures `Effect.fail`.

```ts
const ScopeKindSchema = Schema.Literal("global", "repo", "worktree");

const kind =
  yield *
  Schema.decodeUnknown(ScopeKindSchema)(rawKind).pipe(
    Effect.mapError(
      () =>
        new PithosError({
          code: "VALIDATION_ERROR",
          message: `Invalid --kind value: '${rawKind}'. Valid values: global, repo, worktree`,
        }),
    ),
  );
```

### Discriminated unions over optional bags

If two states cannot coexist, the type must say so. Tagged variants, not wide interfaces full of optionals.

```ts
export type ParsedArgs =
  | { command: "version" }
  | { command: "help"; topic?: string }
  | { command: "init" }
  | { command: "scope:upsert"; kind: ScopeKind; path: string | undefined };
// ...
```

## 4. Agent-first observability

The runtime is headless. Agents have no debugger, no UI — only what the system writes down. Write things down.

- **Structured logs only.** Use `Effect.log*` with `Effect.annotateLogs` for context (ids, inputs, outcomes). No `console.log`, no bare strings.
  ```ts
  yield *
    Effect.logDebug("task completed").pipe(
      Effect.annotateLogs({ taskId, runId }),
    );
  ```
  The logger emits JSON to stderr with span labels, level, timestamp, and annotations.
- **Wrap non-trivial units of work in `Effect.withSpan`.** Spans give the causal tree; logs alone are flat. Span labels appear in every log line emitted inside the span.
- **Errors carry context.** A `PithosError` with `code` + `message` an agent can grep beats a generic stack trace. No interactive-only debug paths — if the only way to understand a failure is attaching a debugger, add the log / span / structured error first.
- **Session logs are the ground truth.** When investigating agent behavior during or after a run, inspect the harness JSONL session log first — not raw tmux capture. See `packages/spawner/README.md` for the session-log introspection recipe.

## Effect.ts

- This codebase uses effect.ts heavily, the source for Effect is at `~/dev/vendor/effect`
- Use dependency injection for DB, clock, IDs, filesystem, process execution, and Claude harness — see `packages/cli/src` for the pattern.

## Docs

- `README.md`: project intro, agent model, delegation chain, and current architecture
- `CONTRIBUTING.md`: build, verify, commit baseline, and doc map
- `AGENTS.md`: non-negotiable rules beyond what can be enforced statically, injected transparently into agents
- `packages/cli/README.md`, `packages/cli/CONTRIBUTING.md`: CLI surface, package quality bar, add-a-command checklist
- `packages/spawner/README.md`, `packages/spawner/CONTRIBUTING.md`: spawner surface, hook contract, session-log introspection, package constraints
- Each `packages/<package>/` repeats this pattern, providing more granular details as scope narrows

## Testing

- Use `vitest run --update` to fix snapshots after corrections, don't manually edit the snapshots.
