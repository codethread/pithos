# Task 6: Expose typed edge enqueue surface

## Scope

Type: AFK

Expose the typed-edge model at the Pithos enqueue boundary for non-gate edges, and remove the old source-policy surface that no longer has a clear typed-edge meaning.

## Must implement exactly

- Add public enqueue flags for typed non-gate edges:
  - `--after <task-id>` creates repeatable `after` edges.
  - `--about <task-id>` creates a singular branch-attention `about` edge.
  - `--repair <task-id>` creates a singular branch-attention `repair` edge for Repair Alert/system use only.
- Remove or reject the old public `--depends-on` flag in favor of `--after`, because this is a breaking pre-v1 graph change.
- Remove or reject `--chain source`; valid chain policies after this slice are `auto`, `none`, and `held`.
- Enforce that `about` and `repair` are mutually exclusive and singular per task.
- Restrict `--repair` to the `pdx` system actor / Repair Alert engine paths; ordinary Agent runs attempting to enqueue with `--repair` must fail loudly so Repair Alerts remain system-authored.
- Update chain policy so current automatic behavior produces typed edges:
  - ordinary held-task continuation creates `after`;
  - held normal task to escalation creates `about`;
  - held `about` escalation to normal continuation creates `after` to the held escalation;
  - held `repair` escalation cannot ordinary-auto-continue and fails loudly with guidance to supersede, replan, or cancel.
- Keep authorization, scope validation, duplicate detection, and superseded-target validation fail-loud at enqueue time.
- Enforce and test branch-membership acyclicity for the graph formed by `after`, `about`, and `repair` edges, including cycles that involve `about` or `repair`.
- Update CLI help JSON and tests that assert command surfaces or enqueue payloads.

## Done when

- CLI tests prove `--after` and `--about` create the expected edge kinds, and system-authored Repair Alert paths create `repair` edges.
- CLI tests prove ordinary Agent enqueue attempts with `--repair` fail loudly.
- CLI tests prove `--depends-on` and `--chain source` are no longer accepted.
- Chain-policy tests prove ordinary continuation, escalation context, and repair-alert continuation behavior match the typed-edge diff spec.
- Tests prove `after`/`about`/`repair` membership cycles fail loudly and roll back.
- Help JSON exposes the new flags and no longer documents removed flags.
- Relevant Pithos tests pass.

## Out of scope

- `--gate-on` and dynamic gate behavior.
- Late-growth enforcement.
- Agent template wording beyond generated command-card changes.
- Canonical spec fold-in.

## References

- `specs/task-graph-typed-edges-diff.md`
- `packages/pithos/src/cli.ts`
- `packages/pithos/src/chain-policy.ts`
- `packages/pithos/src/engine.ts`
- `packages/pithos/test/cli.test.ts`
- `packages/pithos/test/chain-policy.test.ts`
- `packages/pithos/test/task-lifecycle.test.ts`
