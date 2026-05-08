import { readFileSync, rmSync } from "node:fs"
import process from "node:process"

export interface FsService {
  readonly readText: (path: string) => string
  readonly removeFile: (path: string) => void
}

export interface OutputService {
  readonly write: (text: string) => void
  readonly writeError: (text: string) => void
}

export interface Services {
  readonly fs: FsService
  readonly output: OutputService
}

export const liveServices: Services = {
  fs: {
    readText: (path) => readFileSync(path, "utf8"),
    removeFile: (path) => rmSync(path, { force: true }),
  },
  output: {
    write: (text) => process.stdout.write(text),
    writeError: (text) => process.stderr.write(text),
  },
}
