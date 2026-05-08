import { Effect, Either, ParseResult, Schema } from "effect"
import { SpawnerError } from "./errors.ts"

const PithosBinSchema = Schema.NonEmptyString
const rawPithosBin = process.env.PITHOS_BIN ?? "pithos"
const decodedPithosBin = Schema.decodeUnknownEither(PithosBinSchema)(rawPithosBin)

export const getPithosBin: Effect.Effect<string, SpawnerError> = Either.isLeft(decodedPithosBin)
  ? Effect.fail(
      new SpawnerError({
        code: "VALIDATION_ERROR",
        message:
          "Invalid PITHOS_BIN configuration\n" +
          ParseResult.TreeFormatter.formatErrorSync(decodedPithosBin.left),
      }),
    )
  : Effect.succeed(decodedPithosBin.right)
