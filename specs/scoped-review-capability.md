# Scoped Review Capability Change

**Status:** Planned
**Last Updated:** 2026-05-17

## 1. Overview

### Purpose

Add `review` as a first-class Pithos Capability for planned HITL assessment of scoped work. `review` is claimed by Greed, may be queued in global, repo, or worktree Scope, and is used when the user or task instructions explicitly ask for a focused human-guided review after prerequisite work. This change keeps `escalate` focused on immediate Pandora attention, repair, and routing while giving review work its own queue placement and agent lifecycle.

This is a temporary change spec. After implementation, fold the settled behavior into the base specs (`task-graph`, `control-plane-supervision`, `agent-configuration`, templates docs, and ubiquitous language), then delete this change spec.

### Goals

- Add built-in Capability `review`.
- Let Greed claim `review` tasks in addition to `design` tasks.
- Let Pandora and Toil enqueue `review` tasks when explicitly requested by the user/task chain.
- Keep War focused on action and Envy out of this surface for now; neither enqueues `review`.
- Allow `review` tasks in global, repo, and worktree scopes, with prompt guidance preferring the most specific useful scope: worktree > repo > global.
- Treat `review` as ordinary dependency-chain work, not escalation-like source-link work.
- Update pdx/Spawner launch and prompt-rendering contracts so Greed can be spawned for, and claim, either `design` or `review` work.
- Teach Greed a review mode: inspect local/task state first, then alert Pandora that the review session is ready, guide the user, attach a `review-report` artifact, and complete the task.
- Keep raw templates workflow-agnostic: they should describe how to perform a requested review, not automatically add review gates to every design or execution flow.

### Non-Goals

- No `verify`, QA, or automated validation Capability in this change.
- No new Agent kind for review.
- No engine-enforced Scope restriction for `review`; prompts guide scope choice.
- No automatic insertion of `review` after `design` or `execute` tasks.
- No change to Repair Alerts; they remain global `escalate` tasks with `repair_source` provenance.
- No removal of dependency-gated `escalate` as a possible global checkpoint pattern, but templates should prefer `review` when the desired work is Greed-led HITL assessment.

## 2. Design Decisions

- **Decision:** Add a new Capability named `review`.
  - **Rationale:** The desired work is not just “Pandora decide after X.” It is planned HITL assessment where an agent can inspect artifacts, diffs, test/smoke evidence, and surrounding context before bringing the user into a focused walkthrough. Naming this explicitly is easier for users and agents than saying “checkpoint escalation.”

- **Decision:** Greed claims `review`.
  - **Rationale:** Greed is already HITL and already follows a claim → investigate → ask for signoff → attach artifact → complete lifecycle for `design`. Review has the same lifecycle shape, while Pandora should remain the global coordinator for escalations and repair routing.

- **Decision:** Pandora and Toil may enqueue `review`; Greed, War, and Envy do not.
  - **Rationale:** Pandora and Toil are the routing/decomposition roles that can schedule review when the user or task requests it. War should stay focused on action and evidence, Greed is already the reviewer once claimed, and Envy’s routing role is intentionally left narrow until its behavior is better understood.

- **Decision:** Allow `review` in global, repo, and worktree scopes without engine enforcement.
  - **Rationale:** Most reviews should happen in the narrowest useful scope, usually worktree before merge, then repo, then global. Global review still makes sense for cross-repo or BE/FE workflows that must be smoked together. Engine enforcement would prematurely encode policy that belongs in user workflows and templates.

- **Decision:** `review` uses normal chain semantics.
  - **Rationale:** Unlike `escalate`, review is not an immediate attention signal. `--chain auto` should treat `review` like `triage`, `design`, and `execute`: ordinary follow-up depends on the held task/source. Explicit fan-in review should use `--chain none --depends-on ...` for each prerequisite.

- **Decision:** Greed signals readiness with a global `escalate` task after pre-review prep.
  - **Rationale:** The user still talks through Pandora as the long-lived coordination point. The readiness escalation is a routing signal to move the user to Greed’s live review session, while the review task itself remains the durable scoped work item Greed completes.

- **Decision:** Completed reviews attach a `review-report` artifact.
  - **Rationale:** Downstream agents need durable review outcome/context without scraping the HITL transcript. A standard artifact kind gives Toil/Pandora a stable handoff target.

- **Decision:** Raw templates document review only as an explicitly requested step.
  - **Rationale:** Pandora’s Box should not impose a universal workflow. Users can define automatic review gates through extensions/templates if desired; canonical prompts should stay agnostic and route review only when asked.

## 3. Planned Behavior

### Capability contract

| Agent kind | Claim changes                   | Enqueue changes        |
| ---------- | ------------------------------- | ---------------------- |
| `pandora`  | unchanged: `escalate`           | add `review`           |
| `toil`     | unchanged: `triage`             | add `review`           |
| `greed`    | add `review` alongside `design` | unchanged              |
| `war`      | unchanged                       | unchanged; no `review` |
| `envy`     | unchanged                       | unchanged; no `review` |

### Launch and claim rendering

pdx must treat Greed as the HITL claimant for both `design` and `review` tasks. A claimable `review` task should launch Greed the same way a claimable `design` task does today, using the task's Scope to select cwd. When pdx selects a ready task for launch, it should pass that selected task Capability through the launch/render boundary.

Spawner must stop assuming each Agent kind has exactly one claim capability. Rendered prompts must still provide one deterministic `claim_command`: for single-claim agents, use their only claim Capability; for multi-claim agents, use the launch-selected Capability supplied by pdx or preview input. Spawner must validate that the selected Capability is authorized for the Agent kind and fail loudly otherwise.

### Scope guidance

Agents should choose the narrowest useful Scope for review:

1. **Worktree** — preferred for review before merge, local implementation walkthroughs, and smoke checks tied to an isolated checkout.
2. **Repo** — useful when the work is repo-local but not tied to one worktree.
3. **Global** — reserved for cross-repo reviews or workflows where multiple repo/worktree changes must be discussed or smoked together.

Pithos should not reject global `review` tasks. A global review task body must name the relevant scopes, repos, worktrees, task ids, and artifact ids Greed should inspect.

### Enqueue patterns

A simple requested review after the currently held task can rely on default auto chaining:

```sh
pithos task enqueue \
  --run $PITHOS_RUN_ID \
  --scope <review-scope-id> \
  --capability review \
  --title 'Review <thing>' \
  --stdin <<'EOF'
<review instructions, source task ids, artifact ids, and desired focus>
EOF
```

A fan-in review after multiple tasks should opt out of implicit chaining and name all prerequisites:

```sh
pithos task enqueue \
  --run $PITHOS_RUN_ID \
  --scope <review-scope-id> \
  --capability review \
  --title 'Review completed options' \
  --chain none \
  --depends-on task_design_a \
  --depends-on task_design_b \
  --stdin <<'EOF'
Compare both completed options, inspect their artifacts, and prepare a focused user review.
EOF
```

### Greed review mode

When Greed claims a `review` task, she should:

1. Inspect the held task and graph context.
2. Inspect named upstream tasks/artifacts and relevant repo/worktree/global context.
3. Run only review-appropriate read/check commands needed to understand state. Review mode may inspect diffs, command output, and smoke-test evidence, but should not perform substantial implementation.
4. Prepare a concise walkthrough: what changed or was decided, evidence, risks, unresolved questions, and what the user must accept/reject/choose.
5. Enqueue a global `escalate` task for Pandora saying the review session is ready. Include Greed’s `session_id`, `run_id`, `scope_id`, held review task id, and concise topic.
6. Stay alive for the HITL review conversation.
7. After the user reaches a review outcome, or Pandora relays an explicit outcome, attach a `review-report` artifact to the review task.
8. Complete the review task.

If the user rejects the work or asks for changes, Greed should capture the rejected outcome in the `review-report` and route follow-up through Pandora/Toil according to the task instructions. Greed should not silently rewrite the chain.

### Pandora behavior

Pandora remains the owner of global escalation. When she claims a review-readiness escalation from Greed, she should direct the user to Greed’s live session using the run/task navigation commands, then complete the routing escalation when the handoff is done or when the review has already produced its `review-report`.

Pandora may enqueue `review` tasks when the user explicitly asks for a review, acceptance pass, walkthrough, or signoff step. She should not add review gates by default.

### Toil behavior

Toil may enqueue `review` tasks when triage instructions or the user request include a HITL review/acceptance/walkthrough step. Toil should not automatically add review after every execute/design task. When it does enqueue review, the task body should name the exact upstream task/artifact ids and desired scope.

## 4. Implementation Phases

### Phase 1: Durable capability and authorization

- [ ] Add `review` to Pithos built-in capabilities.
- [ ] Add `review` to Greed claim authorization.
- [ ] Add `review` to Pandora and Toil enqueue authorization.
- [ ] Add `review` to row parsing and chain-policy capability typing as an ordinary non-escalation capability.
- [ ] Update pdx supervision so claimable `review` tasks launch Greed and pass the selected task Capability through the render boundary.
- [ ] Update Spawner prompt rendering so Greed's multiple claim capabilities render one deterministic claim command for the launch-selected Capability.
- [ ] Update role-filtered command rendering expectations if tests assert capability lists.

### Phase 2: Agent templates and docs

- [ ] Update shared template capability lists and examples.
- [ ] Add Greed review mode while preserving design mode.
- [ ] Update Pandora guidance for enqueuing requested reviews and handling Greed review-readiness escalations.
- [ ] Update Toil guidance for requested review routing.
- [ ] Update template docs to show the new claim/enqueue contract.

### Phase 3: Specs, ubiquitous language, and tests

- [ ] Update `UBIQUITOUS_LANGUAGE.md` with Review task terminology.
- [ ] Update base specs to include implemented review behavior.
- [ ] Add/update tests for built-in seed invariants, authorization, CLI help/command-card capability surfacing, and chain policy treating `review` as non-escalation work.
- [ ] Delete this change spec after the base specs reflect the implemented design.

## 5. Code Locations

| File                                          | Planned change                                                                    |
| --------------------------------------------- | --------------------------------------------------------------------------------- |
| `packages/pithos/src/builtins.ts`             | Add `review` capability, Greed claim, Pandora/Toil enqueue rules.                 |
| `packages/pithos/src/chain-policy.ts`         | Add `review` to chain capability type; preserve ordinary non-escalation behavior. |
| `packages/pithos/src/rows.ts`                 | Add `review` to task row capability decoding.                                     |
| `packages/pdx/src/controller.ts`              | Launch Greed for claimable `review` tasks and pass selected Capability to render. |
| `packages/pdx/src/services.ts`                | Update capability unions and launch/render input used at the pdx boundary.        |
| `packages/pdx/test/`                          | Cover or update supervision expectations for Greed review launch policy.          |
| `packages/spawner/src/spawner.ts`             | Render claim command from single claim or launch-selected multi-claim Capability. |
| `packages/spawner/src/main.ts`                | Expose preview input for multi-claim selected Capability if needed.               |
| `packages/spawner/src/spawner.test.ts`        | Cover Greed multi-claim rendering and command cards.                              |
| `packages/pithos/test/foundation.test.ts`     | Update seed/built-in invariants.                                                  |
| `packages/pithos/test/task-lifecycle.test.ts` | Cover authorization and representative review chaining.                           |
| `packages/pithos/test/cli.test.ts`            | Update help/CLI expectations that enumerate capabilities.                         |
| `templates/_common.md`                        | Add review to shared rules/recipes without making it automatic.                   |
| `templates/greed.md`                          | Add design-vs-review mode guidance and `review-report` artifact contract.         |
| `templates/pandora.md`                        | Add requested-review enqueue and review-readiness escalation handling.            |
| `templates/toil.md`                           | Add requested-review routing guidance.                                            |
| `templates/README.md`                         | Update built-in claim/enqueue table.                                              |
| `README.md`                                   | Update user-facing Evil/capability tables.                                        |
| `UBIQUITOUS_LANGUAGE.md`                      | Add Review task term and clarify relation to Escalation task.                     |
| `specs/task-graph.md`                         | Fold in implemented review semantics after code lands.                            |
| `specs/control-plane-supervision.md`          | Fold in Greed review lifecycle/readiness escalation if needed.                    |
| `specs/agent-configuration.md`                | Update capability/role examples if present.                                       |

## 6. Deferred Considerations

These are not open MVP decisions and should not block AFK implementation.

- Dedicated global review recipes for cross-repo smoke/release flows are deferred. The MVP only provides narrowest-useful-scope guidance and requires global review bodies to name relevant scopes, repos, worktrees, task ids, and artifact ids.
- Preliminary review-prep artifacts are deferred. The MVP requires the final `review-report` artifact after user signoff or relayed signoff.
- If review finds defects or the user rejects the work, the review task should still complete with a `review-report` recording the rejected outcome and any follow-up routing, unless the review session itself failed.
