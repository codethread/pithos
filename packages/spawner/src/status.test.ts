import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "vitest"
import { renderStatus } from "./status.ts"

const priorPiRoot = process.env.PANDORA_SPAWN_PI_SESSIONS_ROOT
const priorClaudeRoot = process.env.PANDORA_SPAWN_CLAUDE_SESSIONS_ROOT

afterEach(() => {
  if (priorPiRoot === undefined) delete process.env.PANDORA_SPAWN_PI_SESSIONS_ROOT
  else process.env.PANDORA_SPAWN_PI_SESSIONS_ROOT = priorPiRoot

  if (priorClaudeRoot === undefined) delete process.env.PANDORA_SPAWN_CLAUDE_SESSIONS_ROOT
  else process.env.PANDORA_SPAWN_CLAUDE_SESSIONS_ROOT = priorClaudeRoot
})

test("renderStatus auto-detects Pi session logs", () => {
  const root = mkdtempSync(join(tmpdir(), "pandora-pi-status-"))
  const sessionId = "session-pi-test"
  const bucket = join(root, "--tmp-example--")
  const path = join(bucket, `${sessionId}.jsonl`)
  mkdirSync(bucket, { recursive: true })
  writeFileSync(
    path,
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: "2026-05-05T12:00:00.000Z",
        cwd: "/tmp/example",
      }),
      JSON.stringify({
        type: "message",
        id: "aaaabbbb",
        parentId: null,
        timestamp: "2026-05-05T12:00:01.000Z",
        message: { role: "user", content: "begin" },
      }),
      JSON.stringify({
        type: "message",
        id: "bbbbcccc",
        parentId: "aaaabbbb",
        timestamp: "2026-05-05T12:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "COMPLETION REPORT\nall done" }],
        },
      }),
    ].join("\n") + "\n",
  )

  process.env.PANDORA_SPAWN_PI_SESSIONS_ROOT = root
  process.env.PANDORA_SPAWN_CLAUDE_SESSIONS_ROOT = mkdtempSync(join(tmpdir(), "pandora-claude-status-"))

  expect(renderStatus(sessionId, 10)).toContain("COMPLETION REPORT all done")
})
