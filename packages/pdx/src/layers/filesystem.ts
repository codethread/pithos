import { Effect, Layer } from "effect"
import { mkdir, readdir, readFile, rm } from "node:fs/promises"
import { PdxError } from "../errors.ts"
import { FileSystem } from "../services/filesystem.ts"

const userError = (message: string): PdxError =>
  new PdxError({ code: "USER_ERROR", message })

export const FileSystemLive: Layer.Layer<FileSystem> = Layer.succeed(FileSystem, {
  makeDirectory: (path, options) =>
    Effect.tryPromise({
      try: () => mkdir(path, { recursive: options?.recursive === true }),
      catch: (error) => userError(`Failed to create directory ${path}: ${String(error)}`),
    }),
  readDirectory: (path) =>
    Effect.tryPromise({
      try: () => readdir(path),
      catch: (error) => userError(`Failed to read directory ${path}: ${String(error)}`),
    }),
  readFileString: (path) =>
    Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (error) => userError(`Failed to read file ${path}: ${String(error)}`),
    }),
  removeFile: (path) =>
    Effect.tryPromise({
      try: () => rm(path, { force: true }),
      catch: (error) => userError(`Failed to remove file ${path}: ${String(error)}`),
    }),
})
