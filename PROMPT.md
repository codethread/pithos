# Single-slice implementation prompt

Your job: complete **exactly one** approved slice from `TASKS.md`, end-to-end, then stop.

## Required reading

Read these before choosing work:

- `TASKS.md`
- `specs/task-graph.md`
- `packages/cli/AGENTS.md`
- `packages/cli/README.md`
- `packages/cli/CONTRIBUTING.md`

Then read any code/test files relevant to the slice you choose.

## Slice selection

Pick **exactly one** slice from `TASKS.md` using these rules:

1. A slice is eligible only if:
   - `**Status:** pending`
   - every slice listed in `**Blocked by:**` has `**Status:** complete`
2. If multiple slices are eligible, pick the **lowest-numbered** slice.
3. Do **not** work on more than one slice in a run.
4. Do **not** start a blocked slice.

## Workflow

1. In `TASKS.md`, change the chosen slice from `**Status:** pending` to `**Status:** in_progress`.
2. Implement the slice fully, following:
   - its `Scope`
   - its `Must implement exactly`
   - its `Done when`
   - all repo/package rules in `AGENTS.md`
3. Update all required code, tests, command help, and docs for that slice.
4. Run the project validation required by the repo rules. At minimum, finish with:
   - `pnpm verify`
5. If validation fails, fix it before stopping.
6. When the slice is fully complete, update `TASKS.md`:
   - change `**Status:** in_progress` to `**Status:** complete`
7. Commit with detailed status
8. Stop. Do not begin another slice.

## Boundaries

- Stay within the chosen slice.
- Do not pre-implement future slices unless strictly required to complete the chosen slice’s published contract.
- Do not weaken tests or contracts to make validation pass.
- Fail loudly. Preserve DB integrity. Keep outputs deterministic.

## Output contract

### If you completed the slice successfully

Reply with exactly:

`COMPLETE`

and **nothing else**.

### If you cannot complete the slice

Reply with exactly one of:

- `BLOCKED` — a real blocker prevents completion
- `NO_TASKS_REMAIN` — no eligible pending slice exists

Do not include any extra text.
