import { Effect, Layer } from "effect"
import * as fsPromises from "node:fs/promises"
import { FsService } from "../services/fs.ts"
import { PithosError } from "../errors/errors.ts"

const isEnoent = (e: unknown): boolean =>
  e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT"

const toFsError =
  (path: string, op: string) =>
  (e: unknown): PithosError =>
    new PithosError({ code: "USER_ERROR", message: `FS ${op} failed for ${path}: ${String(e)}` })

export const FsServiceLive: Layer.Layer<FsService> = Layer.succeed(FsService, {
  readFile: (path) =>
    Effect.tryPromise({
      try: () => fsPromises.readFile(path, "utf-8"),
      catch: (e) =>
        isEnoent(e)
          ? new PithosError({ code: "NOT_FOUND", message: `File not found: ${path}` })
          : new PithosError({
              code: "USER_ERROR",
              message: `FS readFile failed for ${path}: ${String(e)}`,
            }),
    }),
  writeFile: (path, content) =>
    Effect.tryPromise({
      try: () => fsPromises.writeFile(path, content, "utf-8"),
      catch: toFsError(path, "writeFile"),
    }),
  exists: (path) =>
    Effect.promise(() =>
      fsPromises
        .access(path)
        .then(() => true)
        .catch(() => false),
    ),
  mkdir: (path, options) =>
    Effect.tryPromise({
      try: () => fsPromises.mkdir(path, options).then(() => undefined),
      catch: toFsError(path, "mkdir"),
    }),
})

export const makeFsServiceTest = (
  initial: ReadonlyMap<string, string> = new Map(),
): Layer.Layer<FsService> => {
  const store = new Map(initial)
  const dirs = new Set<string>()

  return Layer.succeed(FsService, {
    readFile: (path) =>
      Effect.suspend(() => {
        const content = store.get(path)
        return content !== undefined
          ? Effect.succeed(content)
          : Effect.fail(
              new PithosError({ code: "NOT_FOUND", message: `File not found: ${path}` }),
            )
      }),
    writeFile: (path, content) =>
      Effect.sync(() => {
        store.set(path, content)
      }),
    exists: (path) => Effect.sync(() => store.has(path) || dirs.has(path)),
    mkdir: (path) =>
      Effect.sync(() => {
        dirs.add(path)
      }),
  })
}
