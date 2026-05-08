import { Effect, ParseResult, Schema } from "effect"
import { AgentClaimRow, AgentEnqueueRow } from "@pithos/pithos/src/db/rows.ts"
import type { DbRow } from "@pithos/pithos/src/services/db.ts"
import { DbService } from "@pithos/pithos/src/services/db.ts"
import type { AgentManifest } from "./template.ts"
import { SpawnerError } from "./errors.ts"

const validationError = (message: string): SpawnerError =>
  new SpawnerError({ code: "VALIDATION_ERROR", message })

const decodeRows = <A, I>(
  schema: Schema.Schema<A, I>,
  rows: readonly DbRow[],
  label: string,
): Effect.Effect<readonly A[], SpawnerError> =>
  Effect.forEach(rows, (row) =>
    Schema.decodeUnknown(schema)(row).pipe(
      Effect.mapError((error) =>
        validationError(`${label} row shape violation\n${ParseResult.TreeFormatter.formatErrorSync(error)}`),
      ),
    ),
  )

const csv = (capabilities: readonly string[]): string =>
  [...capabilities].sort((left, right) => left.localeCompare(right)).join(", ")

const assertCapabilitySetMatches = (
  agent: AgentManifest["agent"],
  label: "claims" | "enqueues",
  actual: readonly string[],
  expected: readonly string[],
): Effect.Effect<void, SpawnerError> => {
  const actualCsv = csv(actual)
  const expectedCsv = csv(expected)

  if (actualCsv === expectedCsv) {
    return Effect.void
  }

  return Effect.fail(
    validationError(
      `${agent} manifest ${label} mismatch; expected [${expectedCsv}] but got [${actualCsv}]`,
    ),
  )
}

export const validateManifestAgainstSeedRows = (
  manifest: AgentManifest,
): Effect.Effect<void, SpawnerError, DbService> =>
  Effect.gen(function* () {
    const db = yield* DbService
    const claimRows = yield* db.query(
      `SELECT agent_kind, capability, created_at
       FROM agent_claims
       WHERE agent_kind = ?
       ORDER BY capability ASC`,
      [manifest.agent],
    ).pipe(
      Effect.mapError((error) => validationError(error.message)),
      Effect.flatMap((rows) => decodeRows(AgentClaimRow, rows, "agent_claims")),
    )
    const enqueueRows = yield* db.query(
      `SELECT agent_kind, capability, created_at
       FROM agent_enqueues
       WHERE agent_kind = ?
       ORDER BY capability ASC`,
      [manifest.agent],
    ).pipe(
      Effect.mapError((error) => validationError(error.message)),
      Effect.flatMap((rows) => decodeRows(AgentEnqueueRow, rows, "agent_enqueues")),
    )

    yield* assertCapabilitySetMatches(
      manifest.agent,
      "claims",
      manifest.claims,
      claimRows.map((row) => row.capability),
    )
    yield* assertCapabilitySetMatches(
      manifest.agent,
      "enqueues",
      manifest.enqueues,
      enqueueRows.map((row) => row.capability),
    )
  })
