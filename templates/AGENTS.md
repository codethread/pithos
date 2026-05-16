# Template config agent guide

The repo-root `templates/` directory is the bundled source. After `pdx init` or
`pdx open`, `<data-dir>/templates/` holds a read-only copy (files 0444, dirs 0555) that is **always refreshed** from the bundle. Do not edit files there
directly — they will be overwritten on the next init/open.

User customisations live in `<data-dir>/extensions/templates/`. Spawner checks
that directory first before falling back to `<data-dir>/templates/`. To change
harness config, models, tools, or prompt wording, place edited files in the
extensions layer, not in the bundle-owned templates dir.

## Files

- `agents.json` — render manifest for each agent kind.
- `*.md` — prompt template for an agent kind.
- `_common.md` — shared include text used by templates.
- `_common-afk.md` — AFK-only runtime rules.
- `_common-hitl.md` — HITL-only runtime rules.
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
		"tools": ["bash", "read"],
		"argv": ["--plugin-dir", "~/my-plugins"]
	},
	"includes": ["_common.md", "_common-afk.md"],
	"appends": ["~/my-extensions/war-extra.md"],
	"template": "war.md"
}
```

Fields:

- `agent`: one of `pandora`, `toil`, `greed`, `war`, `envy`.
- `mode`: `afk` or `hitl`; must match the mode Pandora's Box launches.
- `harness.kind`: `claude` or `pi`.
- `harness.model`: non-empty model string passed to the selected harness CLI.
- `harness.system_prompt_mode`:
  - `replace` renders as the harness `--system-prompt` style flag.
  - `append` renders as the harness `--append-system-prompt` style flag.
- `harness.tools`: optional non-empty array; rendered into the harness `--tools`
  argv value as a comma-separated list.
- `harness.argv`: optional string array; each element is inserted verbatim into
  the harness command line after the binary name and before all Spawner-managed
  flags. Use for harness features not modeled by other fields, such as
  `["--plugin-dir", "~/my-plugins"]` for Claude Code plugins. Elements must be
  non-empty; no tilde expansion or env substitution is applied.
- `includes`: optional list of template paths resolved through the overlay.
  Relative paths resolve from the templates directory; absolute and `~/` paths
  are allowed. No recursive include rendering. Use includes for pre-claim
  guard or preamble content that must appear before the template's required
  flow.
- `appends`: optional list of template paths resolved through the overlay.
  Files are concatenated verbatim **after** the rendered template, joined by
  `\n\n---\n\n`. Same path resolution rules as `includes`. Paths must be unique.
- `template`: template path resolved through the overlay. Relative paths resolve
  from the templates directory; absolute and `~/` paths are allowed.

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
- one variable per include path exactly as listed, for example `{{_common.md}}`,
  `{{snippets/common.md}}`, or `{{~/agent/common.md}}`

`appends` entries are not available as template variables. They are read and
appended after the template is fully rendered, so they do not participate in
`{{variable}}` substitution.

Templates receive launch/self-claim context only. They do not receive task
bodies.

## Input hook and Envy customization

`agents.json` accepts an optional top-level `hooks` block. The only hook today
is `hooks.input`, which points pdx at a long-running executable that emits
NDJSON on stdout. Each valid line produces an `intake` task claimed by Envy.

```json
{
	"agents": [...],
	"hooks": {
		"input": { "command": ["/path/to/watcher", "--flag"] }
	}
}
```

`command` is an argv array — no shell evaluation. pdx supervises the process:
restarts on exit with exponential backoff, escalates after 5 crashes in 60s.

Each NDJSON line must have `title` (string) and `body` (string). pdx enqueues
the resulting intake task in global scope; all other fields are managed by pdx.

**Envy routing knowledge** belongs in user-owned Envy template overrides or
appends, commonly stored under `extensions/templates/envy/`. Reference those
files from an overridden `agents.json` as `envy/my-rules.md`, then use the
matching template variable `{{envy/my-rules.md}}` if it is an include.

## Safe editing checklist

1. Do not edit files in `<data-dir>/templates/` — they are read-only and will be
   overwritten on the next `pdx init` or `pdx open`. Edit in
   `<data-dir>/extensions/templates/` instead.
2. Keep `agents.json` valid JSON.
3. Keep every referenced `template`, `includes`, and `appends` path readable.
   Relative paths resolve from the templates directory; absolute paths and `~/`
   can point at files outside the data dir for workflows that keep prompt files
   in a separate version-controlled directory.
4. When using nested or external includes, reference them in templates with the
   exact manifest string, for example `{{snippets/common.md}}`.
5. Choose harness `kind`, `model`, and `tools` from the real harness CLI docs/help.
6. Do not remove required launch/self-claim instructions from prompts unless you
   are intentionally changing runtime behavior.
7. After edits, run a preview from the project if available, for example:

```sh
pandora-spawn preview \
  --agent war \
  --mode afk \
  --scope scope_repo \
  --run run_preview \
  --session-id 123e4567-e89b-12d3-a456-426614174000 \
  --cwd "$PWD"
```
