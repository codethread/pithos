import { Effect, Layer } from "effect"
import { ClaudeHarnessService } from "../services/harness.ts"
import type { ClaudeSpawnResult } from "../services/harness.ts"
import { PithosError } from "../errors/errors.ts"

/** Placeholder live layer — replaced by real harness in task 18. */
export const ClaudeHarnessServiceLive: Layer.Layer<ClaudeHarnessService> = Layer.succeed(
  ClaudeHarnessService,
  {
    spawn: () =>
      Effect.fail(
        new PithosError({
          code: "USER_ERROR",
          message: "ClaudeHarnessService not yet implemented — added in task 18.",
        }),
      ),
  },
)

export const makeClaudeHarnessServiceTest = (
  result: ClaudeSpawnResult,
): Layer.Layer<ClaudeHarnessService> =>
  Layer.succeed(ClaudeHarnessService, {
    spawn: () => Effect.succeed(result),
  })
