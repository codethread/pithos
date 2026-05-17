# Templates

Repo-root default manifest and prompt templates for Pandora's Box.

## Bundle-owned vs user-owned

`<data-dir>/templates/` is bundle-owned. `pdx init` and `pdx open` always re-seed
it from the bundled repo defaults (chmod writable → wipe → copy → chmod read-only).
Files land at mode 0444 (files) / 0555 (directories). Do not edit them directly;
changes will be overwritten on the next `pdx init` or `pdx open`.

User customisations live in `<data-dir>/extensions/templates/`. This directory
mirrors the templates tree and is **never touched by pdx**. Spawner checks
`extensions/templates/<rel>` first before falling back to `templates/<rel>` for
every path referenced in the manifest (the `agents.json` file itself, each
`template`, `includes`, and `appends` entry). The override is per-file — no
merging. Any declared path that resolves to nothing in either layer is a hard
error.

## Lifecycle flags

- `pdx init` / `pdx open` — re-seed bundled templates (always). Leave
  `extensions/`, db, runs, and logs alone.
- `--clean` — wipe runtime state only: db, runs, and logs. Keep templates and
  extensions.
- `--nuke` — wipe the entire data dir.
- `--clean` and `--nuke` are mutually exclusive.

`--update` has been removed; template updates happen automatically whenever pdx
is upgraded and `pdx init` or `pdx open` is run.

## Files

- `agents.json` — agent manifest: mode, harness kind/model/tools, include list, appends list, template file
- `*.md` — prompt templates per agent kind
- `_common.md` — shared include
- `_common-afk.md` — AFK-only runtime rules
- `_common-hitl.md` — HITL-only runtime rules
- `shared/repo-default-branch-guard.md` — Toil/Greed guard against direct implementation edits on repo default branches
- `war/cwd-guard.md` — War guard requiring cwd/scope verification before file edits
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
			"includes": ["_common.md", "_common-afk.md"],
			"appends": ["~/my-extensions/war-extra.md"],
			"template": "war.md"
		}
	]
}
```

| Field                        | Required | Contract                                                                                                                                                                                                                                                                      |
| ---------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents`                     | yes      | array of manifest entries                                                                                                                                                                                                                                                     |
| `agent`                      | yes      | one of `pandora`, `toil`, `greed`, `war`, `envy`                                                                                                                                                                                                                              |
| `mode`                       | yes      | `afk` or `hitl`; must match the mode `pdx` requests                                                                                                                                                                                                                           |
| `harness.kind`               | yes      | `claude` or `pi`                                                                                                                                                                                                                                                              |
| `harness.model`              | yes      | non-empty model string passed to the Harness CLI                                                                                                                                                                                                                              |
| `harness.system_prompt_mode` | yes      | `replace` -> `--system-prompt`; `append` -> `--append-system-prompt`                                                                                                                                                                                                          |
| `harness.tools`              | optional | non-empty array when present; rendered as comma-separated `--tools` value                                                                                                                                                                                                     |
| `harness.argv`               | optional | verbatim string array; tokens are inserted after the binary name and before all Spawner-managed flags; each element must be non-empty; use for harness features not modeled by other fields, e.g. `["--plugin-dir", "~/my-plugins"]` for Claude Code plugins                  |
| `includes`                   | optional | unique template paths resolved through the overlay; relative paths resolve from the templates directory; absolute and `~/` paths are allowed; no recursive rendering. Use includes for pre-claim guard/preamble content that must appear before the template's required flow. |
| `appends`                    | optional | unique template paths resolved through the overlay; concatenated verbatim **after** the rendered template, joined by `\n\n---\n\n`; same path resolution rules as `includes`                                                                                                  |
| `template`                   | yes      | template path resolved through the overlay; relative paths resolve from the templates directory; absolute and `~/` paths are allowed                                                                                                                                          |

Current built-in claim/enqueue contract:

| Agent kind | Mode today | Claims     | Enqueues                                  |
| ---------- | ---------- | ---------- | ----------------------------------------- |
| `pandora`  | `hitl`     | `escalate` | `triage`, `design`, `escalate`            |
| `toil`     | `afk`      | `triage`   | `triage`, `design`, `execute`, `escalate` |
| `greed`    | `hitl`     | `design`   | `triage`, `design`, `escalate`            |
| `war`      | `afk`      | `execute`  | `escalate`                                |
| `envy`     | `afk`      | `intake`   | `triage`, `design`, `escalate`            |

Built-in claim/enqueue authorization stays in Pithos. If you change Agent kinds or Capabilities, update Pithos built-ins and keep the manifest's agent roster aligned.

## Extensions overlay

Place customisations in `<data-dir>/extensions/templates/` to add or override
prompt content without touching bundle-owned files. This directory is never
seeded, never wiped, and never made read-only by pdx — it is entirely yours.

**Per-file override** — Spawner resolves every path by first checking
`extensions/templates/<rel>`, then falling back to `templates/<rel>`. There is
no merging of file contents; the first file found wins. To override `agents.json`
or any template, place a complete replacement file at the corresponding path in
`extensions/templates/`.

**`appends`** — add extra content to a rendered prompt without replacing anything:

1. Create your append file anywhere visible to Spawner (e.g.
   `<data-dir>/extensions/templates/my-war-rules.md`).
2. Reference it in `extensions/templates/agents.json` under the agent's `appends`
   list (requires overriding the full `agents.json`):

```json
{
	"agent": "war",
	...
	"appends": ["my-war-rules.md"]
}
```

Spawner concatenates each append file verbatim after the rendered template,
separated by `\n\n---\n\n`. Append files go through the same overlay resolution
as includes and templates; absolute and `~/` paths are accepted.

## Migration note

If you have hand-edited files inside `<data-dir>/templates/`, those edits will be
**overwritten** the next time `pdx init` or `pdx open` runs. Before upgrading,
copy any custom content out of `<data-dir>/templates/` and into
`<data-dir>/extensions/templates/`. Use `appends` for additive content or replace
individual files wholesale via the overlay. The read-only chmod on
`<data-dir>/templates/` after seeding surfaces this contract immediately on any
write attempt.

Pre-v1 command-card rendering changed `{{command_cards}}` from raw help JSON to
generated Markdown reference content. User extension templates that parsed the
old raw JSON must treat `command_cards` as prose/reference content instead, or
replace the affected template wholesale with their own command-reference source.

## `hooks` field

`agents.json` may contain an optional top-level `hooks` block to configure
pdx-managed external processes:

```json
{
  "agents": [...],
  "hooks": {
    "input": { "command": ["/path/to/script", "--arg"] }
  }
}
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
template overrides or appends, commonly under `extensions/templates/envy/` in
the user data dir.

## Template contract

Templates use simple `{{variable}}` substitutions. Unknown variables fail loudly.
Includes are inserted as raw text and are not recursively rendered.

Render order:

1. Each `includes` entry is substituted inline at its `{{path}}` placeholder.
2. The `template` body is rendered with all placeholder substitutions.
3. Each `appends` entry is read and appended verbatim after the rendered template,
   joined by `\n\n---\n\n`.

All path references (`template`, `includes`, `appends`) are resolved through the
overlay (extensions layer first, bundle fallback) and support three forms:

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

- when `PDX_DATA_DIR` is set, load manifest/templates from `$PDX_DATA_DIR/templates/`
  with overlay from `$PDX_DATA_DIR/extensions/templates/` (extensions take priority)
- when `PDX_DATA_DIR` is unset, load the bundled repo-root `templates/` defaults
  (no extensions layer)

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
