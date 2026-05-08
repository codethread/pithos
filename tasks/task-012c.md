# Slice 12c — Event payload schema coverage

## What to build

Add schema assertions for every durable Pithos event kind in the consolidated control-plane vocabulary.

Event kinds:

- `task.created`
- `task.claimed`
- `task.heartbeat`
- `run.heartbeat`
- `task.completed`
- `task.failed`
- `task.cancelled`
- `task.superseded`
- `task.reclaimed`
- `task.dead_lettered`
- `task.interrupted`
- `run.cleanup`
- `run.interrupted`
- `run.timed_out`

For each kind, assert:

- required key columns are populated (`task_id`, `run_id`, `actor_run_id`) according to spec
- payload decodes through a typed schema
- minimum required payload fields are present
- payload field types are stable

## Test focus

- At least one test path emits each event kind.
- Event writes happen in the same transaction as state mutation where applicable.
- Event payload assertions follow `specs/control-plane-supervision.md` §11.

## Acceptance criteria

- [ ] Every event kind has at least one full required-payload assertion
- [ ] Payload schemas live in test helpers or shared schema code, not ad hoc string assertions
- [ ] Missing or malformed payload fields fail loudly in tests
