# Pandora-Spawn spec

**Status:** Planned
**Last Updated:** 2026-05-03
**Package:** `@pithos/spawner`
**Bin:** `pandora-spawn`
**Workspace path:** `packages/spawner`

## 1. Purpose

Pandora-Spawn is a tiny CLI that turns a versioned agent template into a
running agent session. It owns templates, manifest config, launcher command
recipes, render context, and the harness adapter that builds the `claude` argv.

Pithos handles state (queue, leases, events, artifacts, briefing).
Pandora-Spawn handles agent orchestration. The two communicate only via the
`pithos` CLI subprocess, never via shared DB code.

## 2. Quality bar (non-negotiable)

**This package is intentionally less robust than `@pithos/cli`.**

- No Effect-heavy plumbing required. Plain TypeScript + a few small modules.
- No tagged-error hierarchy required. Throw with a clear message; the wrapper
  prints it; the user re-runs.
- Minimal tests. **One Vitest snapshot smoke test** that exercises
  `pandora-spawn --agent envy --scope ... --harness fake` and asserts the
  rendered prompt + composed argv match a stored snapshot. That is enough
  to verify templates render and the claude harness adapter wires correctly.
- Hooks are not tested. They are 12 lines of bash and a manual spawn proves
  they fire.
- Lint/typecheck still apply (pnpm workspace baseline). No `any`. Beyond
  that, prefer the smallest correct code.

If you find yourself adding service tags, layers, schemas for in-process
data, or speculative abstractions, stop. This is glue.

## 3. Non-goals

- No DB access, no SQLite import.
- No daemon, no auto-spawn loops, no scheduling.
- No template language with conditionals/loops. A `{{var}}` replacer is enough.
- No multi-harness routing in MVP — claude only, fake for tests. The
  harness module is shaped to accept other adapters later, not now.
- No separate tmux/zellij/remote adapter package. Launcher details live in
  source-controlled manifest config until at least two real adapters prove a
  package boundary is needed.
- No publishing to npm. Workspace bin only.

## 4. Package layout

```text
packages/spawner/
  package.json                 # name: "@pithos/spawner", bin: { "pandora-spawn": "./bin/pandora-spawn" }
  tsconfig.json
  scripts/build.mjs            # esbuild bundle, mirror of @pithos/cli's
  bin/
    pandora-spawn              # built entrypoint (linked on PATH via pnpm build)
  src/
    main.ts                    # arg parse → dispatch → exit code
    cli.ts                     # tiny hand-rolled parser; no @effect/cli
    template.ts                # agents.json parse + {{var}} render
    harness.ts                 # buildClaudeArgv + spawnFake
    hooks-install.ts           # merge into ~/.claude/settings.json
    paths.ts                   # locate templates dir, hooks dir
  templates/
    agents.json                # agents + launcher command recipes
    _common.md                 # shared invariants (was the skill body)
    pandora.md.tmpl
    envy.md.tmpl
    toil.md.tmpl
  hooks/claude-code/
    dispatch.sh                # the only hook script
  test/
    spawn.snap.test.ts         # one snapshot smoke test
    __snapshots__/
```

Templates and hook scripts ship inside the package and are resolved relative
to the bundled entrypoint, so global install + npm-link both work.

## 5. CLI shape

Default verb is spawn; subcommands are admin only.

```bash
# spawn (default verb)
pandora-spawn --agent envy --scope repo:work/perkbox-services/protobuf [--task task_123] [--cwd "$PWD"] [--harness claude|fake]

# admin
pandora-spawn hooks install        # merges hook entries into ~/.claude/settings.json
pandora-spawn hooks uninstall      # reverse
pandora-spawn templates list       # prints { name, model, tools, capability } per template
```

Output: JSON on stdout, one object per invocation. `--harness fake` writes
the assembled spawn description (env, argv, rendered prompt) to that JSON
instead of execing claude.

```json
{
  "ok": true,
  "agent": "envy",
  "run_id": "run_abc",
  "session_id": "uuid-...",
  "scope_id": "repo:work/perkbox-services/protobuf",
  "task_id": null,
  "harness": "claude",
  "pid": 12345
}
```

Exit codes: `0` success, `1` user error, `2` template/frontmatter error.
That is the entire surface.

## 6. Manifest and launcher command API

`templates/agents.json` is source-controlled MVP config. It contains both
agent definitions and launcher command recipes. Pithos does not read this file;
it remains state-only. Pandora-Spawn reads it to render agent prompts and expose
intent-level delegation commands.

Agent-facing launcher command names are stable API:

| Command | Intent |
|---|---|
| `spawn` | Start/delegate a session. |
| `status` | Read semantic session history/status. Prefer this for progress/completion checks. |
| `nudge` | Send follow-up intent/input to an existing session. May become queue-backed later. |
| `kill` | Forcibly terminate/recycle a session. Not graceful cleanup. |
| `tty_status` | Raw TTY/pane capture for last-resort harness debugging. |

Command bodies are launcher implementation detail and may use tmux, zellij, a
remote runner, or another adapter later. Pandora may receive launcher `meta` for
introspection/debugging; normal specialised agents should not need it.

MVP `status` should reuse the prior-art semantic status behaviour rather than
raw tmux capture: find Claude JSONL logs under `~/.claude/projects/**/<id>.jsonl`
(and Pi logs if/when Pi is added), parse recent user/assistant messages, and
surface tool-only assistant turns as `[tools: ...]`. Use `tty_status` only when
that semantic status is missing, stale, or debugging the TTY harness itself.

Example manifest shape:

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
      "meta": {
        "status_source": "claude_jsonl",
        "tty_provider": "tmux",
        "debug_rule": "Use status first. Use tty_status only as last resort."
      }
    }
  },
  "agents": [
    {
      "agent": "pandora",
      "model": "opus",
      "tools": ["Bash", "Read", "Grep", "Glob"],
      "capability": "orchestrate",
      "includes": ["_common.md"],
      "system_prompt": "pandora.md.tmpl",
      "launcher": "local_claude_tmux",
      "inject_meta": true
    }
  ]
}
```

## 7. Template format

`capability` in the manifest is the queue-facing work class the agent is expected to claim. It must describe the requested outcome (`triage`, `design`, `implement`), not the agent's internal execution strategy. For example, Envy may coordinate workers by watching transcripts, but its queue-facing capability is still `implement`.

```markdown
---
agent: envy
model: opus
tools: [Bash, Read, Grep, Glob]
capability: implement
includes: [_common.md]
---

You have access to exactly these tools: {{tools_csv}}. No others exist.

You are Envy. Claim one Pithos task with capability `{{capability}}`,
oversee it, attach a worker artifact, complete or fail your task, exit.

## Pithos CLI for this session

```
{{pithos_help}}
```

Run `pithos <subcommand> --help` for per-command flags.

## Runtime context

- run_id:   {{run_id}}
- scope:    {{scope_id}}
- task_id:  {{task_id}}
- cwd:      {{cwd}}

## Invariants

{{_common.md}}
```

### Agent manifest schema

| Field | Type | Required | Notes |
|---|---|---|---|
| `agent` | string | yes | Must match the file stem (`envy.md.tmpl` → `envy`). |
| `model` | string | yes | Passed straight to `claude --model`. |
| `tools` | string[] | yes | Tool names; passed to `claude --tools` as CSV. Empty array is a validation error — be explicit. |
| `capability` | string | yes | Pithos capability the agent expects to claim. Use queue-facing outcome classes such as `triage`, `design`, `implement`; do not use internal execution-style labels such as `watch`. Rendered into prompt only. |
| `includes` | string[] | no | Other files in `templates/` whose contents are inlined where the matching `{{filename}}` placeholder appears. |
| `launcher` | string | no | Key into top-level `launchers`. If present, `cmd_*` vars become available. |
| `inject_meta` | boolean | no | If true, render launcher metadata into `{{launcher_meta}}`. Intended for Pandora. |

Validate via a tiny schema check on parse; throw with a clear path/field on
failure. No Effect.Schema needed (this is the spawner, not pithos).

### Render context

Single object passed to the renderer:

```ts
type RenderContext = {
  agent: string;
  capability: string;
  model: string;
  tools_csv: string;
  run_id: string;
  scope_id: string;
  task_id: string;            // empty string if --task absent; never null
  cwd: string;
  pithos_help: string;        // captured from `pithos --help` at spawn time
  session_id: string;
  cmd_spawn: string;
  cmd_status: string;
  cmd_nudge: string;
  cmd_kill: string;
  cmd_tty_status: string;
  launcher_meta: string;
} & { [includeName: string]: string };  // populated from includes[]
```

### Renderer

```ts
function render(template: string, ctx: RenderContext): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key) => {
    if (!(key in ctx)) throw new Error(`Unknown template var: ${key}`);
    return ctx[key];
  });
}
```

That's it. No partials engine, no escaping, no helpers. ~6 lines.

## 8. Spawn flow

```
1. Parse argv. Resolve agent name.
2. Read templates/<agent>.md.tmpl. Parse frontmatter.
3. Validate frontmatter (presence + types).
4. Read each includes[] file from templates/.
5. Subprocess: pithos --help        → pithos_help
6. Subprocess: pithos run register  → run_id
   (--agent-kind <agent>, --scope <scope>, --cwd <cwd>)
7. Generate session_id (crypto.randomUUID).
8. Render prompt body with full RenderContext.
9. Build env: PITHOS_RUN_ID, PITHOS_AGENT=<agent>, PITHOS_SCOPE_ID,
              PITHOS_TASK_ID (if any), PITHOS_OUTPUT=json.
10. Build argv (claude harness):
    claude
      --session-id <uuid>
      --dangerously-skip-permissions
      --permission-mode acceptEdits
      --model <frontmatter.model>
      <rendered prompt>          # positional, so claude immediately starts working
    The frontmatter `tools` list is rendered into the prompt body for the
    agent's awareness; it is not passed via `--allowed-tools` because
    `--dangerously-skip-permissions` is in effect.
11. Execute via the selected harness:
    - claude harness: write a wrapper bash script (env exports + exec claude),
      launch via `tmux new-session -d -s pithos-<agent>-<short-uuid>`,
      return the tmux session name and pane pid. Detached so the spawning
      process (Pandora's Bash tool, or `pandora-start.sh`) can continue.
    - fake harness:   write { env, argv, prompt } JSON to stdout. No exec.
```

Step 6 may fail (DB not initialised, scope unknown). Surface the `pithos`
stderr verbatim and exit non-zero — do not paper over it.

## 9. Harness module

```ts
type Spawn = {
  env: Record<string, string>;
  argv: string[];          // [bin, ...args]
  prompt: string;
  cwd: string;
};

type Harness = {
  name: "claude" | "fake";
  run(s: Spawn): Promise<{ pid: number | null; output: unknown }>;
};
```

Two implementations. `claude` writes a wrapper script and launches it via
`tmux new-session -d` so claude always has a TTY regardless of how
`pandora-spawn` was invoked, then returns `{ tmux_session, script_path,
pane_pid }`. `fake` returns the spawn description and never execs. The
fake is reused by `tasks.md` slice 18 (fake-Claude harness for
deterministic spawn tests), so build it once, here.

## 10. Hooks

One script, two registrations. Two responsibilities only:

1. **Liveness** — `PreToolUse` fires throttled `pithos heartbeat` so sweep
   doesn't flag active runs as stale. Throttle (60s) keeps frequent tool
   calls cheap.
2. **Clean shutdown** — `SessionEnd` with matcher `prompt_input_exit` fires
   `pithos run end --status ended`. **Not** `Stop` — Stop fires after
   every assistant turn, which would close the run on the first reply.
   Of the SessionEnd matchers, only `prompt_input_exit` reliably indicates
   the process is actually terminating; `clear` and `resume` do not.

Everything else (UserPromptSubmit, PostToolUse, Stop, StopFailure, etc.)
is deferred — redundant or "nice-to-have, not now".

`hooks/claude-code/dispatch.sh`:

```bash
#!/usr/bin/env bash
[ -n "${PITHOS_AGENT:-}" ]  || exit 0
[ -n "${PITHOS_RUN_ID:-}" ] || exit 0
case "${1:-unknown}" in
  SessionEnd) pithos run end --run "$PITHOS_RUN_ID" --status ended >/dev/null 2>&1 || true ;;
  *)          pithos heartbeat --run "$PITHOS_RUN_ID" --hook "$1" --throttle-seconds 60 >/dev/null 2>&1 || true ;;
esac
```

`pandora-spawn hooks install` resolves the absolute path to this script
inside the installed package, then merges into `~/.claude/settings.json`:

```jsonc
{
  "hooks": {
    "PreToolUse": [{"hooks":[{"type":"command","command":"<abs>/dispatch.sh PreToolUse"}]}],
    "SessionEnd": [{"matcher":"prompt_input_exit","hooks":[{"type":"command","command":"<abs>/dispatch.sh SessionEnd"}]}]
  }
}
```

Idempotent: if a matching command line already exists, leave it. `hooks
uninstall` removes only the entries whose command points at our script.

The `[ -n "$PITHOS_AGENT" ]` guard means Adam's normal Claude sessions are
unaffected — only spawner-launched sessions trigger heartbeats.

### Alternative install — Claude Code plugin (preferred on Nix)

On systems where `~/.claude/settings.json` is a read-only home-manager symlink, `pandora-spawn hooks install` will fail because it cannot write to that file. The preferred install path on those setups is the Claude Code plugin at `plugin/` in the repo root. The plugin's `hooks/hooks.json` registers the same two entries (`PreToolUse` + `SessionEnd prompt_input_exit`) declaratively via `${CLAUDE_PLUGIN_ROOT}/hooks/dispatch.sh` (a symlink into `packages/spawner/hooks/claude-code/dispatch.sh`), without touching `settings.json`. Install once with `/plugin marketplace add https://github.com/codethread/pithos` then `/plugin install pithos@codethread/pithos`. The CLI path (`pandora-spawn hooks install`) remains the manual fallback for users on writable-settings systems.

## 11. Templates shipped in MVP

- `_common.md` — invariants (fencing tokens, exit codes, anti-patterns).
  Content is a trimmed version of today's `skills/pithos-cli/SKILL.md`.
- `pandora.md.tmpl` — orchestrator role. Receives launcher command API and meta.
- `envy.md.tmpl` — task-scoped execution coordinator. Capability `implement`.
- `toil.md.tmpl` — short-lived recipe dispatcher. Capability `triage`.

Greed and worker templates are deferred until a real workflow asks for them.

## 12. Testing

One file: `test/spawn.snap.test.ts`.

```ts
import { test, expect } from "vitest";
import { execFileSync } from "node:child_process";

test("envy spawn renders deterministic prompt + argv (fake harness)", () => {
  const out = execFileSync("pandora-spawn", [
    "--agent", "envy",
    "--scope", "repo:work/example",
    "--harness", "fake",
  ], {
    env: {
      ...process.env,
      PITHOS_DB: "/tmp/pandora-spawn-test.sqlite",  // pithos init done in setup
      // freeze ids so the snapshot stays stable
      PANDORA_SPAWN_FAKE_RUN_ID: "run_TEST",
      PANDORA_SPAWN_FAKE_SESSION_ID: "session-TEST",
    },
  }).toString();
  expect(JSON.parse(out)).toMatchSnapshot();
});
```

Setup: a global Vitest setup runs `pithos init` and `pithos scope upsert`
against a temp DB before the test. `_common.md` and `pithos --help` capture
must also be deterministic in fake mode — env-overridable IDs and a frozen
help capture (we shell out to real `pithos --help`; if its output drifts,
the snapshot updates intentionally as part of the same change).

That's the whole test plan. Add more only when something breaks.

## 13. Implementation order

1. Scaffold `packages/spawner` package + bin + esbuild script (mirror cli).
2. Write `template.ts` (parse + render).
3. Write `harness.ts` (claude + fake).
4. Write `cli.ts` + `main.ts` (parse → render → harness).
5. Write the three template files (`_common.md`, `envy.md.tmpl`, `toil.md.tmpl`).
6. Write `dispatch.sh`.
7. Write `hooks-install.ts`.
8. Add the snapshot test.
9. `pnpm verify` green.
10. Manual smoke: `pandora-spawn --agent envy --scope repo:... --harness fake | jq .`

Stop. Anything beyond this list is scope creep for this slice.

## 14. Out of scope (for follow-up slices, not this one)

- Real-Claude smoke spawn from inside Vitest (HITL slice 21 territory).
- Worker template / delegate flow.
- Greed template.
- Pi (or other harness) adapter.
- Per-spawn settings.json (inline `--settings '{...}'`) instead of global hooks.
- Templating engine upgrade (eta/handlebars).
- Pithos-Spawn merging into Pithos. They stay separate.
