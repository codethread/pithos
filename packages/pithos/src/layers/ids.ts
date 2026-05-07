import { Effect, Layer } from "effect"
import { IdService } from "../services/ids.ts"

export const IdServiceLive: Layer.Layer<IdService> = Layer.succeed(IdService, {
  generate: (prefix) =>
    Effect.sync(() => {
      const unique = crypto.randomUUID().replace(/-/g, "").slice(0, 16)
      return `${prefix}_${unique}`
    }),
})

export const makeIdServiceTest = (predefined: readonly string[]): Layer.Layer<IdService> => {
  let counter = 0
  return Layer.succeed(IdService, {
    generate: (prefix) =>
      Effect.sync(() => {
        const id = predefined[counter] ?? `${prefix}_${String(counter)}`
        counter += 1
        return id
      }),
  })
}
