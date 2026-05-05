# @pithos/spawner

Tiny CLI for turning versioned agent templates into sessions in an agent harness like Claude Code or Pi.

Supported harnesses:

- `claude` — Claude Code in tmux
- `pi` — Pi in tmux
- `fake` — deterministic test harness

The package keeps Pithos state in the `pithos` CLI subprocess and treats the harness as an injectable adapter.

`pandora-spawn` owns agent config, prompt rendering, hook installation, and harness process setup. Pithos state is still handled only by the `pithos` CLI subprocess.

`pandora-spawn status --session-id <id>` auto-detects Claude Code and Pi JSONL session logs.

## CLI

```sh
pandora-spawn --agent envy --scope repo:work/example --harness fake
pandora-spawn --agent envy --scope repo:work/example --harness claude
pandora-spawn --agent pandora --scope repo:work/example --harness pi
pandora-spawn --agent envy --scope repo:work/example --preview
pandora-spawn templates list
```

Liveness/session-end hooks ship as harness adapters:

- Claude Code plugin — [`claude-plugin/README.md`](claude-plugin/README.md)
- Pi extension — [`pi-extension/README.md`](pi-extension/README.md)
- shared contract — [`HOOKS.md`](HOOKS.md)

Default command is spawn. Output is JSON.

`--preview` renders the prompt and prints the harness command/env/cwd JSON without registering a run or starting the harness. It uses stable placeholder IDs (`run_PREVIEW`, `session_PREVIEW`) unless overridden with `PANDORA_SPAWN_FAKE_RUN_ID` / `PANDORA_SPAWN_FAKE_SESSION_ID`.

## templates/ API

All user-tuned agent config lives in `templates/`:

```text
templates/
  agents.json       # agent manifest list
  _common.md        # shared include text
  pandora.md.tmpl   # system prompt template for pandora
  envy.md.tmpl      # system prompt template for envy
  toil.md.tmpl      # system prompt template for toil
  worker.md.tmpl    # system prompt template for worker
```

### `agents.json`

```json
{
  "launchers": {
    "local_agent_tmux": {
      "kind": "tmux",
      "harness": "pandora-spawn",
      "commands": {
        "spawn": "pandora-spawn --agent {{agent}} --scope {{scope_id}} --cwd {{cwd}}",
        "status": "pandora-spawn status --session-id {{session_id}} --lines {{lines}}",
        "nudge": "pandora-spawn nudge --target {{target}} --message {{message}}",
        "kill": "pandora-spawn kill --target {{target}}",
        "tty_status": "pandora-spawn tty-status --target {{target}}"
      },
      "meta": { "status_source": "session_jsonl_auto", "tty_provider": "tmux" }
    }
  },
  "agents": [
    {
      "agent": "envy",
      "harness": {
        "kind": "claude",
        "model": "sonnet",
        "tools": ["Bash", "Read", "Edit", "Write", "Grep", "Glob", "LS"],
        "system_prompt_mode": "replace"
      },
      "capability": "implement",
      "includes": ["_common.md"],
      "system_prompt": "envy.md.tmpl",
      "launcher": "local_agent_tmux",
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
- `harness` is a single discriminated config keyed by `kind`. Define only the harness this agent should use.
  - `kind: "claude"` validates Claude Code tool names (`Bash`, `Read`, `Edit`, `Write`, `Grep`, `Glob`, `LS`) and renders Claude flags.
  - `kind: "pi"` validates Pi tool names (`bash`, `read`, `edit`, `write`, `grep`, `find`, `ls`) and renders Pi flags.
  - `model` is interpreted by that harness directly; no cross-harness model aliasing or tool mapping is performed.
  - `system_prompt_mode` is `replace` (`--system-prompt`) or `append` (`--append-system-prompt`).
  - `--harness` is optional; when omitted, the template's `harness.kind` is used. If supplied, it must match except `fake`, which renders the configured argv without launching.
- The selected harness config's `tools` are rendered into the prompt body as `{{tools_csv}}` for the agent's awareness.
- `includes` names files in `templates/`; path separators are rejected.
- Includes are not automatically appended. Each include becomes a template var keyed by filename, so `"includes": ["_common.md"]` makes `{{_common.md}}` available in the system prompt.
- `launcher` names a key in the top-level `launchers` block. Its `commands` are rendered into the prompt as `{{cmd_spawn}}` / `{{cmd_status}}` / `{{cmd_nudge}}` / `{{cmd_kill}}` / `{{cmd_tty_status}}` so the agent knows how to drive its peers. These commands are the stable shared launcher API across tmux-backed harnesses.
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
- `model` — selected harness config model
- `tools_csv` — selected harness config tools
- `run_id`
- `session_id`
- `scope_id`
- `task_id` — empty string when absent
- `cwd`
- `pithos_help` — `pithos --help` output, captured at spawn time
- `cmd_spawn`, `cmd_status`, `cmd_nudge`, `cmd_kill`, `cmd_tty_status` — launcher command templates; empty string when the agent has no `launcher`
- `launcher_meta` — fenced JSON block describing the launcher; empty unless `inject_meta: true`
- `session_target` — tmux target derived from `session_id`
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

# 4b. Same spawn with real Claude (matches Envy's manifest)
pandora-spawn --agent envy \
  --scope repo:$(echo "$PWD" | sed "s|$HOME/||g") \
  --harness claude

# 4c. Pi-backed spawn (matches Pandora's manifest)
pandora-spawn --agent pandora \
  --scope repo:$(echo "$PWD" | sed "s|$HOME/||g") \
  --harness pi

# 5. Verify the run was registered
pithos inspect run <run_id from step 4 output>
```

For fully offline reproduction use `--harness fake`; the run is still registered in
the Pithos DB via `pithos run register` so `pithos inspect run` works regardless.
`--harness fake` returns the assembled launch description JSON instead of
launching a real harness. `--preview` is similar but does **not** register a run and uses
stable placeholder ids; use it when iterating on templates without touching state.

For the real `claude` and `pi` harnesses, `pandora-spawn` writes a wrapper bash script and
launches it via `tmux new-session -d -s pithos-<agent>-<short>` so the harness has a
TTY regardless of how `pandora-spawn` was invoked. The JSON envelope returns
`tmux_session`, `script_path`, and `pane_pid`; attach with
`tmux attach -t <tmux_session>` to interact.

### Install harness hooks

- Claude Code: [`claude-plugin/`](./claude-plugin/README.md)
- Pi: [`pi-extension/`](./pi-extension/README.md)
- Shared contract: [`HOOKS.md`](./HOOKS.md)

Hooks no-op in normal sessions — they only activate when `PITHOS_AGENT`
and `PITHOS_RUN_ID` are set, which `pandora-spawn` injects automatically.

## Session log introspection

Session JSONL logs are the ground truth for understanding what an agent actually did.
Prefer them over raw tmux capture.

Claude Code logs live under:

```text
~/.claude/projects/<project-dir>/<session-id>.jsonl
```

Pi logs live under:

```text
~/.pi/agent/sessions/**/<session-id>.jsonl
```

Quick recipes:

```sh
# Find a session log
find ~/.claude/projects ~/.pi/agent/sessions -name '<session-id>.jsonl'

LOG="$(find ~/.claude/projects ~/.pi/agent/sessions -name '<session-id>.jsonl' | head -n1)"

# Assistant text
jq -r 'select(.type == "assistant") | .message.content[]? | select(.type == "text") | .text' "$LOG"

# Claude Code Bash tool calls
jq -r 'select(.type == "assistant") | .message.content[]? | select(.type == "tool_use" and .name == "Bash") | .input.command' "$LOG"
```

For live summaries without raw jq, use:

```sh
pandora-spawn status --session-id <session-id> --lines 20
```
