import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { HelpRequested, parseArgs } from "./cli.ts"
import { buildClaudeArgv, runClaude, runFake } from "./harness.ts"
import { installHooks, uninstallHooks } from "./hooks-install.ts"
import { agentsPath, templatesDir } from "./paths.ts"
import { renderStatus } from "./status.ts"
import { loadAgentManifests, loadTemplate, render } from "./template.ts"

interface ExecFailure { readonly stderr?: Buffer }

const pithos = (args: readonly string[], env: NodeJS.ProcessEnv = process.env): string => {
  try {
    return execFileSync("pithos", args, { env }).toString()
  } catch (error: unknown) {
    const failure = error as ExecFailure
    if (Buffer.isBuffer(failure.stderr) && failure.stderr.length > 0) {
      process.stderr.write(failure.stderr)
    }
    throw new Error(`pithos ${args.join(" ")} failed`)
  }
}

const writeJson = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

const execText = (args: readonly string[]): string => execFileSync(args[0] ?? "", args.slice(1)).toString()

interface RunRegisterOutput { readonly run: { readonly id: string } }

const parseRunId = (raw: string): string => {
  const parsed = JSON.parse(raw) as unknown
  if (typeof parsed !== "object" || parsed === null || !("run" in parsed)) throw new Error("pithos run register returned invalid JSON")
  const runOutput = parsed as RunRegisterOutput
  if (typeof runOutput.run.id !== "string") throw new Error("pithos run register returned invalid run id")
  return runOutput.run.id
}

const run = async (): Promise<void> => {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.command === "hooks:install") { installHooks(); writeJson({ ok: true }); return }
  if (opts.command === "hooks:uninstall") { uninstallHooks(); writeJson({ ok: true }); return }
  if (opts.command === "status") { process.stdout.write(`${renderStatus(opts.sessionId, opts.lines)}\n`); return }
  if (opts.command === "nudge") { process.stdout.write(execText(["tmux", "send-keys", "-t", opts.target, opts.message, "Enter"])); return }
  if (opts.command === "kill") { process.stdout.write(execText(["tmux", "kill-session", "-t", opts.target])); return }
  if (opts.command === "tty-status") { process.stdout.write(execText(["tmux", "capture-pane", "-t", opts.target, "-p"])); return }
  if (opts.command === "templates:list") {
    const templates = loadAgentManifests(agentsPath).map((manifest) => ({ name: manifest.agent, model: manifest.model, tools: manifest.tools, capability: manifest.capability, launcher: manifest.launcher ?? null }))
    writeJson({ ok: true, templates })
    return
  }

  const template = loadTemplate(agentsPath, templatesDir, opts.agent)
  const pithosHelp = process.env.PANDORA_SPAWN_FAKE_PITHOS_HELP ?? pithos(["--help"])
  const sessionId = process.env.PANDORA_SPAWN_FAKE_SESSION_ID ?? (opts.preview ? "session_PREVIEW" : randomUUID())
  const runId = process.env.PANDORA_SPAWN_FAKE_RUN_ID ?? (opts.preview ? "run_PREVIEW" : parseRunId(pithos(["run", "register", "--agent-kind", opts.agent, "--scope", opts.scope, "--cwd", opts.cwd, "--session-id", sessionId])))
  const toolsCsv = template.manifest.tools.join(",")
  const launcherCommands = template.launcher?.commands
  const launcherMeta = template.manifest.inject_meta && template.launcher !== undefined
    ? `## Launcher meta\n\n\`\`\`json\n${JSON.stringify({ kind: template.launcher.kind, harness: template.launcher.harness, meta: template.launcher.meta }, null, 2)}\n\`\`\``
    : ""
  const context = {
    agent: opts.agent,
    capability: template.manifest.capability,
    model: template.manifest.model,
    tools_csv: toolsCsv,
    run_id: runId,
    session_id: sessionId,
    scope_id: opts.scope,
    task_id: opts.task ?? "",
    cwd: opts.cwd,
    pithos_help: pithosHelp,
    cmd_spawn: launcherCommands?.spawn ?? "",
    cmd_status: launcherCommands?.status ?? "",
    cmd_nudge: launcherCommands?.nudge ?? "",
    cmd_kill: launcherCommands?.kill ?? "",
    cmd_tty_status: launcherCommands?.tty_status ?? "",
    launcher_meta: launcherMeta,
    ...template.includes,
  }
  const prompt = render(template.body, context)
  const env = { PITHOS_RUN_ID: runId, PITHOS_AGENT: opts.agent, PITHOS_SCOPE_ID: opts.scope, PITHOS_OUTPUT: "json", ...(opts.task ? { PITHOS_TASK_ID: opts.task } : {}) }
  const argv = buildClaudeArgv({ sessionId, model: template.manifest.model, toolsCsv, prompt })
  const description = { env, argv, prompt, cwd: opts.cwd }
  if (opts.preview) {
    writeJson({ ok: true, preview: true, agent: opts.agent, run_id: runId, session_id: sessionId, scope_id: opts.scope, task_id: opts.task ?? null, harness: opts.harness, ...description })
    return
  }
  const result = opts.harness === "fake" ? await runFake(description) : await runClaude(description)
  writeJson({ ok: result.exitCode === 0, agent: opts.agent, run_id: runId, session_id: sessionId, scope_id: opts.scope, task_id: opts.task ?? null, harness: opts.harness, pid: result.pid, ...result.output })
  process.exitCode = result.exitCode
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof HelpRequested) {
    process.stdout.write(`${message}\n`)
    process.exit(0)
  }
  process.stderr.write(`${message}\n`)
  const exitCode = typeof error === "object" && error !== null && "exitCode" in error && typeof error.exitCode === "number" ? error.exitCode : 1
  process.exit(exitCode)
})
