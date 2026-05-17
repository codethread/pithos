# Agent Command Reference Rendering

**Status:** Implemented
**Last Updated:** 2026-05-16

## 1. Overview

### Purpose

Spawner renders generated Markdown command references into Agent prompts through the `{{command_cards}}` template variable. This gives Pandora, Envy, Toil, Greed, and War a concise, role-filtered command surface sourced from real CLI metadata instead of stale prompt prose or human-oriented help text.

### Goals

- Source command syntax from `pithos --help-json` and selected `pdx --help-json` metadata.
- Render compact Markdown optimized for Agent use.
- Filter commands by Agent kind and validate every configured path during render.
- Keep workflow judgment in templates while generated cards cover command syntax and stable command-specific notes.
- Fail loudly when help JSON is malformed, a configured command path disappears, or an annotation references an unknown command.

### Non-Goals

- No replacement for role templates or `_common.md` workflow policy.
- No raw help JSON injection into prompts.
- No dependency on human `--help` formatting.
- No authorization policy in templates; Pithos built-ins own claim/enqueue truth.
- No generic documentation site.

## 2. Design Decisions

- **Decision:** Keep the `{{command_cards}}` variable name while rendering Markdown.
  - **Rationale:** Templates already use the variable; the implemented contract changes its content from raw JSON to prose/reference content.

- **Decision:** Use structured CLI metadata as the command source.
  - **Rationale:** Generated references drift less than hand-maintained prompt snippets and fail render when command paths disappear.

- **Decision:** Keep generated command reference separate from workflow policy.
  - **Rationale:** CLI metadata can describe flags and subcommands, but templates must explain when to escalate, supersede, cancel, or route work.

- **Decision:** Validate annotations against the generated command tree.
  - **Rationale:** Agent-facing notes are useful only if they are tied to commands that still exist.

- **Decision:** Render readable Markdown rather than complete JSON.
  - **Rationale:** Agents need a scannable prompt reference: command path, usage, purpose, and a few high-value notes.

## 3. Render Flow

```text
Spawner.renderAgent
  -> load agents.json and templates through the data-dir overlay
  -> call pithos --help-json
  -> call pdx --help-json for Pandora-only pdx inspection commands
  -> parse and validate command trees
  -> validate role filters and annotations
  -> render filtered Markdown
  -> inject as {{command_cards}}
```

Templates receive launch/self-claim context only. They do not receive Task bodies.

## 4. Role Filters

| Agent kind | Pithos command paths                                                              | pdx command paths                                     |
| ---------- | --------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `war`      | `pithos task`                                                                     | none                                                  |
| `envy`     | `pithos scope`, `pithos task`                                                     | none                                                  |
| `toil`     | `pithos scope`, `pithos task`                                                     | none                                                  |
| `greed`    | `pithos scope`, `pithos task`                                                     | none                                                  |
| `pandora`  | `pithos scope`, `pithos task`, `pithos graph`, `pithos events`, `pithos briefing` | `pdx run transcript`, `pdx run show`, `pdx task show` |

Pandora does not receive `pdx daemon status` or `pdx daemon logs` through default command cards even though those commands are public operator commands; templates may still teach when to use them.

## 5. Rendered Shape

Generated content starts with a short provenance note, then groups leaf commands by tool. Each command includes full path, description, usage, and compact notes/examples when annotations exist.

Example shape:

````md
## Generated command reference

This reference is generated from CLI metadata. Use the rendered claim command above for the exact claim invocation for this run.

### Pithos

#### `pithos task inspect`

Show an agent-readable task handoff; pass `--json` for structured metadata.

Usage:

```sh
pithos task inspect [--json] <task-id>
```
````

Notes:

- Default output is readable Markdown and should be your normal context.
- Use `--json` only for exact fields, scripting, or token recovery.

```

Pandora's `pithos graph inspect` annotations summarize the implemented graph contract: graph inspect is for inventory/provenance/audit, briefing is for ready/blocked agenda, filters narrow seeds before closure, readable output is normal, JSON is for exact fields/source edges, and scope graph views avoid reverse `repair_source` expansion into global Repair Alerts.

## 6. Template and Preview Interface

`{{command_cards}}` is the supported variable. Its rendered content is generated Markdown, not raw JSON. `{{command_reference}}` is not supported.

`pandora-spawn preview` returns a JSON `RenderedAgent`; the `prompt` field is the manual verification surface for command-card output. Preview validates manifest/templates/help metadata but does not mutate Pithos, create Runs, touch tmux, or launch a Harness.

## 7. Code Locations and Tests

- `packages/spawner/src/spawner.ts` — command tree parsing, role filters, annotations, Markdown rendering
- `packages/spawner/src/spawner.test.ts` — role filtering, raw-JSON regression coverage, annotation validation
- `templates/README.md` — template variable and extension contract
- `packages/pithos/src/cli.ts` — Pithos help JSON source
- `packages/pdx/src/main.ts` — pdx help JSON source
```
