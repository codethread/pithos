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
  "launchers": {
    "local_claude_tmux": {
      "kind": "tmux",
      "harness": "claude-code",
      "commands": {
        "spawn": "pandora-spawn --agent {{agent}} --scope {{scope_id}} --cwd {{cwd}}",
        "status": "pandora-spawn status --session-id {{session_id}} --lines {{lines}}",
        "nudge": "pandora-spawn nudge --target {{target}} --message {{message}}",
        "kill": "pandora-spawn kill --target {{target}}",
        "tty_status": "pandora-spawn tty-status --target {{target}}"
      },
      "meta": { "status_source": "claude_jsonl", "tty_provider": "tmux" }
    }
  },
  "agents": [
    {
      "agent": "envy",
      "model": "opus",
      "tools": ["Bash", "Read", "Grep", "Glob"],
      "capability": "implement",
      "includes": ["_common.md"],
      "system_prompt": "envy.md.tmpl",
      "launcher": "local_claude_tmux",
      "inject_meta": false
    }
  ]
}
```

Rules:

- For mutating `implement` tasks, Envy is the coordinator only; a separate worker sub-session should perform repo/worktree mutations.
- Worker-backed `implement` results should be attached with `pithos artifact add --kind worker-completion` before task completion.
- `agent` is the CLI name: `pandora-spawn --agent envy`.
- `system_prompt` must be `<agent>.md.tmpl`.
- `tools` must be non-empty; rendered into the prompt body as `{{tools_csv}}` for the agent's awareness. It is not passed to Claude as a CLI flag — `--dangerously-skip-permissions` + `--permission-mode acceptEdits` are used instead so the agent can act without prompts.
- `includes` names files in `templates/`; path separators are rejected.
- Includes are not automatically appended. Each include becomes a template var keyed by filename, so `"includes": ["_common.md"]` makes `{{_common.md}}` available in the system prompt.
- `launcher` names a key in the top-level `launchers` block. Its `commands` are rendered into the prompt as `{{cmd_spawn}}` / `{{cmd_status}}` / `{{cmd_nudge}}` / `{{cmd_kill}}` / `{{cmd_tty_status}}` so the agent knows how to drive its peers.
- `inject_meta: true` exposes the launcher's `kind`/`harness`/`meta` block as `{{launcher_meta}}` (a fenced JSON section). Pandora gets this; her evils don't.
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
- `session_id`
- `scope_id`
- `task_id` — empty string when absent
- `cwd`
- `pithos_help` — `pithos --help` output, captured at spawn time
- `cmd_spawn`, `cmd_status`, `cmd_nudge`, `cmd_kill`, `cmd_tty_status` — launcher command templates; empty string when the agent has no `launcher`
- `launcher_meta` — fenced JSON block describing the launcher; empty unless `inject_meta: true`
- each include filename, e.g. `{{_common.md}}`

Unknown vars fail loudly.

## Demo: explicit Envy spawn flow

Full sequence from a fresh store to a registered Envy run.

For mutating implementation tasks, the Envy session coordinates and reports; it should not directly mutate the repo itself, and the resulting task artifact should use kind `worker-completion`.

```sh
# 1. Initialise the Pithos store (idempotent)
pithos init

# 2. Register the repo scope
pithos scope upsert --kind repo --path "$PWD"

# 3. Enqueue a task for the Envy agent
pithos enqueue \
  --scope repo:$(echo "$PWD" | sed "s|$HOME/||g") \
  --capability implement \
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
`--harness fake` returns the assembled `{ env, argv, prompt }` JSON instead of
launching Claude. `--preview` is similar but does **not** register a run and uses
stable placeholder ids; use it when iterating on templates without touching state.

For the real Claude harness, `pandora-spawn` writes a wrapper bash script and
launches it via `tmux new-session -d -s pithos-<agent>-<short>` so Claude has a
TTY regardless of how `pandora-spawn` was invoked. The JSON envelope returns
`tmux_session`, `script_path`, and `pane_pid`; attach with
`tmux attach -t <tmux_session>` to interact.

### Install global Claude Code hooks (optional)

On Nix systems where `~/.claude/settings.json` is a read-only home-manager symlink, use the Claude Code plugin instead — see the [plugin install instructions](../../claude-plugin/README.md). The plugin registers the same two hook entries declaratively without touching `settings.json`.

On systems where `~/.claude/settings.json` is writable, the CLI install works directly:

```sh
# Merges PreToolUse + SessionEnd entries into ~/.claude/settings.json
pandora-spawn hooks install

# To undo
pandora-spawn hooks uninstall
```

Hooks no-op in normal Claude sessions — they only activate when `PITHOS_AGENT`
and `PITHOS_RUN_ID` are set, which `pandora-spawn` injects automatically.
