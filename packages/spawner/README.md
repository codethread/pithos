# @pithos/spawner

Launcher-only library for built-in Pithos agents. Spawner renders prompts, builds harness argv/env, and launches AFK/HITL harness sessions for `pdx`.

## Library API

```ts
renderAgent(input): RenderedAgent
launchAgent(input): LaunchResult
```

Input:

```ts
{
	agent: "pandora" | "toil" | "greed" | "war";
	mode: "afk" | "hitl";
	runId: string;
	sessionId: string;
	scopeId: string;
	cwd: string;
}
```

`renderAgent` validates the manifest and template, checks manifest claims/enqueues against `@pithos/pithos` built-ins, validates mode, and returns rendered JSON. It does not touch Pithos state.

## Preview CLI

```sh
pandora-spawn preview \
  --agent war \
  --mode afk \
  --scope scope_repo \
  --run run_123 \
  --session-id session_123 \
  --cwd /repo
```

Output is `RenderedAgent` JSON with `agent`, `mode`, `runId`, `sessionId`, `scopeId`, `cwd`, `logicalName`, `harness.argv`, `harness.env`, and `prompt`.

`PITHOS_BIN` controls the rendered claim command; default is `pithos`.

## Templates

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

Spawnable agents: `pandora`, `toil`, `greed`, `war`.
