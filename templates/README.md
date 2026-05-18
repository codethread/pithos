# Templates

Repo-root default manifest and prompt templates for Pandora's Box.

## Bundle-owned vs user-owned

`<data-dir>/agents.toml` and `<data-dir>/templates/` are bundle-owned canonicals.
`pdx init` and `pdx open` always re-seed them from the bundled repo defaults
(chmod writable → wipe → copy → chmod read-only). Files land at mode 0444
(files) / 0555 (directories). Do not edit them directly; changes will be
overwritten on the next `pdx init` or `pdx open`.

User customisations live in `<user-data-dir>/`, where `<user-data-dir>` is
`$PDX_USER_DATA_DIR` or defaults to `<data-dir>/config`. That tree is
**user-owned** except for the installed reference file `PANDORA.md`, which pdx
re-seeds on `init` / `open`; the direct-agent pointer `AGENTS.md` is scaffolded
once only. Spawner resolves config by ordered layers:

- bundled canonical: `<data-dir>`
- user-wide: `<user-data-dir>`
- scope-kind user layer: `<user-data-dir>/scopes/<global|repo|worktree>`
- project-local repo layer: `<repo-root>/.pdx`
- project-local scope-kind layer: `<repo-root>/.pdx/scopes/<repo|worktree>`

Only `agents.toml` merges across layers. Prompt files under each layer's
`templates/` directory remain whole-file assets selected by reference name.

## Lifecycle flags

- `pdx init` / `pdx open` — re-seed bundled `<data-dir>/agents.toml`,
  `<data-dir>/templates/`, and `<data-dir>/AGENTS.md`, plus installed
  `<user-data-dir>/PANDORA.md`. Leave other user config, db, runs, and logs
  alone.
- `--clean` — wipe runtime state only: db, runs, logs. Keep bundled config and
  user config.
- `--nuke` — wipe pdx-owned runtime/bundled state while preserving
  `<user-data-dir>`, then re-seed fresh canonicals.
- `--clean` and `--nuke` are mutually exclusive.

`--update` has been removed; template updates happen automatically whenever pdx
is upgraded and `pdx init` or `pdx open` is run.

## Files

- `agents.toml` — canonical bundled render manifest
- `*.md` — prompt templates per agent kind
- `_common.md` — shared include
- `_common-afk.md` — AFK-only runtime rules
- `_common-hitl.md` — HITL-only runtime rules
- `war/cwd-guard.md` — War core rule requiring cwd/scope verification before file edits
- `AGENTS.md` — source text for the scaffold-once user config pointer
- `PANDORA.md` — source text for the re-seeded installed user config reference
- `data-dir-AGENTS.md` — source text for the re-seeded data-dir runtime note

## `agents.toml` contract

`agents.toml` is render config, not durable authorization truth. Pithos seeds and
enforces authorization; Spawner derives claim/enqueue capabilities from Pithos
built-ins.

Canonical bundled shape:

```toml
[agents.war]
template = "war.md"
includes.replace = ["_common.md", "_common-afk.md"]
appends.replace = []

[agents.war.harness]
kind = "pi"
model = "openai-codex/gpt-5.4"
system_prompt_mode = "append"
tools.replace = ["bash", "read"]
argv.replace = []
```

User and project layers may define partial tables only for the fields they want
to change. Scalars replace lower-priority values; list fields use explicit
`replace`, `add`, and `remove` operations as documented in
[`specs/agent-configuration.md`](../specs/agent-configuration.md).

Supported config fields remain the same conceptual surface as before:

- `agents.<kind>.template`
- `agents.<kind>.includes`
- `agents.<kind>.appends`
- `agents.<kind>.harness.kind`
- `agents.<kind>.harness.model`
- `agents.<kind>.harness.system_prompt_mode`
- `agents.<kind>.harness.tools`
- `agents.<kind>.harness.argv`
- `hooks.input`

Current built-in claim/enqueue contract:

| Agent kind | Mode today | Claims             | Enqueues                                            |
| ---------- | ---------- | ------------------ | --------------------------------------------------- |
| `pandora`  | `hitl`     | `escalate`         | `triage`, `design`, `review`, `escalate`            |
| `toil`     | `afk`      | `triage`           | `triage`, `design`, `execute`, `review`, `escalate` |
| `greed`    | `hitl`     | `design`, `review` | `triage`, `design`, `escalate`                      |
| `war`      | `afk`      | `execute`          | `escalate`                                          |
| `envy`     | `afk`      | `intake`           | `triage`, `design`, `escalate`                      |

Built-in claim/enqueue authorization stays in Pithos. If you change Agent kinds or Capabilities, update Pithos built-ins and keep the manifest's agent roster aligned. Greed claims both `design` and `review`, but Greed, War, and Envy do not enqueue `review`; only Pandora and Toil route requested review work.

## Layered assets and `appends`

Place customisations under `<user-data-dir>/templates/`,
`<user-data-dir>/scopes/<kind>/templates/`, or project-local `.pdx/templates/`
depending on the scope you want to affect.

**Per-reference asset override** — manifest paths such as `war.md` or
`_common.md` are looked up by reference name across eligible layers from highest
priority to lowest. There is no file-content merge; the first matching
`templates/<reference>` wins.

**`appends`** — add extra content without replacing the main template. Example
user-wide partial:

```toml
[agents.war.appends]
add = ["war-rules.md"]
```

If `<user-data-dir>/templates/war-rules.md` exists, Spawner appends it verbatim
after the rendered template separated by `\n\n---\n\n`. Absolute and `~/` paths
are also allowed when you intentionally keep prompt assets outside pdx-managed
directories.

## Migration note

If you have hand-edited files inside `<data-dir>/templates/`, those edits will be
**overwritten** the next time `pdx init` or `pdx open` runs. Before upgrading,
copy any custom content out of `<data-dir>/templates/` and into a user-owned
`templates/` layer under `<user-data-dir>` or a project `.pdx` directory. Use
`agents.toml` list/scalar overrides plus `appends` for additive behavior. The
read-only chmod on `<data-dir>/templates/` after seeding surfaces this contract
immediately on any write attempt.

Pre-v1 command-card rendering changed `{{command_cards}}` from raw help JSON to
generated Markdown reference content. User extension templates that parsed the
old raw JSON must treat `command_cards` as prose/reference content instead, or
replace the affected template wholesale with their own command-reference source.

## `hooks` field

`agents.toml` may contain an optional top-level `hooks` block to configure
pdx-managed external processes:

```toml
[hooks.input]
command = ["/path/to/script", "--arg"]
```

### `hooks.input` — NDJSON input hook

When `hooks.input.command` is set, pdx spawns the specified executable as a
long-running child process. The child emits newline-delimited JSON on stdout;
pdx reads each line, validates it, and enqueues an `intake` task in global
scope for Envy to classify.

**Stdout line schema:** each line must be valid JSON with:

- `title: string` — required, non-empty
- `body: string` — required, non-empty

Lines that fail validation are logged and skipped; the stream continues.

**Command:** argv array — no shell evaluation. Example:

```json
{ "command": ["node", "/path/to/watcher.js", "--token", "abc"] }
```

**Lifecycle:**

- pdx spawns the hook after Pandora is live and supervises it independently of
  the reconcile loop.
- Hook stdin is closed (producer-only).
- Hook stdout is piped for NDJSON parsing; stderr is piped to
  `<data-dir>/runs/hook.stderr.log`.
- On exit, pdx restarts the hook with exponential backoff
  (1s → 2s → 4s → 8s → 16s → 30s cap). Backoff resets after 60s of continuous
  uptime.
- If the hook exits 5 or more times within a 60s window, pdx stops restarting
  and creates an `input_hook_stuck` Repair Alert for Pandora. To recover: fix
  the script, then restart pdx.
- Invalid hook configuration/rendering stops hook supervision and creates a
  `hook_config_error` Repair Alert for Pandora.
- On `pdx close`, pdx sends SIGTERM to the hook.

**Envy:** intake tasks created by the input hook are claimed by Envy. Envy
classifies each signal and enqueues a single downstream task (triage, design,
or escalate). Add workflow-specific classification knowledge through Envy
template overrides or appends in a user-owned or project-local `templates/`
layer.

## Template contract

Templates use simple `{{variable}}` substitutions. Unknown variables fail loudly.
Includes are inserted as raw text and are not recursively rendered.

Render order:

1. Each `includes` entry is substituted inline at its `{{path}}` placeholder.
2. The `template` body is rendered with all placeholder substitutions.
3. Each `appends` entry is read and appended verbatim after the rendered template,
   joined by `\n\n---\n\n`.

All path references (`template`, `includes`, `appends`) are resolved through the
eligible layer stack (highest-priority layer first, bundle fallback) and support
three forms:

- `snippets/common.md` — resolved relative to the templates directory
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
- `command_cards` — generated Markdown command reference sourced from role-filtered `pithos --help-json` and, for Pandora, selected `pdx --help-json` inspection commands; this is prose/reference content, not raw JSON
- `claims` (derived from built-in Pithos authorization)
- `enqueues` (derived from built-in Pithos authorization)
- `model`
- `tools_csv`
- one variable per include path exactly as listed, for example `{{_common.md}}`, `{{snippets/common.md}}`, or `{{~/agent/common.md}}`

`{{command_reference}}` is not a supported variable. Keep the variable name
`{{command_cards}}` unless Spawner explicitly adds and documents a new one.

Templates receive launch/self-claim context only. They do not receive task bodies.

## Environment contract

Render/preview needs DB context:

- `PITHOS_DB`, or
- `PDX_DATA_DIR`, from which Spawner derives `$PDX_DATA_DIR/pithos.sqlite`

Template loading keys off `PDX_DATA_DIR`:

- when `PDX_DATA_DIR` is set, load the canonical bundle from `$PDX_DATA_DIR/agents.toml`
  plus `$PDX_DATA_DIR/templates/`, then merge/search user and project layers via
  `PDX_USER_DATA_DIR` and scope context
- when `PDX_DATA_DIR` is unset, load the bundled repo-root defaults (`templates/agents.toml`
  plus `templates/`)

Agent command resolution:

- Templates and generated prompt snippets refer to `pithos` and `pdx` as bare commands.
- Put one stable bin directory on PATH in your shell rc, for example `fish_add_path ~/.local/bin` or `export PATH="$HOME/.local/bin:$PATH"`.
- Populate it once from the repo root with `make local` or `make install`; override the install target with `make install PDX_BIN_DIR=/path/to/bin` only when you intentionally use a different global bin directory.

Rendered Harness env includes:

- `PITHOS_DB`
- `PITHOS_RUN_ID`
- `PITHOS_SESSION_ID`
- `PITHOS_SCOPE_ID`
- `PDX_DATA_DIR` when provided; `pdx` commands use it as their data-dir default unless `--data-dir` is passed
- `PDX_USER_DATA_DIR` when provided; direct agents and previews use it as the user config root
