You are modularizing an oversized file in this repo. Optimize for sensible boundaries, not arbitrary file-count reduction.

First, inspect repo state and context:

- Run `git status --short` before editing.
- Read the relevant package/directory README and any directly relevant specs.
- Scan file sizes and identify the largest human-authored files. Ignore generated binaries, lockfiles, and build output unless the task is explicitly about them. If `tokei` and Nushell are available, use this quick VCS-tracked scan:

```nu
let paths = (
	git ls-files
	| lines
	| where {|path| $path != "pnpm-lock.yaml" }
)

^tokei --files --streaming json ...$paths
| lines
| each {|line| $line | from json }
| each {|row|
	let path = $row.stats.name
	let stats = $row.stats.stats
	{
		path: $path
		lines: ($stats.code + $stats.comments + $stats.blanks)
		code: $stats.code
		bytes: (ls $path | get size.0)
	}
}
| sort-by lines --reverse
| first 20
```

For an ignore-aware working-tree scan instead of only tracked files, replace the `paths` block with:

```nu
let paths = (
	fd --type file --exclude pnpm-lock.yaml
	| lines
)
```

- Pick the target file only after briefly mapping its major regions, responsibilities, imports/exports, and public consumers.

Refactor approach:

- Preserve behavior. This is a refactor, not a feature change.
- Extract only natural seams: public contracts/types, pure render/format helpers, parsers, query builders, read models, domain transition families, or cohesive domain sub-areas.
- Optimize for **focus boundaries**, not line movement: after the split, a future developer should be able to change one concept mostly inside the new module plus tests/specs, without first reading the original large file.
- Prefer modules that own a complete reason to change:
  - read/query shape, e.g. row parsing plus reusable read-model queries
  - graph/query assembly, e.g. selector filtering plus closure construction
  - domain side effects, e.g. alert creation plus provenance/event writes
  - lifecycle families, e.g. claim/heartbeat/complete/fail/cancel transitions sharing fencing-token invariants
- Treat helper-only extraction as suspicious. Moving helper functions can be useful only when the helper set has a nameable concept and stable consumers. Otherwise it is busy work.
- Do not create artificial wrappers, one-function files, compatibility shims, or abstraction layers just to reduce line count.
- Do not create a generic `common`, `utils`, or `support` module as the first move. These usually become the new junk drawer. Use a narrow name only when the concept is clear (`read-model`, `claim-loop`, `repair-alerts`, `admission`, etc.).
- Keep public package boundaries stable. Consumers should still import from documented package roots unless the task explicitly changes the API.
- Keep dependency direction simple. Avoid circular imports and sibling `src/*` imports from other packages.
- Prefer callee-owned narrow dependency interfaces over importing the original large module. Passing a few cross-cutting functions can be acceptable when it avoids cycles and makes the new module's needs explicit.
- Preserve transaction boundaries. If moving transactional code, move the whole transaction body together or keep helper calls inside the caller's existing transaction. Document any `InTxn` helper contract.
- Update README/docs when module layout or public boundaries change.
- After extraction, scan specs and docs for stale references to the old file as the sole implementation location. Update them to mention the new module set or package boundary where appropriate.

Boundary quality check:

Before extracting, write down the candidate module's responsibility in one sentence. If the sentence is "shared helpers used by X" or "stuff from the big file", do not extract yet.

Ask:

- What user/domain behavior or invariant does this module own?
- Which future change should be doable mostly inside this module?
- Which tests/specs would a developer read for this module?
- Are call sites now easier to reason about, or did we just add import hops?
- Did we move trigger policy away from the transition that detects it? If yes, reconsider. Trigger decisions often belong with lifecycle transitions; shared side-effect creation can live in a domain module.
- Did we leave duplicated tiny validation helpers? A small duplicate may be better than a one-function module; avoid "cleanup" that only creates indirection.

Lessons from this repo:

- Good: `task-read-model` owns DB row parsing and reusable task/scope read queries.
- Good: `graph-inspect` owns graph filters, `--since` parsing, and closure assembly.
- Good: `repair-alerts` owns Repair Alert task creation, repair provenance, launch-precondition repair, and claimable alert queries; lifecycle transitions still own when alerts fire.
- Good: `claim-loop` owns claim, heartbeat, completion, failure, cancellation, artifact attachment, and the fencing-token/held-task invariants shared by those transitions.
- Busy work: extracting random helpers out of the oversized file without a domain name; creating a generic `common.ts`; moving one function just because it is long; splitting operation methods into wrappers while the original file still contains the real logic.

Tests during refactor:

- If extracting pure behavior, add small public-boundary characterization tests for the moved helpers.
- Prefer tests that assert observable behavior through stable exports, not private implementation details.
- For moved transition families, existing public Engine/CLI tests may be enough when behavior is unchanged and coverage already exercises the moved transitions. Do not add private-module tests just because a file moved.
- Treat scaffold tests as temporary only if they are purely mechanical safety rails; keep them if they protect a real public contract.
- Run focused validation after each meaningful extraction.

Review gate:

- After the refactor compiles and focused tests pass, seek code review before deleting any scaffold tests or committing.
- Include doc/spec alignment in the review brief when files moved or package boundaries changed.
- Address review findings, then re-run validation.

Validation and commit:

- Run the relevant package checks first, then the full project verification (`pnpm verify`) before committing.
- Stage only intended files.
- Commit atomically with a conventional-ish message, explaining why the split improves maintainability.

Report back concisely with:

- files split/created
- tests added/kept/removed and why
- review result
- validation run
- commit hash, if committed
