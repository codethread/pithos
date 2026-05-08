import { Effect, Layer } from "effect"
import { OutputService } from "../services/output.ts"

export const OutputServiceLive: Layer.Layer<OutputService> = Layer.succeed(OutputService, {
  print: (line) => Effect.sync(() => {
    process.stdout.write(line + "\n")
  }),
  printError: (line) => Effect.sync(() => {
    process.stderr.write(line + "\n")
  }),
})
