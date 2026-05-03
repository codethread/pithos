# Handover prompt: fresh HITL Pandora delegation test

You are helping run a fresh real end-to-end Pithos/Pandora test in `~/dev/pithos`.

## Current starting state

- Relevant implementation commit: `41e9942 feat: package the real Pandora launch flow`
- Repo should start clean.
- Cleanup already performed before this handoff:
  - removed the temporary `scripts/hello.sh` test file
  - killed the stray `pithos-pandora-*` tmux session
  - dropped `~/.pandora/pithos.sqlite`
  - removed the temp `/tmp/pithos-e2e.*` DB directory

## What the previous test established

- `pnpm verify` passed.
- Real Pandora spawning worked.
- `pandora-spawn status` worked.
- A fresh task could be completed and tracked in Pithos.

## What the previous test did **not** prove

- Pandora did **not** follow the intended process.
- Instead of delegating, Pandora wrote the test file itself.
- So the required flow `Pandora -> Toil -> Envy -> worker` is still **unproven**.

## Hard constraints for this rerun

1. **No `tmux send-keys`. No `pandora-spawn nudge`. No terminal input injection at all.**
   - If you need new human input, stop and report instead of poking the session.
2. **Pandora must not implement the file itself.**
   - The point of this test is delegation discipline.
3. Prefer `pandora-spawn status` for observation.
   - Use `tty-status` only as last-resort harness debugging.
4. Keep state mutations going through `pithos` only.
5. Run normal checks before any code changes/commits:
   - `pnpm lint`
   - `pnpm typecheck`
   - `pnpm test`
   - `pnpm run build`

## Important machine-specific notes

### 1. `scripts/pandora-start.sh` is likely not the right entrypoint on this machine

`pandora-spawn hooks install` failed here with:

```text
EACCES: permission denied, open '/Users/codethread/.claude/settings.json'
```

Reason: `~/.claude/settings.json` is read-only on this setup.

So for this rerun, do **not** assume `scripts/pandora-start.sh` will work unchanged.
Prefer the manual spawn flow unless you are explicitly fixing that script.

### 2. Watch for `PITHOS_DB` propagation

A previous attempt strongly suggested the spawned Claude session may not inherit `PITHOS_DB` from the parent spawn process.

Consequence: even if the parent process uses a temp DB, Pandora may still talk to the default DB unless `PITHOS_DB` is explicitly propagated into the spawned session environment.

If you want an isolated DB for this rerun, verify that the spawned session actually sees and uses the same DB path.
Otherwise, use the freshly dropped default DB intentionally and keep the run simple.

## Goal of this rerun

Prove the intended delegation chain end-to-end for a simple hello-script task.

Target request:

> write a simple bash script in the pithos repo that says hello

Required flow:

1. Pandora starts and inspects the current Pithos state.
2. Pandora delegates appropriately — ideally through Toil for triage/dispatch.
3. Toil emits or routes the actionable work.
4. Envy claims the watch task.
5. Envy uses a worker (or equivalent delegated worker-style execution), rather than Pandora doing the file edit.
6. The worker creates the script.
7. Envy verifies it, attaches a `worker-completion` artifact, and completes the task with the fencing token.
8. Pandora reports the outcome from Pithos state.

## Success criteria

This rerun is only a success if **all** of the following are true:

- clean DB at start
- Pandora spawns successfully
- Pandora does **not** write the file itself
- Toil/Envy delegation path is observable in runs/tasks/artifacts
- the repo ends up with the hello script created by the delegated path
- the script runs successfully
- Pithos shows the relevant run/task/artifact state cleanly
- final report includes concrete IDs and commands

## Capture these exact facts in the report

- Pandora run id
- Toil run id (if used)
- Envy run id
- worker run id (if any)
- task id(s)
- artifact id(s)
- file path created
- verification command run
- whether hooks were active
- whether `PITHOS_DB` propagation was correct

## Suggested operator flow

```sh
cd ~/dev/pithos

git status --short
pnpm verify

# then initialise fresh state
pithos init
scope_json="$(pithos scope upsert --kind repo --path "$PWD")"
scope_id="$(printf '%s' "$scope_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).scope.id))')"

# prefer manual spawn on this machine
pandora-spawn --agent pandora --scope "$scope_id" --cwd "$PWD"
```

Then interact with Pandora manually/HITL and observe via:

```sh
pandora-spawn status --session-id <claude_session_uuid> --lines 20
pithos briefing --agent pandora
pithos tail --limit 20
pithos inspect task <task_id>
pithos inspect run <run_id>
```

## If the rerun fails

Do not paper over it.
Report the exact failing step and command/output.
The most important unresolved risks are:

- Pandora ignoring delegation discipline
- `PITHOS_DB` not propagating into spawned sessions
- read-only Claude settings preventing the intended hook install path
