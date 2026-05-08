import { NodeContext } from "@effect/platform-node"
import { makeDbServiceTest } from "@pithos/pithos/src/layers/db.ts"
import { Effect, Layer } from "effect"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { validateManifestAgainstSeedRows } from "./capability-matrix.ts"
import { renderAgent } from "./harness.ts"
import { makeTemplatePaths } from "./template.ts"

const claimQuery = `SELECT agent_kind, capability, created_at
       FROM agent_claims
       WHERE agent_kind = ?
       ORDER BY capability ASC`

const enqueueQuery = `SELECT agent_kind, capability, created_at
       FROM agent_enqueues
       WHERE agent_kind = ?
       ORDER BY capability ASC`

const provideTemplatePaths = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  agentsPath: string,
  templatesDir: string,
) =>
  effect.pipe(
    Effect.provide(Layer.mergeAll(NodeContext.layer, makeTemplatePaths({ agentsPath, templatesDir }))),
  )

const writeAgentFixture = (
  manifest: Record<string, unknown>,
  templateBody = "claim: {{claim_command}}",
): { readonly agentsPath: string; readonly templatesDir: string } => {
  const templatesDir = mkdtempSync(join(tmpdir(), "pandora-spawn-template-"))
  const agentsPath = join(templatesDir, "agents.json")

  writeFileSync(agentsPath, JSON.stringify({ agents: [manifest] }, null, 2))
  writeFileSync(join(templatesDir, String(manifest.template)), templateBody)

  return { agentsPath, templatesDir }
}

test("manifest validation rejects claim mismatch against seeded Pithos rows", async () => {
  const effect = validateManifestAgainstSeedRows({
    agent: "war",
    mode: "afk",
    claims: ["design"],
    enqueues: ["escalate"],
    harness: { kind: "claude" },
    template: "war.md.tmpl",
  }).pipe(
    Effect.provide(
      makeDbServiceTest(
        new Map([
          [claimQuery, [{ agent_kind: "war", capability: "execute", created_at: "2026-05-07T00:00:00Z" }]],
          [enqueueQuery, [{ agent_kind: "war", capability: "escalate", created_at: "2026-05-07T00:00:00Z" }]],
        ]),
      ),
    ),
  )

  await expect(Effect.runPromise(effect)).rejects.toThrow("manifest claims mismatch")
})

test("renderAgent enforces claims.length === 1", async () => {
  const fixture = writeAgentFixture({
    agent: "war",
    mode: "afk",
    claims: ["execute", "design"],
    enqueues: ["escalate"],
    harness: { kind: "claude" },
    template: "war.md.tmpl",
  })

  await expect(
    Effect.runPromise(
      provideTemplatePaths(
        renderAgent({
          agent: "war",
          mode: "afk",
          runId: "run_TEST",
          sessionId: "session_TEST",
          scopeId: "repo:work/example",
          cwd: "/tmp/example",
        }),
        fixture.agentsPath,
        fixture.templatesDir,
      ),
    ),
  ).rejects.toThrow("must declare exactly one claim")
})

test("renderAgent derives distinct logical names from distinct session ids", async () => {
  const fixture = writeAgentFixture({
    agent: "greed",
    mode: "hitl",
    claims: ["design"],
    enqueues: ["triage", "design", "escalate"],
    harness: { kind: "pi" },
    template: "greed.md.tmpl",
  })

  const first = await Effect.runPromise(
    provideTemplatePaths(
      renderAgent({
        agent: "greed",
        mode: "hitl",
        runId: "run_TEST",
        sessionId: "session_alpha",
        scopeId: "global",
        cwd: "/tmp/example",
      }),
      fixture.agentsPath,
      fixture.templatesDir,
    ),
  )
  const second = await Effect.runPromise(
    provideTemplatePaths(
      renderAgent({
        agent: "greed",
        mode: "hitl",
        runId: "run_TEST",
        sessionId: "session_beta",
        scopeId: "global",
        cwd: "/tmp/example",
      }),
      fixture.agentsPath,
      fixture.templatesDir,
    ),
  )

  expect(first.logicalName).not.toBe(second.logicalName)
})

test("manifest validation rejects enqueue mismatch against seeded Pithos rows", async () => {
  const effect = validateManifestAgainstSeedRows({
    agent: "pandora",
    mode: "hitl",
    claims: ["escalate"],
    enqueues: ["escalate"],
    harness: { kind: "pi" },
    template: "pandora.md.tmpl",
  }).pipe(
    Effect.provide(
      makeDbServiceTest(
        new Map([
          [claimQuery, [{ agent_kind: "pandora", capability: "escalate", created_at: "2026-05-07T00:00:00Z" }]],
          [
            enqueueQuery,
            [
              { agent_kind: "pandora", capability: "triage", created_at: "2026-05-07T00:00:00Z" },
              { agent_kind: "pandora", capability: "design", created_at: "2026-05-07T00:00:00Z" },
              { agent_kind: "pandora", capability: "escalate", created_at: "2026-05-07T00:00:00Z" },
            ],
          ],
        ]),
      ),
    ),
  )

  await expect(Effect.runPromise(effect)).rejects.toThrow("manifest enqueues mismatch")
})
