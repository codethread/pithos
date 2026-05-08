# Slice 4 — Spawner in-place refactor: launcher-only library + preview CLI

## What to build

Refactor `packages/spawner/` in place to a launcher-only library per spec §9. No parallel package; the existing module is rewritten.

Drop entirely:

- `status`, `nudge`, `kill` CLI subcommands
- run upsert / registration helpers
- message-injection paths
- lifecycle cleanup / reclaim helpers

Library API (the only public surface aside from preview):

```ts
renderAgent(input): RenderedAgent   // pure: no DB, no process spawn
launchAgent(input): LaunchResult    // calls renderAgent then launches
```

Input shape:

```ts
{
  agent: AgentKind
  mode: "afk" | "hitl"
  runId: string
  sessionId: string
  scopeId: string
  cwd: string
}
```

`RenderedAgent` and `LaunchResult` shapes per spec §9. IDs are caller-supplied — spawner does not generate `runId`/`sessionId` and does not create run rows.

Manifest schema (per spec §9, locked):

```json
{
  "agent": "war",
  "mode": "afk",
  "claims": ["execute"],
  "enqueues": ["escalate"],
  "harness": { "kind": "claude" },
  "template": "war.md.tmpl"
}
```

Spawner validates manifest on load: `claims` and `enqueues` must equal the shared seeded built-in claim/enqueue contract exported by `@pithos/pithos` for that `agent`. Mismatch fails loud. MVP requires `claims.length === 1`. Spawner must not query the live Pithos DB during render/preview.

`claim_command` rendered into the prompt context:

```sh
<pithos-bin> task claim --run <run-id> --scope <scope-id> --capability <claims[0]>
```

Bin name resolved from a typed Spawner config seam whose live layer reads `PITHOS_BIN` and defaults to `"pithos"`. During the rewrite, pdx sets `PITHOS_BIN=pithos-next` in the spawner-launched harness env so renderings point at the in-progress bin. Cutover (slice 11) drops the env override; the default `"pithos"` takes over. No other place in the codebase should hard-code the bin name.

Templates rewritten:

- `war.md.tmpl` — replaces `envy.md.tmpl` (delete envy)
- `greed.md.tmpl` — new
- `pandora.md.tmpl` — updated for spec §10 role (wakeup recognition arrives in slice 9; do not pre-empt here)
- `toil.md.tmpl` — updated for spec §10 role

Mode validation: caller-supplied mode must equal manifest mode; mismatch fails loud.

Dev/internal CLI:

```text
pandora-spawn preview --agent <name> --mode <afk|hitl> --scope <scope-id> --run <run-id> --session-id <session-id> --cwd <path>
```

Outputs `RenderedAgent` JSON. Does not validate Pithos run/scope state; manifest/template validation only.

Spawner error codes: `VALIDATION_ERROR`, `TEMPLATE_ERROR`, `HARNESS_ERROR`, `LAUNCH_ERROR`.

## Test focus

- Manifest validation against the shared seeded Pithos built-in contract; `claims`/`enqueues` mismatch fails loud
- `claims.length === 1` enforced
- `claim_command` correctness for each spawnable agent kind
- Mode mismatch rejection
- `RenderedAgent` JSON shape: required keys present (`agent`, `mode`, `runId`, `sessionId`, `scopeId`, `cwd`, `logicalName`, `harness.argv`, `harness.env`, `prompt`)
- `renderAgent` is pure: callable without DB or filesystem side effects beyond template reads

Defer: full template-text golden snapshots (template wording is iterated through demos); harness invocation integration (covered by pdx slices 6+).

## Implementation primitives

- **`renderAgent` is pure:** read manifest + template via `FileSystem`, validate via `Schema.decodeUnknown(ManifestSchema)`, render. No DB, no `Command.start`, no Pithos calls. Tests run it without SQL DI.
- **`launchAgent` AFK path:** `Command.start(Command.make(harnessKind, ...args).pipe(Command.workingDirectory(cwd), Command.env(env)))` returns `Process { pid, exitCode: Effect, kill }`. Slice returns `{ pid, processStartTime }` immediately; pdx (slice 6) owns the death observer.
- **`launchAgent` HITL path:** delegates to the `Tmux` service from task-005a (`newSession({ target, command, cwd })`). Spawner does not touch `child_process` directly — project rule.
- **PITHOS_BIN seam:** live config layer reads `PITHOS_BIN`, parses it into typed Spawner config, and defaults to `"pithos"`. No domain code reads `process.env`; no string-concat throughout. Used only for `claim_command` rendering.
- **Manifest validation against seed data:** import the shared seeded built-in contract from `@pithos/pithos` and assert manifest claims/enqueues match. No live SQL/DB lookup in Spawner render paths. Mismatch → `VALIDATION_ERROR`.
- **Error codes:** `VALIDATION_ERROR | TEMPLATE_ERROR | HARNESS_ERROR | LAUNCH_ERROR` as a `Schema.Literal` union; tagged `PithosError`.

## Acceptance criteria

- [ ] Spawner CLI surface reduced to `preview` only
- [ ] Library exposes `renderAgent` and `launchAgent` with documented input/output shapes
- [ ] Manifest schema validated against shared seeded Pithos built-in contract on load; mismatch fails loud
- [ ] All four spawnable agent templates render valid prompts (`pandora`, `toil`, `greed`, `war`)
- [ ] `envy.md.tmpl` removed; no remaining references to envy/worker/implement/watch anywhere in `packages/spawner/` (templates and source)
- [ ] Mode mismatch rejection tested
- [ ] `pandora-spawn preview` outputs valid `RenderedAgent` JSON for each agent
