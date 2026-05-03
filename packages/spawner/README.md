# @pithos/spawner

Tiny CLI for turning versioned agent templates into Claude Code sessions.

`pandora-spawn` owns agent config, prompt rendering, hook installation, and the Claude/fake harness boundary. Pithos state is still handled only by the `pithos` CLI subprocess.

## CLI

```sh
pandora-spawn --agent envy --scope repo:work/example --harness fake
pandora-spawn templates list
pandora-spawn hooks install
pandora-spawn hooks uninstall
```

Default command is spawn. Output is JSON.

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
- JSON/template errors exit with code `2`.

### Prompt template vars

Templates are plain markdown with `{{var}}` replacement only. No conditionals, loops, escaping, or helpers.

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
