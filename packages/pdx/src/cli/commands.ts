import { Command, HelpDoc, Options } from "@effect/cli"
import { openCommand } from "../commands/open.ts"
import { closeCommand } from "../commands/close.ts"
import { statusCommand } from "../commands/status.ts"
import { logsShowCommand } from "../commands/logs.ts"
import { daemonRunCommand } from "../commands/daemon.ts"

const opt = <A>(value: { readonly _tag: "Some"; readonly value: A } | { readonly _tag: "None" }): A | undefined =>
  value._tag === "Some" ? value.value : undefined

const desc = (
  summary: string,
  cmdPath: string,
  examples: readonly string[],
  exitCodesLine: string,
): HelpDoc.HelpDoc =>
  HelpDoc.blocks([
    HelpDoc.p(`${cmdPath} - ${summary}`),
    HelpDoc.p("Examples:"),
    ...examples.map((example) => HelpDoc.p(`  ${example}`)),
    HelpDoc.p(`Exit codes: ${exitCodesLine}`),
  ])

const homeOption = Options.text("home").pipe(
  Options.optional,
  Options.withDescription("pdx home directory (default: ~/.pandora)"),
)

const open = Command.make(
  "open",
  {
    home: homeOption,
    intervalSeconds: Options.integer("interval-seconds").pipe(
      Options.optional,
      Options.withDescription("Reconcile interval in seconds (default: 5)"),
    ),
    maxAfk: Options.integer("max-afk").pipe(
      Options.optional,
      Options.withDescription("Maximum AFK agents (default: 4)"),
    ),
  },
  ({ home, intervalSeconds, maxAfk }) => {
    const resolvedHome = opt(home)
    const resolvedInterval = opt(intervalSeconds)
    const resolvedMaxAfk = opt(maxAfk)

    return openCommand({
      ...(resolvedHome === undefined ? {} : { home: resolvedHome }),
      ...(resolvedInterval === undefined ? {} : { intervalSeconds: resolvedInterval }),
      ...(resolvedMaxAfk === undefined ? {} : { maxAfk: resolvedMaxAfk }),
    })
  },
).pipe(
  Command.withDescription(
    desc(
      "Start the pdx daemon tmux session and initialize local state",
      "pdx open",
      ["PITHOS_BIN=packages/pithos/bin/pithos-next pdx open --home /tmp/pdx-home"],
      "0 success | 1 user error | 2 validation error",
    ),
  ),
)

const close = Command.make(
  "close",
  { home: homeOption },
  ({ home }) => {
    const resolvedHome = opt(home)
    return closeCommand(resolvedHome === undefined ? {} : { home: resolvedHome })
  },
).pipe(
  Command.withDescription(
    desc(
      "Stop the pdx daemon and clean up the pdx system run",
      "pdx close",
      ["pdx close --home /tmp/pdx-home"],
      "0 success | 1 user error",
    ),
  ),
)

const status = Command.make(
  "status",
  {
    home: homeOption,
    json: Options.boolean("json").pipe(
      Options.withDescription("Emit JSON status (the only supported mode in MVP)"),
    ),
  },
  ({ home, json }) => {
    const resolvedHome = opt(home)
    return statusCommand({
      ...(resolvedHome === undefined ? {} : { home: resolvedHome }),
      json,
    })
  },
).pipe(
  Command.withDescription(
    desc(
      "Show daemon, registry, queue, and cap status",
      "pdx status",
      ["pdx status --json", "pdx status --home /tmp/pdx-home --json"],
      "0 success | 1 user error",
    ),
  ),
)

const logsShow = Command.make(
  "show",
  {
    home: homeOption,
    limit: Options.integer("limit").pipe(
      Options.optional,
      Options.withDescription("Number of lines to show (default: 100)"),
    ),
    all: Options.boolean("all").pipe(Options.withDescription("Show all matching lines")),
    since: Options.text("since").pipe(
      Options.optional,
      Options.withDescription("ISO timestamp, 10m, 1h, 2d, 1w, today, or yesterday"),
    ),
  },
  ({ home, limit, all, since }) => {
    const resolvedHome = opt(home)
    const resolvedLimit = opt(limit)
    const resolvedSince = opt(since)

    return logsShowCommand({
      ...(resolvedHome === undefined ? {} : { home: resolvedHome }),
      ...(resolvedLimit === undefined ? {} : { limit: resolvedLimit }),
      all,
      ...(resolvedSince === undefined ? {} : { since: resolvedSince }),
    })
  },
).pipe(
  Command.withDescription(
    desc(
      "Show raw supervisor JSONL log lines",
      "pdx logs show",
      ["pdx logs show", "pdx logs show --since 10m", "pdx logs show --all"],
      "0 success | 1 user error | 2 validation error | 3 not found",
    ),
  ),
)

const logs = Command.make("logs").pipe(
  Command.withDescription("Read supervisor logs"),
  Command.withSubcommands([logsShow]),
)

const daemonRun = Command.make(
  "run",
  {
    home: Options.text("home").pipe(Options.withDescription("pdx home directory")),
    intervalSeconds: Options.integer("interval-seconds").pipe(
      Options.withDescription("Reconcile interval in seconds"),
    ),
    maxAfk: Options.integer("max-afk").pipe(Options.withDescription("Maximum AFK agents")),
  },
  ({ home, intervalSeconds, maxAfk }) => daemonRunCommand({ home, intervalSeconds, maxAfk }),
)

const daemon = Command.make("daemon").pipe(Command.withSubcommands([daemonRun]))

export const pdxCommand = Command.make("pdx").pipe(
  Command.withDescription(
    HelpDoc.blocks([
      HelpDoc.p("Local supervisor for Pandora's Box."),
      HelpDoc.p("Environment:"),
      HelpDoc.p("  PITHOS_BIN   pithos binary path (default: pithos-next)"),
      HelpDoc.p("  PITHOS_DB    SQLite DB path forwarded to pithos commands"),
      HelpDoc.p("Exit codes:"),
      HelpDoc.p("  0  Success"),
      HelpDoc.p("  1  General/user error"),
      HelpDoc.p("  2  Validation error"),
      HelpDoc.p("  3  Not found"),
    ]),
  ),
  Command.withSubcommands([open, close, status, logs, daemon]),
)
