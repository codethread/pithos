# @pithos/spawner

Launcher-only library for built-in Pithos agents.

- renders prompt templates and harness argv/env
- launches AFK/HITL harness sessions for `pdx`
- parses Claude/Pi transcript files for operator-facing transcript output

## Public API

Exported from `@pithos/spawner`:

```ts
renderAgent(input): RenderedAgent
launchRenderedAgent(rendered): LaunchResult
launchAgent(input): LaunchResult
renderSessionTranscript(input): string
```

`launchAgent(input)` is a convenience wrapper for:

```ts
launchRenderedAgent(renderAgent(input));
```

This lets callers persist render metadata first, then launch the exact rendered plan.

### Input

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

`sessionId` is required to be a UUID.

### RenderedAgent

```ts
{
	agent: "pandora" | "toil" | "greed" | "war";
	mode: "afk" | "hitl";
	runId: string;
	sessionId: string;
	scopeId: string;
	cwd: string;
	logicalName: string;
	harness: {
		kind: "claude" | "pi";
		argv: readonly string[];
		env: Record<string, string>;
	};
	sessionLogPath: string;
	prompt: string;
}
```

### LaunchResult

```ts
{
	agent: "pandora" | "toil" | "greed" | "war";
	mode: "afk" | "hitl";
	runId: string;
	sessionId: string;
	scopeId: string;
	logicalName: string;
	harnessKind: "claude" | "pi";
	sessionLogPath: string;
	afk?: { pid: number; processStartTime: string };
	hitl?: { tmuxTarget: string; panePid: number | null };
}
```

`LaunchResult` intentionally reports runtime metadata only; rendered argv/env are not repeated.

### renderSessionTranscript input

```ts
{
	harnessKind: "claude" | "pi";
	sessionLogPath: string;
	limit?: number; // default: 20
}
```

Returns plain text transcript lines and fails loudly on unreadable/malformed logs.

## Services

Package exports service interfaces and the live implementation:

```ts
type RenderServices
type LaunchServices
LiveSpawnerServices
makeFakeSpawnerServices(input)
```

`LiveSpawnerServices` is for runtime use. `makeFakeSpawnerServices` is for deterministic tests and consumers that need to exercise the public Spawner API without filesystem/process access.

## Manifest model

`templates/agents.json` entries:

```json
{
	"agent": "war",
	"mode": "afk",
	"claims": ["execute"],
	"enqueues": ["escalate"],
	"harness": {
		"kind": "claude",
		"model": "sonnet",
		"system_prompt_mode": "replace",
		"tools": ["bash", "read", "edit", "write", "grep", "find", "ls"]
	},
	"includes": ["_common.md"],
	"template": "war.md.tmpl"
}
```

`harness.model` and `harness.system_prompt_mode` are required.

- `tools` is optional and must be non-empty when present.
- `includes` is optional and entries must be unique template basenames.
- Includes are inserted as raw template variables (for example `{{_common.md}}`), not recursively rendered.

Template context contains: `agent`, `run_id`, `session_id`, `scope_id`, `cwd`, `claim_command`, `command_cards`, `claims`, `enqueues`, `model`, `tools_csv`.

## Preview CLI

```sh
pandora-spawn preview \
  --agent war \
  --mode afk \
  --scope scope_repo \
  --run run_123 \
  --session-id 123e4567-e89b-12d3-a456-426614174000 \
  --cwd /repo
```

Output is `RenderedAgent` JSON.

Preview requires DB context:

- `PITHOS_DB` or
- `PDX_DATA_DIR` (from which `/pithos.sqlite` is derived)

`PITHOS_BIN` is optional and defaults to `pithos`.

`PDX_BIN` is optional and defaults to `pdx`; Pandora prompt rendering uses `PDX_BIN --help-json` for generated pdx inspection command cards.

## Notes

- AFK args include `--print "Claim and process one task, then exit."` for both Claude/Pi.
- HITL pi args include `begin` to enter interactive mode.
- Pi/Claude session paths are discovered as:
  - `~/.claude/projects/<cwd-project>/<session-id>.jsonl`
  - `~/.pi/agent/sessions/<cwd-prefix>--<session-id>.jsonl`
