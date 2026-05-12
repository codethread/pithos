# Slice 3 — Pithos backbone DEMO GATE 1

## What to build

This slice is a demo/conformance gate over completed Pithos foundation work from tasks 001a-001e and run lifecycle work from task 002. It should not introduce new graph or authorization behavior unless the demo exposes a small spec-conformance gap.

Commit a replayable demo script, for example:

```text
docs/demos/pithos-backbone.md
```

The demo must use only the public `pithos`/`pithos-next` CLI surface and must not use raw SQL, test fixtures, or direct DB mutation.

The walkthrough must exercise:

- `pithos init --fresh`
- scope upserts for global + repo/worktree scope
- run upserts simulating `pdx`, `pandora`, `toil`, `greed`, and `war`
- authorized `task enqueue` for `triage`, `design`, `execute`, and `escalate`
- authorization rejection examples for disallowed claim/enqueue pairs
- capability-scope rejection examples:
  - `escalate` outside global scope
  - `execute` in global scope
- claim → heartbeat → complete happy path
- claim → fail unhappy path
- `run cleanup`, `run interrupt`, and `run timeout` simulation from task 002
- dependency-blocked work becoming claimable only after upstream task is `done`
- `task supersede` of a failed task, including queued direct dependent retargeting
- cross-scope supersede rejection when queued direct dependents would be retargeted
- `task cancel` of a queued task
- `events tail`, `graph inspect`, `task inspect`, and `briefing` reflecting state at each step

## Test focus

- The demo script runs end-to-end from a fresh DB.
- The demo proves the spec-level contracts already implemented by tasks 001a-001e and 002:
  - authorization
  - capability scope rules
  - task claimability through dependencies
  - supersession repair
  - run cleanup/interrupt/timeout transitions
  - event/read surfaces

If the demo uncovers missing behavior from tasks 001a-001e or 002, make the smallest conformance fix and test it in the owning area. Do not expand this slice into new feature work.

## Defer

- Full end-to-end `pdx` supervision; this is Pithos-only.
- Template/harness validation.
- Snapshot coverage beyond what is needed to keep the demo replayable.

## Acceptance criteria

- [ ] Replayable Pithos backbone demo committed
- [ ] Demo uses only public CLI commands; no raw SQL or DB fixture mutation
- [ ] Demo covers happy path, failure path, graph repair, lifecycle transitions, and read surfaces
- [ ] Any discovered spec-conformance fixes are small, tested, and attributed to the owning Pithos area
- [ ] the user + agent walk through demo and confirm Pithos backbone behaves as specced; record confirmation as a task comment or in the demo doc
