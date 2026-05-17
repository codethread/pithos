# Task 2: Teach agents review workflow

## Scope

Type: AFK

Update canonical templates and template docs so agents understand `review` as an explicitly requested Greed-owned HITL assessment step, while keeping the raw workflow agnostic and preserving `escalate` for immediate Pandora attention.

## Must implement exactly

- Update shared prompt rules so the known queue capabilities include `review` where appropriate.
- Add review scope-selection guidance to the relevant prompts: choose the narrowest useful Scope for review, preferring worktree > repo > global; use global only for cross-repo or multi-scope review, and require global review task bodies to name relevant scopes, repos, worktrees, task ids, and artifact ids.
- Update Greed so she has two clear modes:
  - `design`: existing design/signoff flow remains intact;
  - `review`: inspect task graph context and relevant local/global state, prepare a focused walkthrough, enqueue a global `escalate` readiness signal for Pandora, wait for HITL discussion and outcome, attach a `review-report` artifact, then complete the held review task.
- Update Greed boundaries so review mode may inspect diffs, artifacts, command output, and smoke-test evidence, but must not perform substantial implementation.
- Update Pandora so she may enqueue `review` only when explicitly requested by the user/task chain and can route review-readiness escalations to Greed’s live session.
- Update Pandora and Toil enqueue guidance so review task bodies name exact upstream task/artifact ids, desired scope, and desired focus.
- Update Toil so it may enqueue `review` only when triage instructions or the user request a HITL review/acceptance/walkthrough step.
- Make rejected-review behavior explicit: if the user rejects the work or asks for changes, Greed records the rejected outcome and follow-up routing in `review-report`, then completes the review task unless the review session itself failed.
- Update template documentation’s built-in claim/enqueue table to include the `review` contract.
- Preserve the raw template stance that review gates are not automatic after every design or execution task.

## Done when

- Greed’s rendered prompt clearly distinguishes design mode from review mode.
- Pandora’s rendered prompt clearly distinguishes immediate escalation handling from requested review enqueue/routing.
- Toil’s rendered prompt can route requested review work without implying automatic review gates.
- Prompts include narrowest-useful-scope guidance and global review payload requirements.
- Greed’s review prompt states the rejected-outcome path and when to complete versus fail the review task.
- Template docs list Greed as claiming `design`, `review`; Pandora and Toil as enqueueing `review`; Greed/War/Envy as not enqueueing `review`.
- `pandora-spawn preview` succeeds for at least Greed, Pandora, and Toil in an isolated smoke configuration.
- Relevant template/spawner tests or previews are updated if they assert generated command cards, claim lists, or prompt text.

## Out of scope

- Pithos built-in authorization changes beyond what Task 1 already owns.
- Folding the temporary change spec into permanent specs.
- Adding user-specific workflow recipes or automatic review gate policies.
- Adding `verify` or QA behavior.

## References

- `specs/scoped-review-capability.md`
- `templates/_common.md`
- `templates/greed.md`
- `templates/pandora.md`
- `templates/toil.md`
- `templates/README.md`
- `packages/spawner/src/`
- `packages/spawner/src/spawner.test.ts`
