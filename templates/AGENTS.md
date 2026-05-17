# pdx user config agent guide

This file is scaffolded into `<user-data-dir>/AGENTS.md` by `pdx init` / `pdx open`.
Work from the user config directory, not from `<data-dir>`.

## Ownership model

- `<data-dir>/agents.toml` and `<data-dir>/templates/` are bundle-owned canonicals.
  They are read-only and re-seeded on every `pdx init` / `pdx open`.
- `<user-data-dir>/` is user-owned. Edit config here.
- Project-local overrides live in `<repo-root>/.pdx/`.

If you need to compare current user config with bundled defaults, inspect:

- `<data-dir>/agents.toml`
- `<data-dir>/templates/`

## Common files

- `agents.toml` — optional user-wide manifest partial
- `templates/` — optional user-wide prompt assets
- `scopes/global/agents.toml` — global-scope partial
- `scopes/repo/agents.toml` — repo-scope partial
- `scopes/worktree/agents.toml` — worktree-scope partial

Project-local `.pdx/` may also contain its own `agents.toml`, `templates/`, and
`scopes/repo|worktree/` overrides.

## `agents.toml` shape

Bundled canonical config looks like:

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

User and project files are partials. Change only the fields you intend to
override.

### Scalars

These replace lower-priority values when present:

- `agents.<kind>.template`
- `agents.<kind>.harness.kind`
- `agents.<kind>.harness.model`
- `agents.<kind>.harness.system_prompt_mode`
- `hooks.input.enabled`
- `hooks.input.command`

A scalar can also reset to the bundled canonical value with `default = true`:

```toml
[agents.war.harness]
model.default = true
```

### Lists

Use explicit list operations:

```toml
[agents.war.includes]
add = ["war/local-rules.md"]

[agents.war.harness.tools]
add = ["edit", "write"]
```

Supported list fields:

- `agents.<kind>.includes`
- `agents.<kind>.appends`
- `agents.<kind>.harness.tools`
- `agents.<kind>.harness.argv`

`includes`, `appends`, and `tools` are unique lists. `argv` allows duplicates and
supports `replace` / `add` only.

## Template assets

Manifest references such as `war.md` or `_common.md` resolve through the eligible
layer stack from highest priority to lowest:

1. project-local scope layer
2. project-local `.pdx`
3. user scope-kind layer
4. user-wide layer
5. bundled canonical layer

Files are not merged. The first matching `templates/<reference>` wins.
Absolute and `~/...` paths bypass layer fallback.

## Hooks

Input hooks are configured in TOML:

```toml
[hooks.input]
command = ["/path/to/watcher", "--flag"]
```

Hook config belongs only in global layers, not repo/worktree project layers.

## Safe editing checklist

1. Do not edit `<data-dir>/agents.toml` or `<data-dir>/templates/`.
2. Keep `agents.toml` valid TOML.
3. Keep every referenced template/include/append path readable.
4. Prefer small partial overrides over copying bundled canonicals.
5. Validate changes with preview.

```sh
pandora-spawn preview \
  --agent war \
  --mode afk \
  --scope repo:$PWD \
  --run run_preview \
  --session-id 123e4567-e89b-12d3-a456-426614174000 \
  --cwd "$PWD"
```
