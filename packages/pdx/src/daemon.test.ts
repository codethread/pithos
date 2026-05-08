import { describe, expect, it } from "vitest"
import { spawn } from "node:child_process"
import { probePidLive } from "./daemon.ts"

describe("probePidLive", () => {
  it("returns true for a live pid and false after exit", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], {
      stdio: "ignore",
    })

    expect(typeof child.pid).toBe("number")
    expect(probePidLive(child.pid!)).toBe(true)

    child.kill("SIGTERM")
    await new Promise((resolve) => child.once("exit", resolve))

    expect(probePidLive(child.pid!)).toBe(false)
  })
})
