# Task 1: Add review capability contract

## Scope

Type: AFK

Add `review` as a durable Pithos Capability and verify that it participates in claims, enqueues, task chaining, pdx launch policy, and Spawner claim rendering according to `specs/scoped-review-capability.md`.

## Must implement exactly

- Add `review` to the built-in capability contract and task row decoding.
- Let Greed claim `review` tasks in addition to `design` tasks.
- Let Pandora and Toil enqueue `review` tasks.
- Do not let Greed, War, or Envy enqueue `review` tasks.
- Do not let Pandora, Toil, War, or Envy claim `review` tasks.
- Update pdx supervision so claimable `review` tasks launch Greed with the task's Scope/cwd, without breaking Greed launch for `design` tasks.
- Update the pdx-to-Spawner launch/render boundary so pdx passes the selected ready task Capability when launching an agent.
- Update Spawner so agents with multiple claim capabilities do not fail render. For Greed, Spawner must render one deterministic `claim_command` for the launch-selected Capability, validate that the Capability is authorized for Greed, and fail loudly for invalid multi-claim render input.
- Treat `review` as an ordinary non-escalation capability for chain policy:
  - default auto chaining from held ordinary work to `review` creates a dependency, not a source link;
  - fan-in review remains expressible with `--chain none --depends-on ...`;
  - `escalate` special source-link behavior remains unchanged.
- Update tests that assert built-in seed data, claim/enqueue authorization, CLI/help capability surfacing, pdx launch policy, Spawner claim rendering, or chain policy Capability typing.

## Done when

- A Greed run can claim a queued `review` task in an isolated test DB.
- Pandora and Toil can enqueue `review` tasks in tests.
- Greed, War, and Envy enqueue attempts for `review` fail with the existing authorization error contract.
- pdx launch-policy tests or equivalent coverage prove Greed is selected for claimable `review` tasks as well as `design` tasks and passes the selected Capability to Spawner.
- Spawner tests prove Greed renders successfully with a launch-selected `design` Capability and a launch-selected `review` Capability, and fails loudly if a multi-claim render omits or provides an unauthorized selected Capability.
- Representative chain-policy tests prove `review` dependency-chains like `triage`, `design`, and `execute`, not like `escalate`.
- Relevant Pithos, pdx, and Spawner tests pass, including any updated help/CLI snapshots or assertions.

## Out of scope

- Full prompt/template workflow wording beyond the deterministic `claim_command` needed to render multi-claim Greed safely.
- Base spec and ubiquitous-language updates.
- New scope enforcement for `review`.
- Any `verify`, QA, or automated validation Capability.
- New Agent kinds.

## References

- `specs/scoped-review-capability.md`
- `packages/pithos/src/builtins.ts`
- `packages/pithos/src/chain-policy.ts`
- `packages/pithos/src/rows.ts`
- `packages/pithos/src/cli.ts`
- `packages/pdx/src/controller.ts`
- `packages/pdx/src/services.ts`
- `packages/spawner/src/spawner.ts`
- `packages/spawner/src/main.ts`
- `packages/pithos/test/foundation.test.ts`
- `packages/pithos/test/task-lifecycle.test.ts`
- `packages/pithos/test/chain-policy.test.ts`
- `packages/pithos/test/cli.test.ts`
- `packages/pdx/test/`
- `packages/spawner/src/spawner.test.ts`
