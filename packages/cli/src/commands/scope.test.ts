/**
 * Unit tests for pithos scope. Integration coverage lives in test/scope.integration.test.ts.
 */

import { describe, it, expect } from "vitest"
import { Effect, Exit, Layer } from "effect"
import { join } from "node:path"
import { homedir } from "node:os"

import { canonicalizePath, deriveScopeId, nameFromPath } from "../domain/scope.ts"
import { scopeUpsertCommand } from "./scope.ts"
import { inspectScopeCommand } from "./inspect.ts"
import { makeDbServiceTest } from "../layers/db.ts"
import { makeOutputServiceSilent } from "../layers/output.ts"

const silentOutput = makeOutputServiceSilent()

async function runEffect<A, E>(
  effect: Effect.Effect<A, E, never>,
): Promise<Exit.Exit<A, E>> {
  return Effect.runPromiseExit(effect)
}

// ---------------------------------------------------------------------------
// 1. Pure domain helpers
// ---------------------------------------------------------------------------

describe("canonicalizePath", () => {
  it("expands leading ~/ to homedir", () => {
    const result = canonicalizePath("~/work/foo")
    expect(result).toBe(join(homedir(), "work/foo"))
  })

  it("expands bare ~ to homedir", () => {
    const result = canonicalizePath("~")
    expect(result).toBe(homedir())
  })

  it("leaves absolute paths unchanged (modulo resolve normalisation)", () => {
    const result = canonicalizePath("/absolute/path/to/repo")
    expect(result).toBe("/absolute/path/to/repo")
  })

  it("normalises an absolute path with redundant segments", () => {
    const result = canonicalizePath("/opt/../opt/projects/my-repo")
    expect(result).toBe("/opt/projects/my-repo")
  })

  it("normalises a trailing slash on absolute path", () => {
    const result = canonicalizePath("/opt/projects/my-repo/")
    expect(result).toBe("/opt/projects/my-repo")
  })
})

describe("deriveScopeId", () => {
  it("produces repo:<home-relative-path> for paths inside $HOME", () => {
    const absPath = join(homedir(), "work/perkbox-services/protobuf")
    expect(deriveScopeId("repo", absPath)).toBe("repo:work/perkbox-services/protobuf")
  })

  it("produces worktree:<home-relative-path> for worktree kind", () => {
    const absPath = join(homedir(), "work/perkbox-services/protobuf__feature")
    expect(deriveScopeId("worktree", absPath)).toBe(
      "worktree:work/perkbox-services/protobuf__feature",
    )
  })

  it("uses absolute path (without leading /) for paths outside $HOME", () => {
    const absPath = "/opt/projects/my-repo"
    const result = deriveScopeId("repo", absPath)
    expect(result).toBe("repo:opt/projects/my-repo")
  })

  it("is stable — same inputs produce the same ID", () => {
    const absPath = join(homedir(), "work/some/repo")
    expect(deriveScopeId("repo", absPath)).toBe(deriveScopeId("repo", absPath))
  })
})

describe("nameFromPath", () => {
  it("returns the basename", () => {
    expect(nameFromPath("/home/user/work/perkbox/protobuf")).toBe("protobuf")
    expect(nameFromPath("/home/user/work/perkbox")).toBe("perkbox")
  })
})

// ---------------------------------------------------------------------------
// 2. Unit — command logic with fake DB
// ---------------------------------------------------------------------------

describe("scopeUpsertCommand (unit — fake DB)", () => {
  it("succeeds for kind=global with no path", async () => {
    const exit = await runEffect(
      Effect.provide(
        scopeUpsertCommand({ kind: "global", path: undefined }),
        Layer.merge(makeDbServiceTest(), silentOutput),
      ),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  it("succeeds for kind=repo with a path", async () => {
    const exit = await runEffect(
      Effect.provide(
        scopeUpsertCommand({ kind: "repo", path: "~/work/my-repo" }),
        Layer.merge(makeDbServiceTest(), silentOutput),
      ),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  it("fails with VALIDATION_ERROR when kind=repo and no path", async () => {
    const exit = await runEffect(
      Effect.provide(
        scopeUpsertCommand({ kind: "repo", path: undefined }),
        Layer.merge(makeDbServiceTest(), silentOutput),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    // Verify it's a failure — full cause inspection done in integration tests
  })
})

describe("inspectScopeCommand (unit — fake DB)", () => {
  it("fails with NOT_FOUND when scope is absent", async () => {
    const exit = await runEffect(
      Effect.provide(inspectScopeCommand("repo:missing"), Layer.merge(makeDbServiceTest(), silentOutput)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

