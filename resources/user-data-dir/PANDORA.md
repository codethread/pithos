# Pandora's Box config reference

This file is installed into `<user-data-dir>/PANDORA.md` by `pdx init` / `pdx open`.
It is bundle-owned reference material and may be overwritten on upgrade or re-init.
Do not customize Pandora's Box here; put your changes in user-owned or project-owned config files instead.
If you version-control your config directory, add `PANDORA.md` to `.gitignore` unless you intentionally track bundled reference docs.

## What Pandora's Box is

- `pdx` is the local supervisor that opens/closes the box and manages live agents.
- Pithos is the durable state system for tasks, runs, artifacts, and task graph history.
- Spawner renders prompts and launches harness sessions.
- Pandora is the long-lived HITL agent.
- Envy, Toil, Greed, and War are the other built-in agents.
- Harnesses are the underlying runtimes such as Claude Code or Pi.

## Config ownership

- `<data-dir>/` is pdx-owned runtime state plus bundled canonical config reference.
  `pdx init` and `pdx open` overwrite `<data-dir>/agents.toml`, `<data-dir>/templates/`, and `<data-dir>/AGENTS.md`.
- `<user-data-dir>/` is user-owned config.
  `pdx` scaffolds `<user-data-dir>/AGENTS.md`, `<user-data-dir>/CLAUDE.md`, and `<user-data-dir>/agents.toml` once and re-seeds this `PANDORA.md` reference on `init` / `open`.
- `<repo-root>/.pdx/` is optional project-local config for repo/worktree launches.

Defaults and related env vars:

- `PDX_DATA_DIR` sets `<data-dir>`; default is `~/.pdx`
- `PDX_USER_DATA_DIR` sets `<user-data-dir>`; default is `<data-dir>/config`
- `PITHOS_DB` points at the Pithos SQLite DB used by CLIs and agents

## Layer order

Only `agents.toml` merges across layers. Template assets are whole files selected by reference name.

Global scope launches read:

1. `<data-dir>`
2. `<user-data-dir>`
3. `<user-data-dir>/scopes/global`

Repo scope launches read:

1. `<data-dir>`
2. `<user-data-dir>`
3. `<user-data-dir>/scopes/repo`
4. `<repo-root>/.pdx`
5. `<repo-root>/.pdx/scopes/repo`

Worktree scope launches read:

1. `<data-dir>`
2. `<user-data-dir>`
3. `<user-data-dir>/scopes/worktree`
4. `<parent-repo-root>/.pdx`
5. `<parent-repo-root>/.pdx/scopes/worktree`

## `agents.toml` basics

User and project manifests are partials. Change only the fields you intend to override.

Scalar fields replace lower-priority values when present, such as:

- `agents.<kind>.template`
- `agents.<kind>.harness.kind`
- `agents.<kind>.harness.model`
- `agents.<kind>.harness.system_prompt_mode`
- `hooks.input.enabled`
- `hooks.input.command`

List fields use explicit list operations:

- `replace = [...]`
- `add = [...]`
- `remove = [...]`

Supported list fields:

- `agents.<kind>.includes`
- `agents.<kind>.appends`
- `agents.<kind>.harness.tools`
- `agents.<kind>.harness.argv`

Example:

```toml
[agents.war.harness.tools]
add = ["edit", "write"]

[agents.war.appends]
add = ["war-local.md"]
```

## Template asset basics

- Put user-wide template files under `<user-data-dir>/templates/`
- Put scope-kind template files under `<user-data-dir>/scopes/<global|repo|worktree>/templates/`
- Put project-local template files under `<repo-root>/.pdx/templates/` or `.pdx/scopes/<repo|worktree>/templates/`
- Asset references like `agents/war.md` or `common/base.md` resolve by reference name through the eligible layers from highest priority to lowest
- Template files do not merge; the first matching file wins
- Use `appends` when you want additive prompt text without replacing the main template file

## Hooks

Input hooks let an external watcher feed signals to Envy. Configure them in a
config layer that applies to global scope, usually `<user-data-dir>/agents.toml`
or `<user-data-dir>/scopes/global/agents.toml`:

```toml
[hooks.input]
command = ["/path/to/watcher", "--flag"]
```

`command` is an argv array. It is not run through a shell, so include the
executable and each argument as separate strings. To disable a lower-layer hook
without replacing it:

```toml
[hooks.input]
enabled = false
```

Do not set `enabled = false` together with `command`.

The input hook runs as a long-lived producer after Pandora is live. pdx closes
hook stdin, reads hook stdout as newline-delimited JSON, and writes hook stderr
to `<data-dir>/runs/hook.stderr.log`.

Each stdout line must be one JSON object:

```json
{ "title": "New bug report", "body": "Full signal text for Envy to classify." }
```

Required fields:

- `title` — non-empty string used as the intake Task title
- `body` — non-empty string used as the intake Task body

For each valid line, pdx creates a global `intake` Task. Envy claims that Task,
classifies the signal, and enqueues one downstream Task: `triage`, `design`, or
`escalate`. Put workflow-specific classification rules in Envy template
overrides/appends.

Invalid JSON or invalid fields are logged and skipped; the hook keeps running.
If the hook exits, pdx restarts it with backoff. Repeated crashes create an
`input_hook_stuck` Repair Alert for Pandora and stop restarts until pdx is
restarted.

Hooks belong in global config layers only, not repo/worktree project layers.

## Validation

Validate rendering with `pandora-spawn preview`:

```sh
pandora-spawn preview \
  --agent war \
  --mode afk \
  --scope repo:$PWD \
  --run run_preview \
  --session-id 123e4567-e89b-12d3-a456-426614174000 \
  --cwd "$PWD"
```

## Reset behavior

- `pdx init` / `pdx open` re-seed bundle-owned canonical config and this reference file
- `--clean` wipes runtime state only: DB, runs, logs, socket
- `--nuke` wipes pdx-owned runtime/bundled state while preserving `<user-data-dir>`, then re-seeds canonicals

Prefer editing user-owned `agents.toml`, user-owned `templates/`, or project-local `.pdx/` files instead of editing bundle-owned reference material.
