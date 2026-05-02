/**
 * Snapshot/coverage tests for `pithos --help` and all subcommand `--help` flags.
 *
 * Design principle: agents must be able to discover every flag, example, and
 * exit code from help output alone. These tests freeze that contract and
 * validate the required sections are present.
 */

import { describe, it, expect } from "vitest"
import { join } from "node:path"
import { runCli } from "./_helpers/exec.ts"

const BIN = join(import.meta.dirname, "../bin/pithos")

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run the CLI with the given args in an environment where PITHOS_DB is
 * irrelevant (help exits before touching the DB).
 */
async function help(args: string[]): Promise<{ stdout: string; exitCode: number }> {
  const result = await runCli(BIN, args, { ...process.env, PITHOS_DB: "/dev/null" })
  return { stdout: result.stdout, exitCode: result.exitCode }
}

/** Assert that the help text includes required agent-facing sections. */
function assertRequiredSections(text: string, command: string): void {
  expect(text, `${command}: must have Usage section`).toMatch(/Usage:/i)
  expect(text, `${command}: must have Examples section`).toMatch(/Examples:/i)
  expect(text, `${command}: must have exit codes`).toMatch(/Exit codes?:/i)
}

// ---------------------------------------------------------------------------
// Top-level help
// ---------------------------------------------------------------------------

describe("pithos --help (top-level)", () => {
  it("exits 0 with --help", async () => {
    const { exitCode } = await help(["--help"])
    expect(exitCode).toBe(0)
  })

  it("exits 0 with -h", async () => {
    const { exitCode } = await help(["-h"])
    expect(exitCode).toBe(0)
  })

  it("exits 0 with no args", async () => {
    const { exitCode } = await help([])
    expect(exitCode).toBe(0)
  })

  it("top-level help lists all commands", async () => {
    const { stdout } = await help(["--help"])
    // All MVP commands must appear by name
    const commands = [
      "init",
      "scope upsert",
      "run register",
      "run end",
      "heartbeat",
      "enqueue",
      "claim",
      "complete",
      "fail",
      "artifact add",
      "inspect",
      "briefing",
      "tail",
      "sweep",
    ]
    for (const cmd of commands) {
      expect(stdout, `top-level help must mention '${cmd}'`).toContain(cmd)
    }
  })

  it("top-level help lists all exit codes", async () => {
    const { stdout } = await help(["--help"])
    expect(stdout).toContain("Exit codes")
    expect(stdout).toContain("0")
    expect(stdout).toContain("1")
    expect(stdout).toContain("2")
    expect(stdout).toContain("3")
    expect(stdout).toContain("4")
    expect(stdout).toContain("5")
  })

  it("top-level help lists all environment variables", async () => {
    const { stdout } = await help(["--help"])
    const envVars = [
      "PITHOS_DB",
      "PITHOS_RUN_ID",
      "PITHOS_TASK_ID",
      "PITHOS_FENCING_TOKEN",
      "PITHOS_SCOPE_ID",
      "PITHOS_OUTPUT",
    ]
    for (const v of envVars) {
      expect(stdout, `top-level help must mention ${v}`).toContain(v)
    }
  })

  it("top-level help matches snapshot", async () => {
    const { stdout } = await help(["--help"])
    expect(stdout).toMatchSnapshot()
  })
})

// ---------------------------------------------------------------------------
// pithos init --help
// ---------------------------------------------------------------------------

describe("pithos init --help", () => {
  it("exits 0", async () => {
    const { exitCode } = await help(["init", "--help"])
    expect(exitCode).toBe(0)
  })

  it("shows init-specific help, not top-level", async () => {
    const { stdout } = await help(["init", "--help"])
    expect(stdout).toContain("pithos init")
  })

  it("contains required sections", async () => {
    const { stdout } = await help(["init", "--help"])
    assertRequiredSections(stdout, "init --help")
  })

  it("matches snapshot", async () => {
    const { stdout } = await help(["init", "--help"])
    expect(stdout).toMatchSnapshot()
  })
})

// ---------------------------------------------------------------------------
// pithos scope --help / scope upsert --help
// ---------------------------------------------------------------------------

describe("pithos scope --help", () => {
  it("exits 0", async () => {
    const { exitCode } = await help(["scope", "--help"])
    expect(exitCode).toBe(0)
  })

  it("lists scope subcommands", async () => {
    const { stdout } = await help(["scope", "--help"])
    expect(stdout).toContain("upsert")
  })

  it("matches snapshot", async () => {
    const { stdout } = await help(["scope", "--help"])
    expect(stdout).toMatchSnapshot()
  })

  it("exits 0 for scope upsert --help", async () => {
    const { exitCode } = await help(["scope", "upsert", "--help"])
    expect(exitCode).toBe(0)
  })

  it("scope upsert shows its own help (not namespace overview)", async () => {
    const { stdout: namespace } = await help(["scope", "--help"])
    const { stdout: sub } = await help(["scope", "upsert", "--help"])
    expect(namespace).not.toBe(sub)
    expect(sub).toContain("pithos scope upsert")
  })

  it("contains required sections", async () => {
    const { stdout } = await help(["scope", "upsert", "--help"])
    assertRequiredSections(stdout, "scope upsert --help")
  })

  it("scope upsert --help matches snapshot", async () => {
    const { stdout } = await help(["scope", "upsert", "--help"])
    expect(stdout).toMatchSnapshot()
  })
})

// ---------------------------------------------------------------------------
// pithos run --help / run register / run end
// ---------------------------------------------------------------------------

describe("pithos run --help", () => {
  it("exits 0", async () => {
    const { exitCode } = await help(["run", "--help"])
    expect(exitCode).toBe(0)
  })

  it("lists run subcommands", async () => {
    const { stdout } = await help(["run", "--help"])
    expect(stdout).toContain("register")
    expect(stdout).toContain("end")
  })

  it("matches snapshot", async () => {
    const { stdout } = await help(["run", "--help"])
    expect(stdout).toMatchSnapshot()
  })

  it("run register --help exits 0", async () => {
    const { exitCode } = await help(["run", "register", "--help"])
    expect(exitCode).toBe(0)
  })

  it("run register shows its own help (not namespace overview)", async () => {
    const { stdout: namespace } = await help(["run", "--help"])
    const { stdout: sub } = await help(["run", "register", "--help"])
    expect(namespace).not.toBe(sub)
    expect(sub).toContain("pithos run register")
  })

  it("run register --help contains required sections", async () => {
    const { stdout } = await help(["run", "register", "--help"])
    assertRequiredSections(stdout, "run register --help")
  })

  it("run register --help matches snapshot", async () => {
    const { stdout } = await help(["run", "register", "--help"])
    expect(stdout).toMatchSnapshot()
  })

  it("run end --help exits 0", async () => {
    const { exitCode } = await help(["run", "end", "--help"])
    expect(exitCode).toBe(0)
  })

  it("run end shows its own help (not namespace overview)", async () => {
    const { stdout: namespace } = await help(["run", "--help"])
    const { stdout: sub } = await help(["run", "end", "--help"])
    expect(namespace).not.toBe(sub)
    expect(sub).toContain("pithos run end")
  })

  it("run end --help contains required sections", async () => {
    const { stdout } = await help(["run", "end", "--help"])
    assertRequiredSections(stdout, "run end --help")
  })

  it("run end --help matches snapshot", async () => {
    const { stdout } = await help(["run", "end", "--help"])
    expect(stdout).toMatchSnapshot()
  })
})

// ---------------------------------------------------------------------------
// pithos enqueue --help
// ---------------------------------------------------------------------------

describe("pithos enqueue --help", () => {
  it("exits 0", async () => {
    const { exitCode } = await help(["enqueue", "--help"])
    expect(exitCode).toBe(0)
  })

  it("contains required sections", async () => {
    const { stdout } = await help(["enqueue", "--help"])
    assertRequiredSections(stdout, "enqueue --help")
  })

  it("matches snapshot", async () => {
    const { stdout } = await help(["enqueue", "--help"])
    expect(stdout).toMatchSnapshot()
  })
})

// ---------------------------------------------------------------------------
// pithos claim --help
// ---------------------------------------------------------------------------

describe("pithos claim --help", () => {
  it("exits 0", async () => {
    const { exitCode } = await help(["claim", "--help"])
    expect(exitCode).toBe(0)
  })

  it("mentions fencing_token", async () => {
    const { stdout } = await help(["claim", "--help"])
    expect(stdout).toContain("fencing_token")
  })

  it("contains required sections", async () => {
    const { stdout } = await help(["claim", "--help"])
    assertRequiredSections(stdout, "claim --help")
  })

  it("matches snapshot", async () => {
    const { stdout } = await help(["claim", "--help"])
    expect(stdout).toMatchSnapshot()
  })
})

// ---------------------------------------------------------------------------
// pithos heartbeat --help
// ---------------------------------------------------------------------------

describe("pithos heartbeat --help", () => {
  it("exits 0", async () => {
    const { exitCode } = await help(["heartbeat", "--help"])
    expect(exitCode).toBe(0)
  })

  it("mentions throttle-seconds", async () => {
    const { stdout } = await help(["heartbeat", "--help"])
    expect(stdout).toContain("throttle-seconds")
  })

  it("contains required sections", async () => {
    const { stdout } = await help(["heartbeat", "--help"])
    assertRequiredSections(stdout, "heartbeat --help")
  })

  it("matches snapshot", async () => {
    const { stdout } = await help(["heartbeat", "--help"])
    expect(stdout).toMatchSnapshot()
  })
})

// ---------------------------------------------------------------------------
// pithos complete --help
// ---------------------------------------------------------------------------

describe("pithos complete --help", () => {
  it("exits 0", async () => {
    const { exitCode } = await help(["complete", "--help"])
    expect(exitCode).toBe(0)
  })

  it("mentions fencing token requirement", async () => {
    const { stdout } = await help(["complete", "--help"])
    expect(stdout).toContain("--token")
  })

  it("contains required sections", async () => {
    const { stdout } = await help(["complete", "--help"])
    assertRequiredSections(stdout, "complete --help")
  })

  it("matches snapshot", async () => {
    const { stdout } = await help(["complete", "--help"])
    expect(stdout).toMatchSnapshot()
  })
})

// ---------------------------------------------------------------------------
// pithos fail --help
// ---------------------------------------------------------------------------

describe("pithos fail --help", () => {
  it("exits 0", async () => {
    const { exitCode } = await help(["fail", "--help"])
    expect(exitCode).toBe(0)
  })

  it("mentions fencing token requirement", async () => {
    const { stdout } = await help(["fail", "--help"])
    expect(stdout).toContain("--token")
  })

  it("contains required sections", async () => {
    const { stdout } = await help(["fail", "--help"])
    assertRequiredSections(stdout, "fail --help")
  })

  it("matches snapshot", async () => {
    const { stdout } = await help(["fail", "--help"])
    expect(stdout).toMatchSnapshot()
  })
})

// ---------------------------------------------------------------------------
// pithos artifact --help / artifact add --help
// ---------------------------------------------------------------------------

describe("pithos artifact --help", () => {
  it("exits 0", async () => {
    const { exitCode } = await help(["artifact", "--help"])
    expect(exitCode).toBe(0)
  })

  it("lists artifact subcommands", async () => {
    const { stdout } = await help(["artifact", "--help"])
    expect(stdout).toContain("add")
  })

  it("matches snapshot", async () => {
    const { stdout } = await help(["artifact", "--help"])
    expect(stdout).toMatchSnapshot()
  })

  it("artifact add --help exits 0", async () => {
    const { exitCode } = await help(["artifact", "add", "--help"])
    expect(exitCode).toBe(0)
  })

  it("artifact add shows its own help (not namespace overview)", async () => {
    const { stdout: namespace } = await help(["artifact", "--help"])
    const { stdout: sub } = await help(["artifact", "add", "--help"])
    expect(namespace).not.toBe(sub)
    expect(sub).toContain("pithos artifact add")
  })

  it("artifact add --help contains required sections", async () => {
    const { stdout } = await help(["artifact", "add", "--help"])
    assertRequiredSections(stdout, "artifact add --help")
  })

  it("artifact add --help matches snapshot", async () => {
    const { stdout } = await help(["artifact", "add", "--help"])
    expect(stdout).toMatchSnapshot()
  })
})

// ---------------------------------------------------------------------------
// pithos inspect --help
// ---------------------------------------------------------------------------

describe("pithos inspect --help", () => {
  it("exits 0", async () => {
    const { exitCode } = await help(["inspect", "--help"])
    expect(exitCode).toBe(0)
  })

  it("inspect scope --help exits 0", async () => {
    const { exitCode } = await help(["inspect", "scope", "--help"])
    expect(exitCode).toBe(0)
  })

  it("inspect run --help exits 0", async () => {
    const { exitCode } = await help(["inspect", "run", "--help"])
    expect(exitCode).toBe(0)
  })

  it("inspect task --help exits 0", async () => {
    const { exitCode } = await help(["inspect", "task", "--help"])
    expect(exitCode).toBe(0)
  })

  it("contains required sections", async () => {
    const { stdout } = await help(["inspect", "--help"])
    assertRequiredSections(stdout, "inspect --help")
  })

  it("matches snapshot", async () => {
    const { stdout } = await help(["inspect", "--help"])
    expect(stdout).toMatchSnapshot()
  })
})

// ---------------------------------------------------------------------------
// pithos tail --help
// ---------------------------------------------------------------------------

describe("pithos tail --help", () => {
  it("exits 0", async () => {
    const { exitCode } = await help(["tail", "--help"])
    expect(exitCode).toBe(0)
  })

  it("contains required sections", async () => {
    const { stdout } = await help(["tail", "--help"])
    assertRequiredSections(stdout, "tail --help")
  })

  it("matches snapshot", async () => {
    const { stdout } = await help(["tail", "--help"])
    expect(stdout).toMatchSnapshot()
  })
})

// ---------------------------------------------------------------------------
// pithos sweep --help
// ---------------------------------------------------------------------------

describe("pithos sweep --help", () => {
  it("exits 0", async () => {
    const { exitCode } = await help(["sweep", "--help"])
    expect(exitCode).toBe(0)
  })

  it("contains required sections", async () => {
    const { stdout } = await help(["sweep", "--help"])
    assertRequiredSections(stdout, "sweep --help")
  })

  it("matches snapshot", async () => {
    const { stdout } = await help(["sweep", "--help"])
    expect(stdout).toMatchSnapshot()
  })
})

// ---------------------------------------------------------------------------
// pithos briefing --help
// ---------------------------------------------------------------------------

describe("pithos briefing --help", () => {
  it("exits 0", async () => {
    const { exitCode } = await help(["briefing", "--help"])
    expect(exitCode).toBe(0)
  })

  it("contains required sections", async () => {
    const { stdout } = await help(["briefing", "--help"])
    assertRequiredSections(stdout, "briefing --help")
  })

  it("matches snapshot", async () => {
    const { stdout } = await help(["briefing", "--help"])
    expect(stdout).toMatchSnapshot()
  })
})

// ---------------------------------------------------------------------------
// Design principle: help is complete enough for an agent to act
// ---------------------------------------------------------------------------

describe("agent-usability invariants", () => {
  it("every command help mentions --help/-h option", async () => {
    const commands = [
      ["init", "--help"],
      // Namespace help pages
      ["scope", "--help"],
      ["run", "--help"],
      ["artifact", "--help"],
      // Leaf subcommand help pages
      ["scope", "upsert", "--help"],
      ["run", "register", "--help"],
      ["run", "end", "--help"],
      ["enqueue", "--help"],
      ["claim", "--help"],
      ["heartbeat", "--help"],
      ["complete", "--help"],
      ["fail", "--help"],
      ["artifact", "add", "--help"],
      ["inspect", "--help"],
      ["tail", "--help"],
      ["sweep", "--help"],
      ["briefing", "--help"],
    ]

    for (const args of commands) {
      const { stdout } = await help(args)
      expect(stdout, `${args.join(" ")}: must self-document --help/-h`).toMatch(/--help.*-h|-h.*--help/i)
    }
  })

  it("-h is equivalent to --help for all top-level commands", async () => {
    const commands = [
      { long: ["init", "--help"], short: ["init", "-h"] },
      { long: ["scope", "--help"], short: ["scope", "-h"] },
      { long: ["run", "--help"], short: ["run", "-h"] },
      { long: ["enqueue", "--help"], short: ["enqueue", "-h"] },
      { long: ["claim", "--help"], short: ["claim", "-h"] },
      { long: ["heartbeat", "--help"], short: ["heartbeat", "-h"] },
      { long: ["complete", "--help"], short: ["complete", "-h"] },
      { long: ["fail", "--help"], short: ["fail", "-h"] },
      { long: ["artifact", "--help"], short: ["artifact", "-h"] },
      { long: ["inspect", "--help"], short: ["inspect", "-h"] },
      { long: ["tail", "--help"], short: ["tail", "-h"] },
      { long: ["sweep", "--help"], short: ["sweep", "-h"] },
      { long: ["briefing", "--help"], short: ["briefing", "-h"] },
    ]

    for (const { long, short } of commands) {
      const [longResult, shortResult] = await Promise.all([help(long), help(short)])
      expect(shortResult.stdout, `${short.join(" ")} must match ${long.join(" ")}`).toBe(
        longResult.stdout,
      )
      expect(shortResult.exitCode).toBe(0)
    }
  })
})
