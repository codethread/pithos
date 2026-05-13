# Templates

Repo-root default manifest and prompt templates for Pandora's Box.

`pdx` treats this directory as the bundled source of truth for seeding
`<data-dir>/templates/`:

- `pdx init` creates the data dir and seeds templates without starting Pandora or the daemon
- `pdx open` reuses the existing data dir and only seeds templates when the user copy is missing
- `pdx init --update` / `pdx open --update` keep the existing DB/logs and replace `<data-dir>/templates/` from these repo defaults
- `pdx init --clean` / `pdx open --clean` wipe the full data dir first, including DB, logs, and templates

Normal user editing happens in `<data-dir>/templates/`, not here.

## Files

- `agents.json` — agent manifest: mode, harness kind/model/tools, include list, template file
- `*.md` — prompt templates per agent kind
- `_common.md` — shared include
- `AGENTS.md` — config-editing guide for direct agent sessions in this directory
- `CLAUDE.md` — symlink to `AGENTS.md` for Claude Code

## `agents.json` contract

`agents.json` is render config, not durable authorization truth. Pithos seeds and enforces authorization; Spawner derives claim/enqueue capabilities from Pithos built-ins.

Top-level shape:

```json
{
	"agents": [
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
			"template": "war.md"
		}
	]
}
```

| Field                        | Required | Contract                                                                                                                       |
| ---------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `agents`                     | yes      | array of manifest entries                                                                                                      |
| `agent`                      | yes      | one of `pandora`, `toil`, `greed`, `war`                                                                                       |
| `mode`                       | yes      | `afk` or `hitl`; must match the mode `pdx` requests                                                                            |
| `harness.kind`               | yes      | `claude` or `pi`                                                                                                               |
| `harness.model`              | yes      | non-empty model string passed to the Harness CLI                                                                               |
| `harness.system_prompt_mode` | yes      | `replace` -> `--system-prompt`; `append` -> `--append-system-prompt`                                                           |
| `harness.tools`              | optional | non-empty array when present; rendered as comma-separated `--tools` value                                                      |
| `includes`                   | optional | unique template paths; relative paths resolve from this directory; absolute and `~/` paths are allowed; no recursive rendering |
| `template`                   | yes      | template path; relative paths resolve from this directory; absolute and `~/` paths are allowed                                 |

Current built-in claim/enqueue contract:

| Agent kind | Mode today | Claims     | Enqueues                                  |
| ---------- | ---------- | ---------- | ----------------------------------------- |
| `pandora`  | `hitl`     | `escalate` | `triage`, `design`, `escalate`            |
| `toil`     | `afk`      | `triage`   | `triage`, `design`, `execute`, `escalate` |
| `greed`    | `hitl`     | `design`   | `triage`, `design`, `escalate`            |
| `war`      | `afk`      | `execute`  | `escalate`                                |

Built-in claim/enqueue authorization stays in Pithos. If you change Agent kinds or Capabilities, update Pithos built-ins and keep the manifest's agent roster aligned.

## Template contract

Templates are simple `{{variable}}` substitutions. Unknown variables fail loudly. Includes are inserted as raw text and are not recursively rendered.

Template and include paths support three forms:

- `snippets/common.md` — resolved relative to this templates directory
- `/absolute/path/common.md` — loaded directly
- `~/instruction-files/common.md` — `~` expands to the current user's home directory

External paths make it possible to keep prompt files outside `<data-dir>/templates/`, for example in a separate version-controlled instruction repo.

Available template variables:

- `agent`
- `run_id`
- `session_id`
- `scope_id`
- `cwd`
- `claim_command`
- `command_cards`
- `claims` (derived from built-in Pithos authorization)
- `enqueues` (derived from built-in Pithos authorization)
- `model`
- `tools_csv`
- one variable per include path exactly as listed, for example `{{_common.md}}`, `{{snippets/common.md}}`, or `{{~/agent/common.md}}`

Templates receive launch/self-claim context only. They do not receive task bodies.

## Environment contract

Render/preview needs DB context:

- `PITHOS_DB`, or
- `PDX_DATA_DIR`, from which Spawner derives `$PDX_DATA_DIR/pithos.sqlite`

Template loading keys off `PDX_DATA_DIR`:

- when `PDX_DATA_DIR` is set, load manifest/templates from `$PDX_DATA_DIR/templates/`
- when `PDX_DATA_DIR` is unset, load the bundled repo-root `templates/` defaults

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
