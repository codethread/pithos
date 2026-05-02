# Pithos CLI Skill

Pithos is a local SQLite-backed control plane for coordinating Claude Code agents. You interact with it exclusively through the `pithos` CLI.

## Golden rule

**Never assume flags from memory. Always run `pithos --help` or `pithos <subcommand> --help` first.**

Help output is the definitive source of flag names, defaults, output shapes, and exit codes. This skill gives orientation only; the CLI help is the contract.

## Quick orientation

```bash
pithos --help                     # all commands + exit codes + env vars
pithos <command> --help           # flags, output shape, examples for one command
pithos <command> <sub> --help     # same for subcommands (e.g. scope upsert --help)
```

## Commands at a glance

| Command | Purpose |
|---|---|
| `pithos init` | Create DB + run migrations + ensure global scope |
| `pithos scope upsert` | Register global/repo/worktree scope |
| `pithos run register` | Register a Claude Code/worker/agent run |
| `pithos run end` | Mark a run ended/failed/cancelled |
| `pithos enqueue` | Create a queued task |
| `pithos claim` | Atomically claim one queued task (returns fencing token) |
| `pithos heartbeat` | Update run liveness; optionally advance task to running |
| `pithos complete` | Complete task (requires fencing token) |
| `pithos fail` | Fail task (requires fencing token) |
| `pithos artifact add` | Attach completion report or design brief to a task |
| `pithos inspect task\|run\|scope` | Inspect a single entity by ID |
| `pithos briefing` | Render Pandora briefing with watermark |
| `pithos tail` | Show recent events |
| `pithos sweep` | Expire stale leases and dead-letter exhausted tasks |

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `PITHOS_DB` | SQLite DB path | `~/.pandora/pithos.sqlite` |
| `PITHOS_RUN_ID` | Current run ID (set by hooks/wrappers) | — |
| `PITHOS_TASK_ID` | Current task ID | — |
| `PITHOS_FENCING_TOKEN` | Current fencing token | — |
| `PITHOS_SCOPE_ID` | Scope hint for session | — |
| `PITHOS_OUTPUT` | `json` or `text` | `json` |

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | General / user error |
| `2` | Validation error |
| `3` | Not found |
| `4` | Stale lease / fencing token |
| `5` | No claimable work |

## Typical agent loop

```bash
# 1. Register yourself as a run
run_json=$(pithos run register --agent-kind envy --scope repo:work/myrepo --cwd "$PWD")
run_id=$(echo "$run_json" | jq -r .run.id)

# 2. Claim a task (check exit code 5 = no work)
claim_json=$(pithos claim --run "$run_id" --scope repo:work/myrepo --capability watch)
# { "ok": true, "task": { "id": "task_...", "fencing_token": 1, ... } }
task_id=$(echo "$claim_json" | jq -r .task.id)
token=$(echo "$claim_json" | jq -r .task.fencing_token)

# 3. Heartbeat (moves task to 'running')
pithos heartbeat --run "$run_id" --task "$task_id" --token "$token"

# 4. Do work ... then complete or fail
pithos complete "$task_id" --run "$run_id" --token "$token"
# or
pithos fail "$task_id" --run "$run_id" --token "$token" --reason "reason here"

# 5. End your run
pithos run end --run "$run_id" --status ended
```

## Key invariants

- **Fencing token**: `claim` returns a token. Pass it to `heartbeat`, `complete`, and `fail`. A stale token (exit 4) means another run reclaimed the task.
- **Scope IDs** are home-relative: `~/work/foo` → `repo:work/foo`. Use `pithos scope upsert --path <path>` to register and get the canonical ID.
- **`pithos sweep`** requeues expired leases (up to `max_attempts`) and dead-letters exhausted tasks. Run it from cron or manually.
- **All mutation commands** return JSON with `"ok": true/false`. Check exit code first; non-zero exit means `ok` is false.
- **Do not write to the DB directly.** `pithos` enforces all transitions and events.
