# Agent Configuration

**Status:** Planned
**Last Updated:** 2026-05-17

## 1. Overview

### Purpose

Agent configuration defines how Spawner renders Pandora's Box Agent prompts and Harness launch arguments while giving users a safe, discoverable place to edit those settings with a direct Agent session. The clean-break configuration model separates pdx-owned runtime data from user-owned config, uses TOML partials instead of whole-file JSON replacement, and resolves config by scope kind without relying on ephemeral worktree files.

### Goals

- Give users an obvious CWD for direct config-editing Agents with a tiny `AGENTS.md` pointer and installed `PANDORA.md` reference.
- Keep config-editing guidance out of `$PDX_DATA_DIR` root so supervised global Agents do not accidentally auto-read it.
- Let users keep global config outside the pdx runtime dir through `PDX_USER_DATA_DIR`, commonly for version control.
- Replace whole-file `agents.json` overrides with mergeable `agents.toml` partials to avoid drift after bundled template upgrades.
- Support scope-kind-specific defaults for `global`, `repo`, and `worktree` launches through a consistent `scopes/<kind>/` layout.
- Keep canonical bundled config reseeded and readable for upgrade comparison.
- Preserve fail-loud behavior for malformed config, unknown keys, missing referenced files, and invalid merge operations.

### Non-Goals

- No automatic semantic migration of old `extensions/templates` edits; this is a clean break.
- No arbitrary process-CWD discovery for config. Resolution uses pdx/Spawner launch context, not whichever shell directory started pdx.
- No hidden template merging. Template files remain whole-file assets; only `agents.toml` is merged.
- No worktree-local config requirement. Worktrees are often ephemeral; user `scopes/worktree` is the durable default place for worktree policy.
- No authorization policy in config. Pithos built-ins remain the durable source of Agent kinds, Capabilities, claims, and enqueues.

## 2. Design Decisions

- **Decision:** Introduce `PDX_USER_DATA_DIR` as the user-owned configuration root.
  - **Rationale:** `$PDX_DATA_DIR` is runtime state; users need an optionally version-controlled config location such as `~/.config/pdx`. Defaulting `PDX_USER_DATA_DIR` to `$PDX_DATA_DIR/config` keeps first-run discovery simple while still allowing full relocation through the environment.

- **Decision:** Place only a minimal bundle-owned `AGENTS.md` runtime note in `$PDX_DATA_DIR` root, and keep config-editing guidance in `$PDX_USER_DATA_DIR/PANDORA.md`.
  - **Rationale:** Supervised global Agents spawn with CWD at the pdx data dir. Harnesses commonly auto-read `AGENTS.md` from CWD, so any root-level file there must stay minimal and safe for runtime inspection rather than config editing.

- **Decision:** Use `agents.toml` everywhere instead of `agents.json`.
  - **Rationale:** JSON whole-file replacement forces users to copy the full bundled manifest and then manually track upstream changes. TOML supports comments and small partial files that express only intentional user deltas.

- **Decision:** Merge only the Agent manifest; do not merge template file contents.
  - **Rationale:** Prompt text merging is ambiguous and order-sensitive. Users can compose prompts through `includes` and `appends`; the files those paths name remain whole assets selected by the resolver.

- **Decision:** Scope-kind config lives under `scopes/<kind>/`, not a special top-level `global/` directory.
  - **Rationale:** `global/` alone makes Pandora configuration ambiguous. A complete `scopes/global`, `scopes/repo`, `scopes/worktree` family says the directory is scope-kind-specific, while root config remains user-wide defaults.

- **Decision:** Project-local `.pdx` is optional and skips `scopes/global`.
  - **Rationale:** Global scope has no project root. Repo-specific behavior belongs in a durable repo root's `.pdx`, while worktree roots are commonly disposable and should not affect prompt rendering through untracked local files.

- **Decision:** Worktree scope uses a durable parent repo config root, not `<worktree>/.pdx`.
  - **Rationale:** War commonly runs in disposable linked worktrees, but teams still need repo-owned execution policy. Pithos should model the durable parent repo for worktree scopes so Spawner can layer `<parent-repo>/.pdx` without inferring from the ephemeral worktree runtime path.

- **Decision:** Resolve configuration from launch scope context, not from the supervisor process CWD.
  - **Rationale:** pdx may run from its data dir while launching Agents for many scopes. Spawner must receive enough launch context to select deterministic config layers.

- **Decision:** Use `pandora-spawn preview` for config provenance in this phase.
  - **Rationale:** Preview already renders a single Agent plan from supplied launch context without mutating Pithos or starting a Harness. Adding resolved layer/file provenance there keeps scope smaller than introducing a new `pdx config inspect` command.

- **Decision:** `pdx init --nuke` must preserve `$PDX_USER_DATA_DIR`, including the default nested `$PDX_DATA_DIR/config` path.
  - **Rationale:** If the default user config path is `$PDX_DATA_DIR/config`, a literal `rm -rf $PDX_DATA_DIR` would destroy user-owned config. Clean-break ownership requires a precise destructive-operation contract rather than a broad recursive delete.

## 3. Directory Model

### Bundled canonical config

`$PDX_DATA_DIR` remains pdx-owned runtime state. On `pdx init` and `pdx open`, pdx reseeds canonical bundled config here:

```text
$PDX_DATA_DIR/
  agents.toml        # canonical complete Agent render manifest, read-only/reseeded
  templates/         # canonical bundled prompt files, read-only/reseeded
  pithos.sqlite
  pdx.sock
  pdx.jsonl
  runs/
```

The data dir root contains only a minimal bundle-owned `AGENTS.md` runtime note and no `CLAUDE.md`.

### User-owned config

`PDX_USER_DATA_DIR` is parsed from the environment. When unset, it defaults to `$PDX_DATA_DIR/config`.

Path validation is part of config parsing:

- the resolved user data dir must not equal `$PDX_DATA_DIR`
- the resolved user data dir must not be an ancestor of `$PDX_DATA_DIR`
- an explicit `PDX_USER_DATA_DIR` inside `$PDX_DATA_DIR` is valid only when it resolves to `$PDX_DATA_DIR/config`
- outside `$PDX_DATA_DIR`, any absolute or `~/` user data dir is allowed

Invalid path relationships fail loudly before scaffolding or launch. This prevents config-editing `AGENTS.md` from landing in a CWD used by supervised global Agents.

```text
$PDX_USER_DATA_DIR/
  AGENTS.md          # tiny direct-agent pointer scaffolded once
  CLAUDE.md          # Claude direct-agent pointer scaffolded once
  agents.toml        # user-wide partial manifest scaffolded once
  PANDORA.md         # installed config reference, re-seeded on init/open
  templates/         # optional user-wide prompt/include/append files
  scopes/
    global/
      agents.toml    # optional global-scope partial manifest
      templates/
    repo/
      agents.toml    # optional repo-scope partial manifest
      templates/
    worktree/
      agents.toml    # optional worktree-scope partial manifest
      templates/
```

Users can run a direct Agent from this directory:

```sh
cd "$PDX_USER_DATA_DIR"
claude   # or pi / another configured Harness
```

`AGENTS.md` tells that Agent to read `PANDORA.md` for the real reference. `PANDORA.md` explains:

- canonical bundled config lives at `$PDX_DATA_DIR/agents.toml` and `$PDX_DATA_DIR/templates`
- the data-dir root `AGENTS.md` is runtime guidance, not a customization surface
- user config lives in the current `$PDX_USER_DATA_DIR`
- scope-kind overrides live under `scopes/<global|repo|worktree>`
- do not edit `$PDX_DATA_DIR` canonical files
- compare user partials with canonical config after upgrades
- validate changes with `pandora-spawn preview`

### Project-local config

Repo scopes carry project-local config at the repo scope runtime path. Worktree scopes carry project-local config at their required recorded parent repo root:

```text
<repo-root>/.pdx/
  AGENTS.md          # optional guide for direct project config editing
  README.md          # optional project-local notes
  agents.toml        # optional project-wide partial manifest
  templates/         # optional project-wide prompt files
  scopes/
    repo/
      agents.toml
      templates/
    worktree/
      agents.toml
      templates/
```

`<repo-root>/.pdx/scopes/global` is invalid. A launch that selects project-local `.pdx` validates the project config root and fails loudly if unsupported `scopes/global` is present.

Project-local config is eligible for repo scope launches and for all worktree scope launches through their required recorded parent repo root. Global scope never consults a project `.pdx` directory. Worktree scope never consults `<worktree-root>/.pdx` directly. Legacy worktree scopes without parent repo metadata must be migrated or fail before launch.

### Lifecycle ownership

`$PDX_USER_DATA_DIR` is user-owned. pdx may create scaffold files there when the directory is missing, but it must not overwrite existing user files.

`pdx init --clean` removes runtime state only: the Pithos DB, runs directory, supervisor log, and socket if present. It preserves `$PDX_USER_DATA_DIR`, `$PDX_DATA_DIR/agents.toml`, and `$PDX_DATA_DIR/templates/`.

When this planned spec is implemented, it supersedes the current `--nuke` lifecycle contract in `control-plane-supervision.md`. `pdx init --nuke` removes pdx-owned runtime and canonical bundle state while preserving `$PDX_USER_DATA_DIR`:

- if `$PDX_USER_DATA_DIR` resolves outside `$PDX_DATA_DIR`, pdx may remove and recreate `$PDX_DATA_DIR`
- if `$PDX_USER_DATA_DIR` resolves to `$PDX_DATA_DIR/config`, pdx deletes every immediate child of `$PDX_DATA_DIR` except `config`
- pdx must not follow symlinks while deleting data-dir children
- explicit nested user dirs other than `$PDX_DATA_DIR/config` are invalid at config-parse time
- if path normalization cannot prove one of the valid relationships above, `--nuke` fails before deleting anything

After deletion, init reseeds `$PDX_DATA_DIR/agents.toml` and `$PDX_DATA_DIR/templates/`, initializes Pithos, recreates runtime directories, and leaves existing user config untouched.

## 4. Resolution Model

Spawner builds an ordered list of config layers for each launch. Layers are applied from lowest priority to highest priority.

### Global scope

```text
1. $PDX_DATA_DIR
2. $PDX_USER_DATA_DIR
3. $PDX_USER_DATA_DIR/scopes/global
```

### Repo scope

```text
1. $PDX_DATA_DIR
2. $PDX_USER_DATA_DIR
3. $PDX_USER_DATA_DIR/scopes/repo
4. <scope-root>/.pdx
5. <scope-root>/.pdx/scopes/repo
```

### Worktree scope

```text
1. $PDX_DATA_DIR
2. $PDX_USER_DATA_DIR
3. $PDX_USER_DATA_DIR/scopes/worktree
4. <parent-repo-root>/.pdx
5. <parent-repo-root>/.pdx/scopes/worktree
```

`<scope-root>` is the runtime path recorded on the Pithos worktree Scope / Agent Run and is used as the Agent launch CWD, but it is not used for config discovery. `<parent-repo-root>` is required durable scope metadata recorded when the worktree scope is created. Missing, unnormalizable, or non-existent parent repo metadata is a validation/launch-precondition failure; Spawner must not silently fall back to user-only worktree config. If the scope root is missing, pdx already treats the work as a launch-precondition repair case before Spawner renders.

### Manifest resolution

For every eligible layer, Spawner reads `agents.toml` if present. Missing `agents.toml` files are skipped. The canonical `$PDX_DATA_DIR/agents.toml` must exist and must resolve to complete Agent render config after all layers are merged.

`hooks.input` is singleton supervisor configuration, not per-launch Agent configuration. pdx resolves hooks only through the global layer order (`$PDX_DATA_DIR`, `$PDX_USER_DATA_DIR`, `$PDX_USER_DATA_DIR/scopes/global`). `hooks.input` is invalid in project-local `.pdx`, `scopes/repo`, or `scopes/worktree` manifests.

### Template path resolution

Template references from the resolved manifest use the same layer order, highest priority first:

1. if the reference is absolute or `~/...`, read that exact path and do not use layer fallback
2. otherwise, search each eligible layer's `templates/<reference>` from highest priority to lowest
3. if no layer contains the file, fail render loudly

Template references are overlay keys, not source-relative imports. A higher-priority `templates/<reference>` file intentionally overrides that reference even when a lower-priority manifest layer introduced the path. Preview/provenance output must show the final file path used for each reference so shadowing is visible.

User-wide worktree defaults can override `agents/war.md` for all worktree launches by providing `$PDX_USER_DATA_DIR/scopes/worktree/templates/agents/war.md`. Repo-owned worktree policy can override it for a repo's worktrees through `<parent-repo-root>/.pdx/scopes/worktree/templates/agents/war.md`.

## 5. `agents.toml` Contract

`agents.toml` is render configuration, not durable authorization truth. Pithos built-ins define which Agent kinds exist and what they may claim/enqueue.

### Shape

The canonical manifest must define complete config for every spawnable Agent kind. User, scope, and project manifests may define partial tables.

```toml
[agents.war]
template = "agents/war.md"
includes.replace = ["common/base.md", "common/afk.md"]
appends.replace = []

[agents.war.harness]
kind = "pi"
model = "openai-codex/gpt-5.4"
system_prompt_mode = "append"
tools.replace = ["bash", "read"]
argv.replace = []

[agents.pandora]
appends.add = ["pandora-local.md"]

[hooks.input]
command = ["/Users/me/bin/pdx-inbox-watch"]
```

Allowed top-level tables:

- `agents.<agent-kind>` — partial render config for a built-in spawnable Agent
- `hooks.input` — optional input hook command config

Unknown top-level keys, unknown Agent kinds, and unknown fields fail validation.

### Merge semantics

Tables merge recursively by field. A higher-priority table does not replace an entire lower-priority object merely by existing; only the fields present in that table participate in the merge.

Scalar fields replace lower-priority values when present:

- `agents.<kind>.template`
- `agents.<kind>.harness.kind`
- `agents.<kind>.harness.model`
- `agents.<kind>.harness.system_prompt_mode`
- `hooks.input.enabled`
- `hooks.input.command`

A scalar may also reset to the canonical bundled value with `default = true` using the scalar field as a dotted table:

```toml
[agents.war.harness]
model.default = true

[agents.war]
template.default = true
```

`default = true` is mutually exclusive with setting the scalar value in the same layer. It ignores all non-bundled lower-priority overrides for that field and restores the canonical bundled state from `$PDX_DATA_DIR/agents.toml`. If the canonical manifest omits an optional scalar, reset restores that absence; if the final resolved config then lacks a required scalar, resolved-config validation fails. This lets a narrower scope undo a user-wide scalar override without copying the bundled value and drifting after upgrades.

For the path-like `agents.<kind>.template` scalar, `template.default = true` also pins asset resolution to the canonical bundled template file for that Agent. It does not continue searching higher-priority user/project `resources/` directories for the restored canonical path.

`mode` is not configurable in `agents.toml`; pdx/Pithos launch policy supplies the mode for each Agent kind.

### List fields

List fields use explicit operations:

- `replace = [...]` — replace the current list
- `remove = [...]` — remove items from the current list
- `add = [...]` — append items to the current list

Supported list fields:

- `agents.<kind>.includes`
- `agents.<kind>.appends`
- `agents.<kind>.harness.tools`
- `agents.<kind>.harness.argv`

Within one layer and field:

- `replace` may not be combined with `add` or `remove`
- `add` and `remove` may coexist
- when `add` and `remove` coexist, `remove` applies first, then `add`
- duplicate items inside one operation fail validation, except for `harness.argv`

Across layers, operations apply in layer order. For unique-list fields, `remove` of an absent item fails loudly because it usually means bundled config changed and the user partial needs review; `add` of an already-present item also fails loudly. Unique-list fields are `includes`, `appends`, and `harness.tools`.

`harness.argv` preserves verbatim argv behavior. It supports `replace` and `add`, does not support `remove`, and allows duplicate tokens.

### Hook merge semantics

`hooks.input.enabled` is an optional boolean. `hooks.input.command` is an optional non-empty argv array. Both merge field-by-field using scalar replacement.

Final hook state:

- if no final `command` exists, the hook is disabled regardless of `enabled`
- if a final `command` exists and no layer set `enabled`, the hook is enabled
- if a final `command` exists and the highest-priority `enabled` value is `true`, the hook is enabled
- if a final `command` exists and the highest-priority `enabled` value is `false`, the hook is disabled

A layer may set both `enabled = true` and `command = [...]`. A layer may not set `enabled = false` and `command = [...]` together. To re-enable a hook disabled by a lower-priority layer, a higher-priority layer must set `enabled = true`.

## 6. Upgrade and Direct-Agent UX

A typical upgrade review flow is:

```sh
cd "$PDX_USER_DATA_DIR"
claude
# Ask: "I updated Pandora's Box. Compare my agents.toml/templates with
# $PDX_DATA_DIR/agents.toml and $PDX_DATA_DIR/templates. Am I missing important behavior?"
```

Because user config is partial TOML, the direct Agent can focus on intentional deltas rather than diffing copied full manifests. It can inspect canonical bundled config through `$PDX_DATA_DIR` and edit only `$PDX_USER_DATA_DIR` or project `.pdx` files.

The scaffolded `AGENTS.md` and `CLAUDE.md` are tiny pointers to `PANDORA.md`; the installed `PANDORA.md` carries concise examples and direct-editing guidance.

## 7. Implementation Phases

### Phase 1: Config paths and TOML parser

- [ ] Add `PDX_USER_DATA_DIR` parsing to pdx and Spawner config services.
- [ ] Change bundled materialization from the legacy bundled `agents.json` to `$PDX_DATA_DIR/agents.toml` plus `$PDX_DATA_DIR/templates/`.
- [ ] Add TOML parsing dependency or implementation at the Spawner IO boundary.
- [ ] Define schemas for partial `agents.toml`, list operations, hooks, and resolved complete Agent config.

### Phase 2: Layer resolver

- [ ] Replace the current two-layer extensions/templates resolver with ordered config layers.
- [ ] Select layers from launch scope kind; use scope root for repo project-local config and required recorded parent repo root for worktree project-local config.
- [ ] Merge all present `agents.toml` files in layer order, including scalar canonical reset operations.
- [ ] Resolve template references through each layer's `templates/` directory in reverse priority order.
- [ ] Keep absolute and `~/` references as direct paths outside layer fallback.

### Phase 3: User config scaffolding and lifecycle

- [ ] On `pdx init`, create `$PDX_USER_DATA_DIR` if missing; scaffold `AGENTS.md`, `CLAUDE.md`, and `agents.toml` once; and re-seed installed `PANDORA.md`, not full copied overrides.
- [ ] Validate `PDX_USER_DATA_DIR` path relationships before scaffolding, launch, clean, or nuke.
- [ ] Extend Pithos/pdx worktree scope creation to record a durable parent repo root for config layering, and fail/migrate existing worktree scopes that lack it before launch.
- [ ] Preserve `$PDX_USER_DATA_DIR` during `--clean` and `--nuke`, including the default nested path.
- [ ] Update `specs/control-plane-supervision.md` so `--nuke` no longer claims to delete the full data dir unconditionally.
- [ ] Remove or replace docs that refer to `extensions/templates` and `agents.json`.
- [ ] Update `resources/user-data-dir/AGENTS.md` guidance into the new user config scaffold.

### Phase 4: Validation and diagnostics

- [ ] Update `pandora-spawn preview` to render with the new layer model.
- [ ] Include resolved config provenance in `pandora-spawn preview` output so users can see which layer set each Agent field and template file.
- [ ] Add tests for layer order, TOML merge semantics, explicit list operations, hook disable behavior, and missing template failures.
- [ ] Add smoke-test coverage for `PDX_USER_DATA_DIR` inside and outside `$PDX_DATA_DIR`.

### Phase 5: Clean-break removal

- [ ] Remove `extensions/templates` lookup.
- [ ] Remove `agents.json` schema and docs.
- [ ] Update package READMEs, `resources/README.md`, and the user-facing root README configuration section.

## 8. Code Locations

| File / Directory                       | Planned change                                                                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `packages/spawner/src/paths.ts`        | Resolve data, user, scope, parent repo, and project config roots.                                          |
| `packages/spawner/src/spawner.ts`      | Parse/merge `agents.toml`, select layers, resolve template refs.                                           |
| `packages/spawner/src/services.ts`     | Expose env and filesystem operations needed for TOML config discovery.                                     |
| `packages/spawner/src/main.ts`         | Preview output and help/docs for new config model.                                                         |
| `packages/spawner/src/spawner.test.ts` | Layering, merge, validation, preview tests.                                                                |
| `packages/pdx/src/config.ts`           | Parse `PDX_USER_DATA_DIR` / derived default.                                                               |
| `packages/pdx/src/live.ts`             | Materialize canonical config and scaffold user config.                                                     |
| `packages/pdx/src/controller.ts`       | Preserve user config during clean/nuke and pass scope/parent-repo context to Spawner.                      |
| `packages/pithos/src/`                 | Store/inspect required parent repo metadata for worktree scopes; migrate or fail legacy scopes missing it. |
| `packages/pdx/README.md`               | Document runtime vs user config paths.                                                                     |
| `packages/spawner/README.md`           | Document TOML manifest and resolver boundary.                                                              |
| `resources/`                           | Move bundled manifest to TOML and remove config-editing `AGENTS.md` from data-dir root materialization.    |
| `README.md`                            | Update user configuration instructions.                                                                    |

## 9. Validation Strategy

Automated tests should cover user-visible and invariant-bearing behavior:

- Config path parsing: env override, default `$PDX_DATA_DIR/config`, outside-data-dir path, and invalid equal/ancestor/unsupported nested paths.
- Layer selection for global, repo, and worktree scopes.
- Project `.pdx` used for repo scope and for worktree scopes with valid recorded parent repo roots; missing/invalid worktree parent metadata fails loudly; project `.pdx` is ignored for global scope and never read from the worktree root itself.
- TOML validation failures: unknown fields, unknown agents, malformed list ops, duplicate final unique lists, removing absent values, and `hooks.input` in non-global layers.
- Merge behavior: recursive table merge, scalar replacement, scalar canonical reset including optional absence and template asset pinning, list replace/add/remove across multiple layers, argv duplicate handling, hook replacement/disable/re-enable.
- Template resolution priority and direct absolute/`~/` path behavior.
- Lifecycle preservation of `$PDX_USER_DATA_DIR` during `--clean` and `--nuke`, including the exact nested-default deletion algorithm.
- `pandora-spawn preview` output showing enough provenance to debug which layer won.

Manual smoke validation should use isolated `PDX_DATA_DIR`, `PDX_USER_DATA_DIR`, `PITHOS_DB`, and `TMUX_TMPDIR` as described in `AGENTS.md`.

## 10. Open Questions

None.
