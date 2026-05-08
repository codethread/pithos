import { describe, expect, it } from "vitest"
import { spawn } from "node:child_process"
import { Effect } from "effect"
import { ProcessServiceLive } from "./layers/process.ts"
import { ProcessService } from "./services/process.ts"

describe("ProcessService.probePid", () => {
  it("returns true for a live pid and false after exit", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], {
      stdio: "ignore",
    })

    expect(typeof child.pid).toBe("number")

    const live = await Effect.runPromise(
      ProcessService.pipe(
        Effect.flatMap((process) => process.probePid(child.pid!)),
        Effect.provide(ProcessServiceLive),
      ),
    )
    expect(live).toBe(true)

    child.kill("SIGTERM")
    await new Promise((resolve) => child.once("exit", resolve))

    const dead = await Effect.runPromise(
      ProcessService.pipe(
        Effect.flatMap((process) => process.probePid(child.pid!)),
        Effect.provide(ProcessServiceLive),
      ),
    )
    expect(dead).toBe(false)
  })

  it("fails loudly on non-ESRCH probe errors", async () => {
    const originalKill = process.kill.bind(process)
    process.kill = (pid: number, signal?: number | NodeJS.Signals) => {
      if (signal === 0) {
        const error = new Error("permission denied") as NodeJS.ErrnoException
        error.code = "EPERM"
        throw error
      }
      return originalKill(pid, signal)
    }

    try {
      let failure: unknown
      try {
        await Effect.runPromise(
          ProcessService.pipe(
            Effect.flatMap((process) => process.probePid(12345)),
            Effect.provide(ProcessServiceLive),
          ),
        )
      } catch (error) {
        failure = error
      }

      expect(String(failure)).toContain("Failed to probe pid 12345")
      expect(String(failure)).toContain("permission denied")
    } finally {
      process.kill = originalKill
    }
  })
})
