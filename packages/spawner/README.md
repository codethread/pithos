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

AFK Pi and Claude agents render with `--print "Claim and process one task, then exit."` so detached launches do real non-interactive work. HITL agents omit `--print` and run interactively. Claude session IDs must be valid UUIDs.

Session logs use harness-native locations so prior Pandora-style status tooling can find them by session id: Claude under `~/.claude/projects/**/<uuid>.jsonl`, Pi under `~/.pi/agent/sessions/**/<uuid>.jsonl`.

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
