# @pithos/spawner

Launcher-only agent spawner for Pandora's Box.

`pandora-spawn` owns agent manifests, prompt rendering, harness argv/env construction, and launch mechanics. It does **not** register runs, mutate Pithos state, inspect status, send follow-up messages, or make lifecycle decisions.

## Surface

Library API:

- `renderAgent(input)` — pure render; loads manifest + template, validates them, and returns `RenderedAgent`
- `launchAgent(input)` — calls `renderAgent`, then launches the harness and returns `LaunchResult`

CLI:

```sh
pithos-next init --fresh
PITHOS_BIN=pithos-next pandora-spawn preview --agent pandora --mode hitl --scope global --run run_PREVIEW --session-id session_PREVIEW --cwd ~/.pandora
```

`preview` prints `RenderedAgent` JSON only. It does not validate Pithos run/scope state.

## Input

```ts
{
  agent: "pandora" | "toil" | "greed" | "war"
  mode: "afk" | "hitl"
  runId: string
  sessionId: string
  scopeId: string
  cwd: string
}
```

## `RenderedAgent`

```ts
{
  agent: "pandora" | "toil" | "greed" | "war"
  mode: "afk" | "hitl"
  runId: string
  sessionId: string
  scopeId: string
  cwd: string
  logicalName: string
  harness: {
    kind: "claude" | "pi"
    argv: readonly string[]
    env: Record<string, string>
  }
  prompt: string
}
```

## `LaunchResult`

```ts
{
  agent: "pandora" | "toil" | "greed" | "war"
  mode: "afk" | "hitl"
  runId: string
  sessionId: string
  scopeId: string
  logicalName: string
  harnessKind: "claude" | "pi"
  sessionLogPath: string
  afk?: { pid: number; processStartTime: string }
  hitl?: { tmuxTarget: string; panePid: number | null }
}
```

## Manifest schema

`templates/agents.json` is locked to:

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

Validation rules:

- `claims.length === 1`
- `claims` must match the seeded Pithos `agent_claims` rows for that agent
- `enqueues` must match the seeded Pithos `agent_enqueues` rows for that agent
- caller-supplied `mode` must equal the manifest mode
- template name must match `<agent>.md.tmpl`

## Harness hooks

Real launched sessions still rely on the shared hook dispatcher in `hooks/dispatch.sh`.

- Claude Code plugin: `packages/spawner/claude-plugin/`
- Pi extension: `packages/spawner/pi-extension/`

The hooks translate harness-native lifecycle signals into `pithos task heartbeat --run ...` calls. The spawner itself remains launcher-only; it just injects the environment those adapters expect. Run finalization stays with `pdx`.

## PITHOS bin seam

Prompt recipes use a single seam:

```ts
process.env.PITHOS_BIN ?? "pithos"
```

The rendered harness env also includes `PITHOS_BIN` so launched agents see the same bin name the preview used.

## Build

```sh
pnpm --filter @pithos/spawner build
pnpm --filter @pithos/pithos build
packages/pithos/bin/pithos-next init --fresh
PITHOS_BIN=pithos-next pnpm --filter @pithos/spawner start -- preview --agent war --mode afk --scope repo:work/example --run run_PREVIEW --session-id session_PREVIEW --cwd ~/work/example
```

## Tests

```sh
pnpm --filter @pithos/spawner test
pnpm --filter @pithos/spawner exec vitest run --update
```
