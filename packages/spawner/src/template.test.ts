import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { SpawnerError } from "./errors.ts"
import { loadTemplate } from "./template.ts"

test("loadTemplate fails loudly when an agent manifest omits tools", () => {
  const dir = mkdtempSync(join(tmpdir(), "pandora-template-"))
  const agentsPath = join(dir, "agents.json")

  writeFileSync(
    agentsPath,
    JSON.stringify({
      agents: [
        {
          agent: "envy",
          model: "sonnet",
          type: "afk",
          system_prompt: "envy.md.tmpl",
        },
      ],
    }),
  )
  writeFileSync(join(dir, "envy.md.tmpl"), "hello")

  let caught: unknown
  try {
    loadTemplate(agentsPath, dir, "envy")
  } catch (error: unknown) {
    caught = error
  }

  expect(caught).toBeInstanceOf(SpawnerError)
  const error = caught as SpawnerError
  expect(error.code).toBe("VALIDATION_ERROR")
  expect(error.message).toContain(agentsPath)
  expect(error.message).toContain("tools")
})
