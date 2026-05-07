# Slice 11 — Cutover: retire `packages/cli/`, point `pithos` bin at new package

## What to build

Mechanical cutover from the legacy CLI package to the new Pithos package built in slices 1–3. No behavioral changes; this slice is plumbing only.

- Delete `packages/cli/` in its entirety (sources, tests, README, CONTRIBUTING).
- Move the `pithos` bin name from the old package to `packages/pithos/`. The temporary `pithos-next` bin is renamed/dropped.
- Update spawner `claim_command` rendering so the emitted command line uses `pithos` (not `pithos-next`).
- Update workspace plumbing: `pnpm-workspace.yaml`, root `package.json` scripts, any `pnpm --filter @pithos/cli ...` references.
- Update docs that reference the old package path: root `README.md`, `CONTRIBUTING.md`, `AGENTS.md`, `packages/spawner/README.md`, `packages/pdx/README.md`, `specs/README.md` code-reference column for the task-graph spec.
- Verify a clean install pipeline: `pnpm install && pnpm run build && pithos --help && pithos init --fresh && pdx --help` all succeed.

This slice has no new feature work and no new tests beyond a build smoke. Existing tests from prior slices must continue to pass.

## Test focus

- Build smoke: `pnpm verify` (or whatever the project's full verify command is) passes after cutover
- No remaining references to `packages/cli/` paths (string grep across repo)
- `pithos` bin resolves to the new package on a fresh `pnpm install`
- `pandora-spawn preview` for each agent emits a `claim_command` that starts with `pithos` (not `pithos-next`)

## Acceptance criteria

- [ ] `packages/cli/` deleted
- [ ] `pithos` bin shipped from `packages/pithos/`; `pithos-next` retired
- [ ] Spawner `claim_command` rendering updated
- [ ] All workspace plumbing and docs updated; no stale references
- [ ] `pnpm install && pnpm run build && pithos --help && pdx --help` all succeed on a fresh checkout

## Blocked by

- Slice 1 (task-001)
- Slice 2 (task-002)
- Slice 3 (task-003)
- Slice 4 (task-004)
- Slice 5 (task-005)
- Slice 6 (task-006)
- Slice 7 (task-007)
- Slice 8 (task-008)
- Slice 9 (task-009)
- Slice 10 (task-010)
