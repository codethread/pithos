import { Data } from "effect"

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "TEMPLATE_ERROR"
  | "HARNESS_ERROR"
  | "LAUNCH_ERROR"

export class SpawnerError extends Data.TaggedError("SpawnerError")<{
  readonly code: ErrorCode
  readonly message: string
}> {}

export const exitCodeFor = (code: ErrorCode): number => {
  switch (code) {
    case "VALIDATION_ERROR":
    case "TEMPLATE_ERROR":
      return 2
    case "HARNESS_ERROR":
    case "LAUNCH_ERROR":
      return 1
  }
}
