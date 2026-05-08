import { Data } from "effect"

export type ErrorCode =
  | "USER_ERROR"
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "INTERNAL_ERROR"

export class PdxError extends Data.TaggedError("PdxError")<{
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
    case "INTERNAL_ERROR":
      return 1
  }
}
