import { Data } from "effect"

export type ErrorCode =
  | "USER_ERROR"
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "STALE_TOKEN"
  | "NO_CLAIMABLE_WORK"
  | "INTERNAL_ERROR"

export class PithosError extends Data.TaggedError("PithosError")<{
  readonly code: ErrorCode
  readonly message: string
}> {}

export const exitCodeFor = (code: ErrorCode): number => {
  switch (code) {
    case "USER_ERROR":
      return 1
    case "VALIDATION_ERROR":
      return 2
    case "NOT_FOUND":
      return 3
    case "STALE_TOKEN":
      return 4
    case "NO_CLAIMABLE_WORK":
      return 5
    case "INTERNAL_ERROR":
      return 1
  }
}
