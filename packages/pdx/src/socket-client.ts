import net from "node:net"
import { Effect } from "effect"
import { PdxError } from "./errors.ts"
import type { DaemonRequest, DaemonResponse } from "./daemon-state.ts"

export const sendDaemonRequest = (
  path: string,
  request: DaemonRequest,
): Effect.Effect<DaemonResponse, PdxError> =>
  Effect.async<DaemonResponse, PdxError>((resume) => {
    const client = net.createConnection(path)
    let body = ""
    client.setEncoding("utf8")

    client.on("connect", () => {
      client.write(JSON.stringify(request) + "\n")
    })
    client.on("data", (chunk: string | Buffer) => {
      body += typeof chunk === "string" ? chunk : chunk.toString("utf8")
    })
    client.on("end", () => {
      try {
        const parsed = JSON.parse(body) as DaemonResponse
        if (parsed.ok !== true) {
          resume(
            Effect.fail(
              new PdxError({
                code: "USER_ERROR",
                message: parsed.error.message,
              }),
            ),
          )
          return
        }
        resume(Effect.succeed(parsed))
      } catch (error) {
        resume(
          Effect.fail(
            new PdxError({ code: "USER_ERROR", message: `Invalid daemon response: ${String(error)}` }),
          ),
        )
      }
    })
    client.on("error", (error) => {
      resume(
        Effect.fail(new PdxError({ code: "USER_ERROR", message: `Failed to connect to daemon: ${String(error)}` })),
      )
    })

    return Effect.sync(() => client.destroy())
  })
