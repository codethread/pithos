import { describe, it, expect } from "vitest"
import { join } from "node:path"
import { runCli } from "./_helpers/exec.ts"

const BIN = join(import.meta.dirname, "../bin/pithos")

async function help(args: string[]): Promise<{ stdout: string; exitCode: number }> {
  const result = await runCli(BIN, args, { ...process.env, PITHOS_DB: "/dev/null" })
  return { stdout: result.stdout, exitCode: result.exitCode }
}

function assertRequiredSections(text: string, command: string): void {
  expect(text, `${command}: must have Usage section`).toMatch(/Usage:/i)
  expect(text, `${command}: must have Examples section`).toMatch(/Examples:/i)
  expect(text, `${command}: must have exit codes`).toMatch(/Exit codes?:/i)
}

describe("CLI help contract", () => {
  it("top-level help exits 0 and lists commands/env/exit codes", async () => {
    for (const args of [["--help"], ["-h"], []]) {
      const result = await help(args)
      expect(result.exitCode).toBe(0)
    }

    const { stdout } = await help(["--help"])
    for (const text of [
      "init", "scope upsert", "run register", "run end", "heartbeat", "enqueue", "claim", "complete", "fail",
      "artifact add", "inspect", "briefing", "tail", "sweep", "PITHOS_DB", "PITHOS_RUN_ID", "PITHOS_OUTPUT", "Exit codes",
    ]) {
      expect(stdout).toContain(text)
    }
  })

  it("every agent-facing help page exits 0 and includes required sections/help flag", async () => {
    const commands = [
      ["init", "--help"], ["scope", "--help"], ["run", "--help"], ["artifact", "--help"],
      ["scope", "upsert", "--help"], ["run", "register", "--help"], ["run", "end", "--help"],
      ["enqueue", "--help"], ["claim", "--help"], ["heartbeat", "--help"], ["complete", "--help"],
      ["fail", "--help"], ["artifact", "add", "--help"], ["inspect", "--help"], ["inspect", "scope", "--help"],
      ["inspect", "run", "--help"], ["inspect", "task", "--help"], ["tail", "--help"], ["sweep", "--help"],
      ["briefing", "--help"],
    ]

    for (const args of commands) {
      const { stdout, exitCode } = await help(args)
      expect(exitCode).toBe(0)
      assertRequiredSections(stdout, args.join(" "))
      expect(stdout, `${args.join(" ")}: must self-document --help/-h`).toMatch(/--help.*-h|-h.*--help/i)
    }
  })

  it("keeps command-specific help when flags or operands precede --help", async () => {
    const inspect = await help(["inspect", "task", "task_123", "--help"])
    expect(inspect.exitCode).toBe(0)
    expect(inspect.stdout).toContain("pithos inspect")

    const runEnd = await help(["run", "end", "--run", "run_123", "--help"])
    expect(runEnd.exitCode).toBe(0)
    expect(runEnd.stdout).toContain("pithos run end")
  })

  it("unknown commands with --help fail instead of falling back to help", async () => {
    for (const args of [["runn", "--help"], ["run", "bogus", "--help"], ["inspect", "oops", "--help"]]) {
      const result = await help(args)
      expect(result.exitCode).toBe(1)
      expect(result.stdout).toBe("")
    }
  })

  it("-h is equivalent to --help for all top-level commands", async () => {
    for (const command of ["init", "scope", "run", "enqueue", "claim", "heartbeat", "complete", "fail", "artifact", "inspect", "tail", "sweep", "briefing"]) {
      const [longResult, shortResult] = await Promise.all([help([command, "--help"]), help([command, "-h"])])
      expect(shortResult.exitCode).toBe(0)
      expect(shortResult.stdout).toBe(longResult.stdout)
    }
  })
})
