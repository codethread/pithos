# Template config agent guide

This directory is user-owned Pandora's Box configuration after `pdx init` copies
it into `<data-dir>/templates/`. These files configure how Pandora's Box renders
agent harness prompts and argv. They are not Pithos runtime state.

Edit this directory directly when changing agent harnesses, models, tools, or
prompt wording.

## Files

- `agents.json` — render manifest for each agent kind.
- `*.md.tmpl` — prompt template for an agent kind.
- `_common.md` — shared include text used by templates.
- `README.md` — operator-facing contract reference.
- `AGENTS.md` / `CLAUDE.md` — this guide for direct config-editing agents.

## Manifest shape

Each `agents.json` entry has this shape:

```json
{
	"agent": "war",
	"mode": "afk",
	"harness": {
		"kind": "pi",
		"model": "openai-codex/gpt-5.4",
		"system_prompt_mode": "append",
		"tools": ["bash", "read"]
	},
	"includes": ["_common.md"],
	"template": "war.md.tmpl"
}
```

Fields:

- `agent`: one of `pandora`, `toil`, `greed`, `war`.
- `mode`: `afk` or `hitl`; must match the mode Pandora's Box launches.
- `harness.kind`: `claude` or `pi`.
- `harness.model`: non-empty model string passed to the selected harness CLI.
- `harness.system_prompt_mode`:
  - `replace` renders as the harness `--system-prompt` style flag.
  - `append` renders as the harness `--append-system-prompt` style flag.
- `harness.tools`: optional non-empty array; rendered into the harness `--tools`
  argv value as a comma-separated list.
- `includes`: optional list of template basenames. No paths. No recursive
  include rendering.
- `template`: template basename in this directory.

The manifest controls render configuration only. Durable authorization is still
owned by Pithos built-ins. If you invent new agent kinds or capabilities, this
manifest alone is not enough.

## Harness argv model

Spawner turns `agents.json` into argv/env for the chosen harness. This config is
therefore close to the underlying CLI surface.

Supported harnesses today:

- `claude` — Claude Code CLI.
- `pi` — Pi CLI.

When changing models, tool names, or prompt/system-prompt behavior, prefer the
real harness help as the source of truth:

```sh
claude --help
claude --print --help
pi --help
pi --print --help
```

Keep tool names valid for the selected harness. Do not add compatibility aliases
or fallback values here; invalid config should fail loudly.

## Template variables

Templates use simple `{{variable}}` substitution. Unknown variables fail loudly.
Includes are inserted as raw text and are not recursively rendered.

Available variables:

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
- one variable per include filename, for example `{{_common.md}}`

Templates receive launch/self-claim context only. They do not receive task
bodies.

## Safe editing checklist

1. Keep `agents.json` valid JSON.
2. Keep every referenced `template` and `includes` file present in this directory.
3. Keep include names as basenames only, not paths.
4. Choose harness `kind`, `model`, and `tools` from the real harness CLI docs/help.
5. Do not remove required launch/self-claim instructions from prompts unless you
   are intentionally changing runtime behavior.
6. After edits, run a preview from the project if available, for example:

```sh
PDX_DATA_DIR="$(pwd)/.." pandora-spawn preview \
  --agent war \
  --mode afk \
  --scope scope_repo \
  --run run_preview \
  --session-id 123e4567-e89b-12d3-a456-426614174000 \
  --cwd "$PWD"
```
