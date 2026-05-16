# Agent Command Reference Rendering

**Status:** Implemented
**Last Updated:** 2026-05-16

## 1. Overview

### Purpose

Spawner renders command guidance into Agent prompts so Pandora, Toil, Greed, War, and Envy can operate Pithos/pdx reliably without depending on the human-oriented `--help` output. The `{{command_cards}}` mechanism keeps that dynamic, role-filtered prompt surface and renders concise agent-oriented Markdown reference generated from structured CLI metadata.

This spec supersedes the raw-JSON command-card portions of older control-plane drafts. The implemented contract is also summarized in [`control-plane-supervision.md`](./control-plane-supervision.md).

### Goals

- Preserve the original command-card goal: agents should not need to parse the human `--help` output for routine work.
- Keep command syntax sourced from the real CLI command tree, not duplicated manually in prompt templates.
- Render command references as compact Markdown optimized for agent use.
- Keep role filtering: each Agent kind sees only commands relevant to its responsibilities.
- Fail loudly when configured command paths disappear, help JSON is malformed, or annotation metadata references unknown commands.
- Keep hand-authored templates responsible for workflow policy, examples, and domain judgment.
- Allow human `--help` to improve independently without coupling terminal UX to prompt UX.

### Non-Goals

- Replacing `_common.md` recipes or role-specific prompt policy.
- Making agents run `pithos --help` / `pdx --help` as the primary command-discovery path.
- Injecting full CLI help into every prompt.
- Building a generic documentation site or replacing package READMEs/specs.
- Encoding authorization policy in templates; Pithos built-ins remain the source of claim/enqueue truth.
- Maintaining both raw-JSON and Markdown command-card formats long-term.

## 2. Design Decisions

- **Decision:** Keep `{{command_cards}}` as the template variable, but change its rendered content from raw JSON to Markdown.
  - **Rationale:** Existing bundled templates already depend on this variable. The problem is presentation, not the injection point. Keeping the variable avoids churn in bundled templates while improving agent comprehension. This is still a pre-v1 template-contract break for any user extension that parsed the old raw JSON; migration guidance should say `{{command_cards}}` is prose/reference content, not a stable JSON API.

- **Decision:** Keep `--help-json` as the structural source of command syntax.
  - **Rationale:** It preserves drift resistance and fail-loud validation. Manually maintaining command syntax in prompts would recreate the stale-doc problem the cards were meant to avoid.

- **Decision:** Do not use human `--help` output as the agent prompt source.
  - **Rationale:** The cards exist because agents were confused by that output. Human terminal help and agent prompt reference are different products with different formatting constraints.

- **Decision:** Separate generated syntax/reference from hand-authored workflow policy.
  - **Rationale:** CLI metadata can say a command exists and what flags it accepts. It cannot reliably express when War should escalate instead of enqueueing follow-up work, or when Pandora should supersede versus replan. Those semantics belong in `_common.md` and role templates.

- **Decision:** Add an optional annotation layer keyed by command path.
  - **Rationale:** Some agent-facing notes are stable but not part of terminal help, such as “use quoted heredocs with `--stdin`” or “use readable inspect output by default.” Keying annotations by command path lets Spawner validate them against the generated tree.

- **Decision:** Keep role filters in Spawner configuration/code, not in templates.
  - **Rationale:** Filtering is part of the render contract and should fail during preview/render if a command path disappears. Templates should ask for `{{command_cards}}`, not reconstruct command sets.

- **Decision:** Agent cards should be concise and action-oriented.
  - **Rationale:** Raw JSON is complete but hard to scan. Agents need command path, usage, purpose, and a small number of role-relevant notes/examples.

- **Decision:** Human help improvements may share the command model but not necessarily the renderer.
  - **Rationale:** Human help should optimize terminal scanability. Agent cards should optimize prompt reliability. Sharing metadata is useful; forcing identical output would compromise one audience.

## 3. Architecture

### Render flow

```text
Spawner.renderAgent
  -> load agents.json + templates
  -> call pithos --help-json
  -> call pdx --help-json for Pandora
  -> parse command trees into CommandHelpTree
  -> validate configured role command paths exist
  -> validate command annotations reference existing paths
  -> filter by Agent kind
  -> render filtered trees as Markdown command reference
  -> inject Markdown into {{command_cards}}
```

### Role-filtered command sets

Keep the existing code-level filtering policy unless a later implementation has evidence to narrow it further. This table supersedes the older raw-JSON filter prose in `control-plane-supervision.md`:

| Agent kind | Pithos command paths                                                              | pdx command paths                                     |
| ---------- | --------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `war`      | `pithos task`                                                                     | none                                                  |
| `toil`     | `pithos scope`, `pithos task`                                                     | none                                                  |
| `greed`    | `pithos scope`, `pithos task`                                                     | none                                                  |
| `envy`     | `pithos scope`, `pithos task`                                                     | none                                                  |
| `pandora`  | `pithos scope`, `pithos task`, `pithos graph`, `pithos events`, `pithos briefing` | `pdx run transcript`, `pdx run show`, `pdx task show` |

### Render shape

Generated content should be Markdown, not JSON. Example excerpt, showing Pandora-only `pithos graph inspect` guidance:

````md
## Generated command reference

This reference is generated from CLI metadata. Use the rendered claim command above for the exact claim invocation for this run.

### Pithos

#### `pithos task claim`

Claim one claimable task for a run and return its fencing token.

Usage:

```sh
pithos task claim [--run text] --scope text --capability triage | design | execute | escalate | intake
```

Notes:

- Use the rendered claim command above instead of reconstructing this by hand.

#### `pithos task inspect`

Show an agent-readable task handoff; pass `--json` for structured metadata.

Usage:

```sh
pithos task inspect [--json] <task-id>
```

Notes:

- Default output is readable Markdown and should be your normal context.
- Use `--json` only for exact fields, scripting, or token recovery.

#### `pithos graph inspect`

Render a readable dependency/source/supersession graph for Pandora sitrep and audit.

Usage:

```sh
pithos graph inspect [--task text] [--scope text] [--all] --status text... --search text... [--since text] [--json]
```

Notes:

- Use `pithos briefing --agent pandora` for agenda questions like what is ready or blocked.
- Use graph inspect for inventory, dependency shape, provenance, and task ids to inspect next.
- Prefer readable output; use `--json` when source-edge details or exact graph fields matter.
````

For nested commands, render leaf commands by full path. Parent commands may appear as section headings when useful, but parent-only entries should not dominate the prompt.

## 4. Data Model

No database schema changes.

### Command model

Spawner can continue using the existing parsed help tree shape:

```ts
interface CommandHelpCard {
	readonly tool: string;
	readonly name: string;
	readonly path: string;
	readonly usage: string;
	readonly description: string;
	readonly subcommands: readonly CommandHelpCard[];
}
```

The renderer should normalize pdx and Pithos help JSON into this shared shape before filtering/rendering. Extra fields in pdx help JSON remain ignored unless intentionally adopted.

### Annotation model

Annotations are optional render metadata, keyed by full command path:

```ts
interface CommandAnnotation {
	readonly notes?: readonly string[];
	readonly examples?: readonly CommandExample[];
}

interface CommandExample {
	readonly title: string;
	readonly command: string;
}
```

Annotation constraints:

- Every annotation key must match a command path in the generated help tree.
- Examples must be short and use placeholders, not real task IDs.
- Examples must not duplicate the exact recipes already present in `_common.md` unless they add command-specific flag clarity.
- Annotation validation failure is a template/render error.

Pandora graph-inspection annotations are required because graph views are central to sitrep and repair work. The `pithos graph inspect` annotation should summarize the implemented contract from [`task-graph.md`](./task-graph.md):

- `pithos briefing --agent pandora` owns agenda-style ready/blocked summaries; graph inspect owns graph inventory, audit, provenance, and drill-down ids.
- `--task`, `--scope`, and `--all` are mutually exclusive selectors.
- `--status` is repeatable OR; `--search` is repeatable AND over task title/body; `--since` accepts `today`, `<n>h`, `<n>d`, `YYYY-MM-DD`, and ISO timestamps with timezone.
- Filters narrow seed selection before closure; closure may include related tasks that do not match filters so blockers, provenance, and supersessions remain understandable.
- Readable output is the normal agent surface; `--json` is for source edges, exact fields, and scripting.
- Scope graph views intentionally do not pull global Repair Alerts into repo/worktree views through reverse `repair_source` closure; inspect a named task or use `--all` when Pandora needs that provenance.

## 5. Interfaces

### Template interface

`{{command_cards}}` remains available and renders Markdown. Templates do not receive raw help JSON by default.

`templates/README.md` and `templates/AGENTS.md` should state explicitly: `{{command_cards}}` is the variable name, and its rendered content is a generated Markdown command reference. They should not imply that `{{command_reference}}` is a supported variable unless that variable is actually added.

### Preview interface

`pandora-spawn preview` should continue to output JSON `RenderedAgent`. The `prompt` field inside that JSON is the primary manual verification surface for the generated command reference.

### CLI help interfaces

`pithos --help-json` and `pdx --help-json` remain machine-readable render inputs.

Human `pithos --help` and `pdx --help` can be improved independently. Agents may still be told to run group-specific help for rare flag details, but the prompt-rendered reference remains the primary path for routine work.

## 6. Implementation Status

Implemented:

- Bundled templates render for every built-in Agent kind, including guard includes such as `{{shared/repo-default-branch-guard.md}}` and `{{war/cwd-guard.md}}` where referenced by the manifest.
- Spawner renders filtered `CommandHelpCard` trees as concise Markdown for `{{command_cards}}` instead of raw JSON.
- Existing role filters and missing-command fail-loud checks remain in Spawner.
- Tests prove War, Toil/Greed/Envy, and Pandora receive expected command paths and no raw help JSON prompt blocks.
- Built-in annotations render compact notes for high-value commands and fail loudly if an annotation path is missing from generated help.
- Pandora graph-inspection annotations carry the implemented `task-graph.md` contract for briefing-vs-graph usage, selectors, filters, seed-before-closure behavior, readable-vs-JSON usage, and the `repair_source` scope-graph exception.

Still separate from this implemented feature:

- Human `pithos --help` and `pdx --help` readability improvements are intentionally separate work. They may reuse structured command metadata, but agent command references and terminal help remain different product surfaces.
