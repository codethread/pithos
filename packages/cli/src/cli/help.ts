import { INIT_HELP } from "../commands/init.ts"
import { SCOPE_UPSERT_HELP } from "../commands/scope.ts"
import { INSPECT_HELP } from "../commands/inspect.ts"
import { RUN_REGISTER_HELP, RUN_END_HELP } from "../commands/run.ts"
import { ENQUEUE_HELP } from "../commands/enqueue.ts"
import { CLAIM_HELP } from "../commands/claim.ts"
import { HEARTBEAT_HELP } from "../commands/heartbeat.ts"
import { COMPLETE_HELP } from "../commands/complete.ts"
import { FAIL_HELP } from "../commands/fail.ts"
import { ARTIFACT_ADD_HELP } from "../commands/artifact.ts"
import { TAIL_HELP } from "../commands/tail.ts"
import { SWEEP_HELP } from "../commands/sweep.ts"
import { BRIEFING_HELP } from "../commands/briefing.ts"

// ---------------------------------------------------------------------------
// Help texts
// ---------------------------------------------------------------------------

const HELP_TEXT = `pithos - local control plane for coordinating Claude Code agents

Usage: pithos <command> [options]

Commands:
  init                  Create DB, run migrations, default global scope
  scope upsert          Register global/repo/worktree scope
  run register          Register a Claude Code/worker/agent run
  run end               Mark a run ended/failed/cancelled
  heartbeat             Update run heartbeat; optionally advance task to running
  enqueue               Create a queued task and event
  claim                 Atomically claim one queued task for a run
  complete              Complete task if run owns current fencing token
  fail                  Fail task if run owns current fencing token
  artifact add          Attach a completion report/design brief/status artifact
  inspect               Inspect task/run/scope/artifact
  briefing              Render Pandora briefing with as_of_event_id watermark
  tail                  Show recent events
  sweep                 Expire leases, mark stale runs, requeue eligible tasks

Global options:
  --help, -h            Show this help
  --version, -v         Show version

Environment:
  PITHOS_DB             SQLite DB path (default: ~/.pandora/pithos.sqlite)
  PITHOS_RUN_ID         Current run ID for hooks/agents
  PITHOS_TASK_ID        Current claimed task ID
  PITHOS_FENCING_TOKEN  Current task claim token
  PITHOS_SCOPE_ID       Scope hint for current session
  PITHOS_OUTPUT         Output format: json or text (default: json)

Exit codes:
  0  Success
  1  General/user error
  2  Validation error
  3  Not found
  4  Stale lease/fencing token
  5  No claimable work

Run \`pithos <command> --help\` for command-specific usage.
`

// ---------------------------------------------------------------------------
// Namespace help texts (for `pithos scope`, `pithos run`, `pithos artifact`)
// ---------------------------------------------------------------------------

const SCOPE_HELP = `pithos scope - Manage pithos scopes

Usage:
  pithos scope <subcommand> [options]

Subcommands:
  upsert    Register or update a global/repo/worktree scope

Options:
  --help, -h    Show this help

Examples:
  pithos scope upsert --path ~/work/perkbox-services/protobuf
  pithos scope upsert --kind global

Run \`pithos scope <subcommand> --help\` for subcommand-specific usage.

Exit codes: 0 success | 2 validation error
`

const RUN_HELP = `pithos run - Manage pithos runs (Claude Code / worker / agent sessions)

Usage:
  pithos run <subcommand> [options]

Subcommands:
  register    Register a new run and return its ID
  end         Mark a run ended/failed/cancelled

Options:
  --help, -h    Show this help

Examples:
  pithos run register --agent-kind envy --scope repo:work/perkbox-services/protobuf
  pithos run end --run run_abc --status ended

Run \`pithos run <subcommand> --help\` for subcommand-specific usage.

Exit codes: 0 success | 2 validation error | 3 not found
`

const ARTIFACT_HELP = `pithos artifact - Manage pithos artifacts

Usage:
  pithos artifact <subcommand> [options]

Subcommands:
  add    Attach a completion report, design brief, or status artifact to a task

Options:
  --help, -h    Show this help

Examples:
  pithos artifact add --task task_abc --run run_xyz --kind worker-completion --title "Report" --body-file report.md

Run \`pithos artifact <subcommand> --help\` for subcommand-specific usage.

Exit codes: 0 success | 2 validation error | 3 not found
`

export const helpFor = (topic: string | undefined): string => {
  switch (topic) {
    case "init":
      return INIT_HELP
    case "scope":
      return SCOPE_HELP
    case "scope:upsert":
      return SCOPE_UPSERT_HELP
    case "run":
      return RUN_HELP
    case "run:register":
      return RUN_REGISTER_HELP
    case "run:end":
      return RUN_END_HELP
    case "enqueue":
      return ENQUEUE_HELP
    case "claim":
      return CLAIM_HELP
    case "heartbeat":
      return HEARTBEAT_HELP
    case "complete":
      return COMPLETE_HELP
    case "fail":
      return FAIL_HELP
    case "artifact":
      return ARTIFACT_HELP
    case "artifact:add":
      return ARTIFACT_ADD_HELP
    case "inspect":
    case "inspect:scope":
    case "inspect:run":
    case "inspect:task":
      return INSPECT_HELP
    case "tail":
      return TAIL_HELP
    case "sweep":
      return SWEEP_HELP
    case "briefing":
      return BRIEFING_HELP
    default:
      return HELP_TEXT
  }
}

