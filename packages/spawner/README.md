# @pithos/spawner

Developer map for the Spawner package: the Harness launcher for built-in Agent runs.

## Package role

`@pithos/spawner` is a library used by `pdx`. It also exposes one preview binary:

```sh
pandora-spawn --help
pandora-spawn preview --help
```

Preview renders the Agent run plan as JSON. It does not mutate Pithos, create a Run, touch tmux, or launch a Harness session.

## Boundaries

Spawner owns:

- Agent manifest/template loading
- prompt rendering
- Harness argv/env construction
- expected Harness session log paths
- AFK mode process launch mechanics
- HITL mode tmux launch mechanics
- Claude/Pi transcript parsing for `pdx run transcript`

Spawner does not own:

- durable Tasks, Runs, Claims, Fencing tokens, Artifacts, Events, or Task graph invariants — Pithos owns those
- Registry state, Kill, Cleanup, Interrupt, Wakeups, or live Run finalization — `pdx` owns those
- claim/enqueue authorization truth — Pithos built-ins own that; Spawner validates its manifest against them
- task body routing — Agent runs claim Claimable tasks themselves via the rendered claim command

## Cross-package flow

```text
pdx reconcile
  -> Spawner.renderAgent(input)
  -> pdx stores rendered harness kind/session log path on a Pithos Run
  -> Spawner.launchRenderedAgent(rendered)
  -> pdx owns returned pid/tmux target in its Registry

pdx run transcript
  -> Pithos run inspect gives harness_kind + session_log_path
  -> Spawner.renderSessionTranscript(...) parses the Harness session log
```

Specs describe the full control plane: [`../../specs/control-plane-supervision.md`](../../specs/control-plane-supervision.md). Terms: [`../../UBIQUITOUS_LANGUAGE.md`](../../UBIQUITOUS_LANGUAGE.md).

## File map

| Path                    | Why read it                                                              |
| ----------------------- | ------------------------------------------------------------------------ |
| `src/index.ts`          | package-root exports; keep consumers on this boundary                    |
| `src/main.ts`           | `pandora-spawn preview` CLI boundary and tagged CLI errors               |
| `src/spawner.ts`        | manifest contract, render pipeline, launch mechanics, transcript parsers |
| `src/services.ts`       | Render/Launch service interfaces, live Node IO, fake services            |
| `src/paths.ts`          | template asset discovery for source and built layouts                    |
| `src/errors.ts`         | `SpawnerError` codes and CLI exit mapping                                |
| `templates/agents.json` | Agent manifest contract instance                                         |
| `templates/*.md.tmpl`   | Agent kind prompts                                                       |
| `templates/_common.md`  | shared prompt include                                                    |
| `src/spawner.test.ts`   | behavior examples for render, launch, transcript, and manifest failures  |

## Public library surface

Exported from `@pithos/spawner`:

- `renderAgent(input)` — pure render/validation. No launch.
- `launchRenderedAgent(rendered)` — launch an already-rendered plan.
- `launchAgent(input)` — convenience render-then-launch wrapper. `pdx` should prefer the two-step flow.
- `renderSessionTranscript(input)` — parse a stored Claude/Pi Harness session log.
- `LiveSpawnerServices` — live filesystem/process/env implementation.
- `makeFakeSpawnerServices(input)` — deterministic service implementation for tests.

`RenderedAgent` is the important API object: it contains `logicalName`, `harness.kind`, `harness.argv`, `harness.env`, `sessionLogPath`, and `prompt`. `LaunchResult` intentionally contains runtime metadata only: pid for AFK mode or tmux target/pane pid for HITL mode.

## `templates/agents.json` contract

`agents.json` is Spawner's Agent manifest. It is render configuration, not durable authorization truth. Pithos seeds and enforces authorization; Spawner validates this file matches Pithos built-ins.

Top-level shape:

```json
{
	"agents": [
		{
			"agent": "war",
			"mode": "afk",
			"claims": ["execute"],
			"enqueues": ["escalate"],
			"harness": {
				"kind": "pi",
				"model": "openai-codex/gpt-5.4",
				"system_prompt_mode": "append",
				"tools": ["bash", "read"]
			},
			"includes": ["_common.md"],
			"template": "war.md.tmpl"
		}
	]
}
```

Field contract:

| Field                        | Required | Contract                                                                          |
| ---------------------------- | -------- | --------------------------------------------------------------------------------- |
| `agents`                     | yes      | array of manifest entries                                                         |
| `agent`                      | yes      | one of spawnable Agent kinds: `pandora`, `toil`, `greed`, `war`                   |
| `mode`                       | yes      | `afk` or `hitl`; must match the mode `pdx` requests                               |
| `claims`                     | yes      | non-empty array; MVP requires exactly one item and it must match Pithos built-ins |
| `enqueues`                   | yes      | array of Capabilities; must match Pithos built-ins exactly                        |
| `harness.kind`               | yes      | `claude` or `pi`                                                                  |
| `harness.model`              | yes      | non-empty model string passed to the Harness CLI                                  |
| `harness.system_prompt_mode` | yes      | `replace` -> `--system-prompt`; `append` -> `--append-system-prompt`              |
| `harness.tools`              | optional | non-empty array when present; rendered as comma-separated `--tools` value         |
| `includes`                   | optional | unique template basenames only; no paths, no recursive rendering                  |
| `template`                   | yes      | template basename under `templates/`                                              |

Current built-in claim/enqueue contract:

| Agent kind | Mode today | Claims     | Enqueues                                  |
| ---------- | ---------- | ---------- | ----------------------------------------- |
| `pandora`  | `hitl`     | `escalate` | `triage`, `design`, `escalate`            |
| `toil`     | `afk`      | `triage`   | `triage`, `design`, `execute`, `escalate` |
| `greed`    | `hitl`     | `design`   | `triage`, `design`, `escalate`            |
| `war`      | `afk`      | `execute`  | `escalate`                                |

If you change Agent kinds, Capabilities, claims, or enqueues, update Pithos built-ins and this manifest together. If they disagree, rendering fails loudly.

## Template contract

Templates are simple `{{variable}}` substitutions. Unknown variables fail loudly. Includes are inserted as raw text and are not recursively rendered.

Available template variables:

- `agent`
- `run_id`
- `session_id`
- `scope_id`
- `cwd`
- `claim_command`
- `command_cards`
- `claims`
- `enqueues`
- `model`
- `tools_csv`
- one variable per include filename, for example `_common.md`

Templates receive launch/self-claim context only. They do not receive task bodies.

## Environment contract

Render/preview needs DB context:

- `PITHOS_DB`, or
- `PDX_DATA_DIR` from which Spawner derives `$PDX_DATA_DIR/pithos.sqlite`

Optional command overrides:

- `PITHOS_BIN` defaults to `pithos`
- `PDX_BIN` defaults to `pdx`

Rendered Harness env includes:

- `PITHOS_DB`
- `PITHOS_RUN_ID`
- `PITHOS_SESSION_ID`
- `PITHOS_SCOPE_ID`
- `PITHOS_BIN`
- `PDX_BIN`
- `PDX_DATA_DIR` when provided

## Harness notes

Read `src/spawner.ts` for exact argv construction. Stable behavior worth knowing before editing:

- AFK mode uses Harness print mode with the message `Claim and process one task, then exit.`
- HITL mode launches under tmux.
- Pi HITL prompt delivery uses a temp-file shell wrapper to avoid prompt quoting/argv issues.
- Session log paths are computed before launch and stored by `pdx` on the Pithos Run.

## Development

```sh
pnpm --filter @pithos/spawner typecheck
pnpm --filter @pithos/spawner test
pnpm --filter @pithos/spawner start -- --help
pnpm --filter @pithos/spawner start -- preview --help
```

Preview with an isolated DB context:

```sh
export PDX_DATA_DIR="$(mktemp -d)/pdx"
export PITHOS_DB="$PDX_DATA_DIR/pithos.sqlite"
mkdir -p "$PDX_DATA_DIR"
pnpm --filter @pithos/pithos start -- init --fresh
pnpm --filter @pithos/spawner start -- preview \
  --agent war \
  --mode afk \
  --scope scope_repo \
  --run run_demo \
  --session-id 123e4567-e89b-12d3-a456-426614174000 \
  --cwd "$PWD" | jq .
```

Use fake services for deterministic render/launch tests. Do not require live model credentials for package tests.
