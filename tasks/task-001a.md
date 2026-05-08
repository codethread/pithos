# Slice 1a — Pithos core architecture, config, schema, seeds

## What to build

Reshape `packages/pithos/` into the foundation that later `pdx` code can import directly.

- Keep the package private and expose a temporary dev bin `pithos-next`.
- Preserve old `packages/cli/` and the production `pithos` bin untouched.
- Define a core library surface for Pithos operations. The CLI must call this surface; later `pdx` must not shell out for core state transitions when an imported function is appropriate.
- Establish Effect services/layers for:
  - typed config/env (`PITHOS_DB`, `PITHOS_RUN_ID`)
  - DB access/transactions
  - filesystem reads used by command bodies/results
  - ID generation
  - clock/time
  - output rendering at the CLI boundary only
- Replace direct domain-level Node IO with services. Raw Node modules may stay only in live service implementations and build scripts.
- Implement fresh DB migration and seed data:
  - `scopes`
  - `runs` with `mode TEXT NOT NULL CHECK (mode IN ('afk','hitl'))` and terminal status `timed_out`
  - `tasks` without leases
  - `task_dependencies`, `task_supersessions`
  - `agent_kinds`, `capabilities`, `agent_claims`, `agent_enqueues`
  - `events`, `artifacts`
  - partial unique index on `runs(task_id) WHERE task_id IS NOT NULL`
- Seed built-ins exactly per supervision spec §5:
  - agent kinds: `pdx`, `pandora`, `toil`, `greed`, `war`
  - capabilities: `triage`, `design`, `execute`, `escalate`
  - claim/enqueue rules; `pdx` has no claims and may enqueue only `escalate`
- Export a typed shared built-in contract from `@pithos/pithos` so Spawner can validate manifests without querying the live Pithos DB.

## Test focus

- `init --fresh` creates the schema from scratch and reseeds.
- non-fresh init is idempotent.
- seeded claim/enqueue matrices match spec.
- exported built-in contract matches seeded DB rows.
- partial unique index exists.
- row decoders reject malformed DB rows at the IO boundary.
- config decoding rejects invalid/missing required config loudly.

## Defer

- Full nested command tree beyond `init`.
- Task lifecycle mutations.
- Graph rendering/briefing.
- Run cleanup/interrupt/timeout; those remain task 2.

## Slice notes

- Review flagged existing task-claim and token-mutation race/ownership hardening. Those paths are outside this slice's foundation/schema/seed scope and should be handled with the task lifecycle/fencing slice rather than expanded here.

## Acceptance criteria

- [ ] `packages/pithos/` builds and typechecks as a package.
- [ ] Core library functions are importable from `@pithos/pithos`.
- [ ] Live services isolate Node/process/fs/DB IO from domain logic.
- [ ] Fresh schema and seed data match the control-plane spec.
- [ ] Shared built-in contract is exported and tested against seed data.
- [ ] Tests cover init/idempotence/seeds/schema constraints.
