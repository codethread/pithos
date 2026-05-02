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

**Final recommendation:** choose **`@effect/cli`** for slice 9.

Why the recommendation changed:

- After rechecking vendored Effect source, the earlier spike was clearly underusing real `@effect/cli` capability.
- In particular, `@effect/cli` has first-class schema hooks (`Args.withSchema`, `Options.withSchema`), richer `HelpDoc` composition than the first spike exercised, and `CliConfig.showBuiltIns` to suppress built-in help noise.
- For this codebase, those typed parser and Effect/Schema integration advantages outweigh Clipanion's better generated-help polish and typo UX.

What still favors Clipanion:

> Caveat: this was not a perfectly normalized help bake-off. The Clipanion spike used richer per-command metadata (`category`, `details`, `examples`) than the Effect spike. So the observed help-quality gap reflects both library defaults and how naturally each spike exposed help metadata.

1. Clipanion's generated help looked better in the spike.
2. Clipanion's unknown-command UX was stronger out of the box.
3. Clipanion kept full command paths visible in leaf help more naturally for the Pithos-shaped tree.

Why `@effect/cli` still wins for Pithos:

1. First-class Effect/Schema integration is a better fit for Pithos's strict IO-boundary rules.
2. Parser outputs are more naturally typed at the boundary (`integer`, `choice`, `withSchema`) with less adapter work.
3. The parser library is stable and already aligned with the rest of the stack; no `4.0.0-rc.4` dependency risk.
4. A small presentation adapter around parse failures is acceptable and cleanly decouples parser semantics from CLI rendering.

Remaining caution with `@effect/cli`:

- Leaf help path rendering was still weaker in the spike/retest (`$ upsert` instead of `pithos scope upsert`).
- Subcommand typo/unknown-command UX was still weaker than Clipanion.
- Slice 9 should intentionally compensate by using richer help metadata and keeping lightweight help-contract tests focused on agent usability.

## Suggested adoption shape for slice 9

- Use `@effect/cli` end to end; do **not** build a hybrid parser adapter.
- Attach schemas directly at the parser boundary with `Args.withSchema` / `Options.withSchema` where helpful.
- Use `CliConfig.showBuiltIns` and richer `HelpDoc` composition deliberately instead of relying on defaults.
- Keep a small presentation adapter around parse failures so Pithos still emits the error/message shape it wants.
