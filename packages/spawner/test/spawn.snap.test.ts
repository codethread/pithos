import { execFileSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"

test("envy spawn renders deterministic prompt + argv (fake harness)", () => {
  execFileSync("pnpm", ["run", "build"], { stdio: "ignore" })
  const db = join(mkdtempSync(join(tmpdir(), "pandora-spawn-")), "pithos.sqlite")
  const env = { ...process.env, PITHOS_DB: db, PANDORA_SPAWN_FAKE_SESSION_ID: "session-TEST" }
  execFileSync("pithos", ["init"], { env, stdio: "ignore" })
  execFileSync("pithos", ["scope", "upsert", "--kind", "repo", "--path", join(homedir(), "work", "example")], { env, stdio: "ignore" })
  const out = execFileSync("pandora-spawn", [
    "--agent",
    "envy",
    "--scope",
    "repo:work/example",
    "--cwd",
    "/tmp/example",
    "--harness",
    "fake",
  ], { env }).toString()
  const parsed = JSON.parse(out) as Record<string, unknown>
  const runId = parsed.run_id
  if (typeof runId !== "string") throw new Error("missing run_id")
  const text = JSON.stringify(parsed).replaceAll(runId, "run_SNAPSHOT")
  expect(JSON.parse(text)).toMatchSnapshot()
}, 30_000)
