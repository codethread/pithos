import { Schema } from "effect"

export const HarnessNameValues = ["claude", "pi"] as const
export const HarnessNameSchema = Schema.Literal(...HarnessNameValues)
export type HarnessName = Schema.Schema.Type<typeof HarnessNameSchema>
