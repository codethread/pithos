# Declarative CLI parser spike

Task 8 scratch work for comparing `@effect/cli` vs `clipanion` against a Pithos-shaped command tree.

## Scratch files

- `scratch/cli-parser-spike/package.json`
- `scratch/cli-parser-spike/scripts/spike-effect-cli.mjs`
- `scratch/cli-parser-spike/scripts/spike-clipanion.mjs`

Run from repo root:

```sh
pnpm --dir scratch/cli-parser-spike install --ignore-workspace
node scratch/cli-parser-spike/scripts/spike-effect-cli.mjs --help
node scratch/cli-parser-spike/scripts/spike-effect-cli.mjs scope upsert --help
node scratch/cli-parser-spike/scripts/spike-effect-cli.mjs complete task_1 --run run_1 --token 7
node scratch/cli-parser-spike/scripts/spike-effect-cli.mjs scoep

node scratch/cli-parser-spike/scripts/spike-clipanion.mjs --help
node scratch/cli-parser-spike/scripts/spike-clipanion.mjs scope upsert --help
node scratch/cli-parser-spike/scripts/spike-clipanion.mjs complete task_1 --run run_1 --token 7
node scratch/cli-parser-spike/scripts/spike-clipanion.mjs scoep
```

## What was tested

Both spikes model these Pithos-style shapes:

- nested subcommands: `scope upsert`, `run register`, `artifact add`, `inspect task`
- top-level leaf commands: `claim`, `complete <task-id>`
- options and positionals together
- generated help
- unknown-command behavior
- calling Effect programs from command execution

## Findings

Observed validation behavior from the scratch runs:

- `node scratch/cli-parser-spike/scripts/spike-clipanion.mjs complete task_1 --run run_1 --token 7` succeeded and emitted JSON with numeric `"token": 7`.
- `node scratch/cli-parser-spike/scripts/spike-clipanion.mjs complete task_1 --run run_1 --token 1.5` failed with `Invalid value for --token: expected to be an integer`.
- `node scratch/cli-parser-spike/scripts/spike-clipanion.mjs scope upsert --kind nope` failed with `Invalid value for --kind: expected one of "global", "repo", or "worktree"`.


| Area | `@effect/cli` | `clipanion` |
| --- | --- | --- |
| Nested subcommands | Works | Works |
| Options + positionals | Works, including `complete task_1 --token 7` | Works |
| Effect integration | Excellent: handlers are native `Effect`s | Fine: call `Effect.runPromise` in `execute()` |
| Help generation | Functional, but leaf help rendered usage as `$ upsert` instead of full path `pithos scope upsert`; always includes built-ins like `--wizard`, `--completions`, `--log-level` | Stronger in this spike: full command path shown, examples/details/categories render well |
| Unknown command UX | Non-zero exit, but terse; no suggestion list in the spike | Stronger: non-zero exit and "did you mean" suggestions |
| Validation fit | Native parsers for choices/integers; still emits library `ValidationError`, not `PithosError` | Verified in the scratch runs: parser-level enum/int validation works via Typanion, but production Pithos should still re-decode with `Effect.Schema` to keep one IO-boundary contract |
| Style fit | Data-first and Effect-native | Class-based and less Effect-native |
| Release maturity | Stable and aligned with Effect ecosystem | Current npm release is still `4.0.0-rc.4` |

## Recommendation

**Provisional recommendation:** use **Clipanion** for slice 9 only if two gates hold: (1) a first migration pass confirms Pithos can preserve its agent-facing help invariants (`Usage`, `Examples`, `Exit codes`, and top-level environment documentation) without awkward custom patching, and (2) the team is willing to accept a parser dependency that is still published as `4.0.0-rc.4`.

Why this is still provisional:

- This spike compared command-tree fit, generated help style, unknown-command UX, and Effect execution.
- It did **not** fully model every current help-contract detail from `packages/cli/test/help-cli.integration.test.ts`, especially custom `Exit codes` and top-level env-var sections.

Why Clipanion is the current front-runner if those gates are acceptable:

> Caveat: this was not a perfectly normalized help bake-off. The Clipanion spike used richer per-command metadata (`category`, `details`, `examples`) than the Effect spike. So the observed help-quality gap reflects both library defaults and how naturally each spike exposed help metadata.

1. Pithos cares heavily about agent-usable help output; Clipanion's generated help was materially better in the spike.
2. Pithos also benefits from better unknown-command UX; Clipanion gave suggestions out of the box.
3. The main downside is validation duplication / non-Effect-native execution. The spike showed Typanion can enforce parser-level enum/integer constraints, but Pithos should still treat Clipanion as argv/help/dispatch only and immediately decode command fields with `Effect.Schema` before command logic.

Fallback if the RC risk is unacceptable: prefer `@effect/cli` and accept weaker built-in help/UX rather than taking a prerelease parser into production.

Why not `@effect/cli` right now:

- It did handle the command tree and native `Effect` execution cleanly.
- But the help output was not clean enough for Pithos's agent-facing contract in this spike: leaf help lost the full command path, and the built-in option surface was noisy.
- Its parse failures also do not naturally map to Pithos's tagged error-code contract.

## Suggested adoption shape for slice 9

- Register full commands in Clipanion; do **not** build a hybrid parser adapter.
- Keep command `execute()` methods thin.
- Inside each `execute()`, pass parsed values into existing Effect command programs through a small adapter layer.
- Re-decode/normalize CLI strings with `Effect.Schema` at the boundary so Pithos keeps its strict IO contract.
