# Scoped Review Capability Task Plan

## Problem statement / MVP goal

Implement the planned scoped `review` capability change. The MVP adds `review` as a first-class Pithos Capability claimed by Greed, enqueueable by Pandora and Toil, and documented as an explicitly requested HITL assessment step rather than an automatic workflow gate. `review` should behave like ordinary dependency-chained work, while `escalate` remains global immediate Pandora attention/repair/routing.

## Important references

- `specs/task-graph.md` — durable task graph semantics and review-as-ordinary-work behavior.
- `specs/control-plane-supervision.md` — control-plane lifecycle, built-in claim/enqueue contract, and Greed/Pandora review behavior.
- `specs/agent-configuration.md` — built-in capability/agent configuration context if affected.
- `UBIQUITOUS_LANGUAGE.md` — domain terminology to update after implementation.
- `packages/pithos/src/builtins.ts` — built-in Agent kinds, Capabilities, claim rules, enqueue rules.
- `packages/pithos/src/chain-policy.ts` — chain policy Capability typing and escalation special-case behavior.
- `packages/pithos/src/rows.ts` — task capability row decoding.
- `packages/pdx/src/controller.ts` and `packages/pdx/src/services.ts` — supervision launch policy and capability unions.
- `packages/spawner/src/spawner.ts` — selected-capability claim command rendering for agents, including multi-claim Greed.
- `packages/pithos/test/`, `packages/pdx/test/`, `packages/spawner/src/spawner.test.ts` — behavior, seed, CLI/help, supervision, and prompt-rendering contract tests.
- `templates/_common.md`, `templates/greed.md`, `templates/pandora.md`, `templates/toil.md`, `templates/README.md` — prompt and template docs to update.

## Task strategy

The plan is split into AFK vertical slices. Task 1 makes `review` real in the durable Pithos contract and updates pdx/Spawner integration so Greed can be launched for, and claim, either `design` or `review` work. Task 2 updates canonical agent prompts so the new capability is usable without imposing review gates by default. Task 3 folds the temporary change spec into the permanent project docs and removes the change spec. Task 4 performs full validation and repairs any integration misses.

No HITL slices are required: the user has already decided the outstanding product questions for the MVP. Future QA/`verify` capability work is explicitly out of scope.

## Developer Notes

Append notes here. Do not rewrite earlier notes.

### Task plan amendment — 2026-05-17

- Deep review found that adding `review` to Greed claims affects pdx launch policy and Spawner claim rendering, not only Pithos built-ins. Task 1 now explicitly includes pdx/Spawner integration and tests.
- Task 2 now carries the prompt-only scope policy, global review payload requirements, rejected-review outcome behavior, and preview validation.
- Task 3 now includes the root `README.md` in permanent docs fold-in.

### Task 1 implementation — 2026-05-17

- Added `review` as a built-in Capability, Greed claim, and Pandora/Toil enqueue target; kept Greed/War/Envy unauthorized for `review` enqueues and Pandora/Toil/War/Envy unauthorized for `review` claims.
- pdx now treats claimable `design` and `review` work as Greed launches and passes the launch-selected Capability through to Spawner.
- Spawner now requires an authorized `selectedCapability` for multi-claim agents and renders the deterministic claim command for that Capability.
- `review` uses ordinary chain-policy dependency behavior; `escalate` remains the only source-link special case.

### Task 2 implementation — 2026-05-17

- Canonical prompts now document `review` as explicitly requested Greed-owned HITL assessment, not an automatic gate.
- Greed prompt has separate design/review modes, including review readiness escalation, review-report artifact, rejected-outcome handling, and no-substantial-implementation boundary.
- Pandora and Toil prompts can enqueue requested review tasks with narrowest-useful-scope guidance and global review payload requirements.
- `pandora-spawn preview` succeeded for Greed (`review` selected), Pandora, and Toil in an isolated PDX/Pithos data configuration.
- Validation: `pnpm verify` passed. A flaky live ID format assertion was broadened to allow hyphenated word-list entries such as `yo-yo`.

### Task 3 implementation — 2026-05-17

- Folded `review` into permanent terminology and base specs as Greed-claimed, explicitly requested, ordinary non-escalation work.
- Updated control-plane docs with Greed review launch/lifecycle and readiness escalation to Pandora.
- Removed the temporary scoped review change spec from the specs index and filesystem.
- Validation: `pnpm verify` passed.
