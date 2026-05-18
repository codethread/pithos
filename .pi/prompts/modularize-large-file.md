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
- Extract only natural seams: public contracts/types, pure render/format helpers, parsers, query builders, domain sub-areas, or cohesive helper groups.
- Do not create artificial wrappers, one-function files, compatibility shims, or abstraction layers just to reduce line count.
- Keep public package boundaries stable. Consumers should still import from documented package roots unless the task explicitly changes the API.
- Keep dependency direction simple. Avoid circular imports and sibling `src/*` imports from other packages.
- Update README/docs when module layout or public boundaries change.

Tests during refactor:

- If extracting pure behavior, add small public-boundary characterization tests for the moved helpers.
- Prefer tests that assert observable behavior through stable exports, not private implementation details.
- Treat scaffold tests as temporary only if they are purely mechanical safety rails; keep them if they protect a real public contract.
- Run focused validation after each meaningful extraction.

Review gate:

- After the refactor compiles and focused tests pass, seek code review before deleting any scaffold tests or committing.
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
