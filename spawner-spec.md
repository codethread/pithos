# Pandora-Spawn spec

**Status:** Planned
**Last Updated:** 2026-05-03
**Package:** `@pithos/spawner`
**Bin:** `pandora-spawn`
**Workspace path:** `packages/spawner`

## 1. Purpose

Pandora-Spawn is a tiny CLI that turns a versioned agent template into a
running Claude Code session. It owns templates, frontmatter, render context,
and the harness adapter that builds the `claude` argv.

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
    template.ts                # frontmatter parse + {{var}} render
    harness.ts                 # buildClaudeArgv + spawnFake
    hooks-install.ts           # merge into ~/.claude/settings.json
    paths.ts                   # locate templates dir, hooks dir
  templates/
    _common.md                 # shared invariants (was the skill body)
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

## 6. Template format

```markdown
---
agent: envy
model: opus
tools: [Bash, Read, Grep, Glob]
capability: watch
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

### Frontmatter schema

| Field | Type | Required | Notes |
|---|---|---|---|
| `agent` | string | yes | Must match the file stem (`envy.md.tmpl` → `envy`). |
| `model` | string | yes | Passed straight to `claude --model`. |
| `tools` | string[] | yes | Tool names; passed to `claude --tools` as CSV. Empty array is a validation error — be explicit. |
| `capability` | string | yes | Pithos capability the agent expects to claim. Rendered into prompt only. |
| `includes` | string[] | no | Other files in `templates/` whose contents are inlined where the matching `{{filename}}` placeholder appears. |

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

## 7. Spawn flow

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
      --model <frontmatter.model>
      --tools "<frontmatter.tools csv>"
      --append-system-prompt <rendered prompt>
      [--cwd <cwd>]   # if claude supports it; else use spawn() cwd
11. Execute via the selected harness:
    - claude harness: spawn process, print JSON, exit with claude's code.
    - fake harness:   write { env, argv, prompt } JSON to stdout. No exec.
```

Step 6 may fail (DB not initialised, scope unknown). Surface the `pithos`
stderr verbatim and exit non-zero — do not paper over it.

## 8. Harness module

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

Two implementations. `claude` shells out via `child_process.spawn`. `fake`
returns the spawn description and never execs. The fake is reused by
`tasks.md` slice 18 (fake-Claude harness for deterministic spawn tests),
so build it once, here.

## 9. Hooks

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

## 10. Templates shipped in MVP

- `_common.md` — invariants (fencing tokens, exit codes, anti-patterns).
  Content is a trimmed version of today's `skills/pithos-cli/SKILL.md`.
- `envy.md.tmpl` — task-scoped execution coordinator. Capability `watch`.
- `toil.md.tmpl` — short-lived recipe dispatcher. Capability `triage`.

Greed and worker templates are deferred until a real workflow asks for them.

## 11. Testing

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

## 12. Implementation order

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

## 13. Out of scope (for follow-up slices, not this one)

- Real-Claude smoke spawn from inside Vitest (HITL slice 21 territory).
- Worker template / delegate flow.
- Greed template.
- Pi (or other harness) adapter.
- Per-spawn settings.json (inline `--settings '{...}'`) instead of global hooks.
- Templating engine upgrade (eta/handlebars).
- Pithos-Spawn merging into Pithos. They stay separate.
