# @pithos/spawner

Tiny CLI for turning versioned agent templates into sessions in an agent harness like Claude Code.

Claude Code is the first supported harness; `fake` is the deterministic test harness. The package is intentionally shaped so other harness adapters can be added later without moving Pithos state into the spawner.

`pandora-spawn` owns agent config, prompt rendering, hook installation, and harness process setup. Pithos state is still handled only by the `pithos` CLI subprocess.

## CLI

```sh
pandora-spawn --agent envy --scope repo:work/example --harness fake
pandora-spawn --agent envy --scope repo:work/example --preview
pandora-spawn templates list
pandora-spawn hooks install
pandora-spawn hooks uninstall
```

Default command is spawn. Output is JSON.

`--preview` renders the prompt and prints the harness command/env/cwd JSON without registering a run or starting the harness. It uses stable placeholder IDs (`run_PREVIEW`, `session_PREVIEW`) unless overridden with `PANDORA_SPAWN_FAKE_RUN_ID` / `PANDORA_SPAWN_FAKE_SESSION_ID`.

## templates/ API

All user-tuned agent config lives in `templates/`:

```text
templates/
  agents.json      # agent manifest list
  _common.md       # shared include text
  envy.md.tmpl     # system prompt template for envy
  toil.md.tmpl     # system prompt template for toil
```

### `agents.json`

```json
{
  "agents": [
    {
      "agent": "envy",
      "model": "opus",
      "tools": ["Bash", "Read", "Grep", "Glob"],
      "capability": "watch",
      "includes": ["_common.md"],
      "system_prompt": "envy.md.tmpl"
    }
  ]
}
```

Rules:

- `agent` is the CLI name: `pandora-spawn --agent envy`.
- `system_prompt` must be `<agent>.md.tmpl`.
- `tools` must be non-empty; rendered as `{{tools_csv}}` and passed to Claude `--tools`.
- `includes` names files in `templates/`; path separators are rejected.
- Includes are not automatically appended. Each include becomes a template var keyed by filename, so `"includes": ["_common.md"]` makes `{{_common.md}}` available in the system prompt.
- JSON/template errors exit with code `2`.

### Prompt template vars

Templates are plain markdown with `{{var}}` replacement only. No conditionals, loops, escaping, or helpers.

Include placement is explicit: put the include placeholder exactly where the file content should appear. Example:

```md
## Invariants

{{_common.md}}
```

At render time, `{{_common.md}}` is replaced with the full contents of `templates/_common.md`. If an include is listed in `agents.json` but its placeholder is absent, it is loaded but not rendered anywhere. If a placeholder references an include not listed in `agents.json`, rendering fails as an unknown var.

Available vars:

- `agent`
- `capability`
- `model`
- `tools_csv`
- `run_id`
- `scope_id`
- `task_id` — empty string when absent
- `cwd`
- `pithos_help`
- each include filename, e.g. `{{_common.md}}`

Unknown vars fail loudly.

## Demo: explicit Envy spawn flow

Full sequence from a fresh store to a registered Envy run.

```sh
# 1. Initialise the Pithos store (idempotent)
pithos init

# 2. Register the repo scope
pithos scope upsert --kind repo --path "$PWD"

# 3. Enqueue a task for the Envy agent
pithos enqueue \
  --scope repo:$(echo "$PWD" | sed "s|$HOME/||g") \
  --capability watch \
  --title "Example task"

# 4a. Spawn Envy (offline / fake harness — no Claude exec)
pandora-spawn --agent envy \
  --scope repo:$(echo "$PWD" | sed "s|$HOME/||g") \
  --harness fake | jq .

# 4b. Same spawn with real Claude
pandora-spawn --agent envy \
  --scope repo:$(echo "$PWD" | sed "s|$HOME/||g")

# 5. Verify the run was registered
pithos inspect run <run_id from step 4 output>
```

For fully offline reproduction use `--harness fake`; the run is still registered in
the Pithos DB via `pithos run register` so `pithos inspect run` works regardless.

### Install global Claude Code hooks (optional)

```sh
# Merges PreToolUse + SessionEnd entries into ~/.claude/settings.json
pandora-spawn hooks install

# To undo
pandora-spawn hooks uninstall
```

Hooks no-op in normal Claude sessions — they only activate when `PITHOS_AGENT`
and `PITHOS_RUN_ID` are set, which `pandora-spawn` injects automatically.
