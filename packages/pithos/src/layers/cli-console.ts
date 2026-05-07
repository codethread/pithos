import * as EffectConsole from "effect/Console"
import { Effect } from "effect"
import { inspect } from "node:util"

interface ConsoleEntry {
  readonly stream: "stdout" | "stderr"
  readonly text: string
}

export interface CliConsoleCapture {
  readonly layer: ReturnType<typeof EffectConsole.setConsole>
  readonly clear: () => void
  readonly flushToProcess: () => void
}

const formatArgs = (args: readonly unknown[]): string =>
  args
    .map((arg) => (typeof arg === "string" ? arg : inspect(arg, { colors: true, depth: null })))
    .join(" ")

export const makeCliConsoleCapture = (): CliConsoleCapture => {
  const entries: ConsoleEntry[] = []

  const capture = (stream: ConsoleEntry["stream"], args: readonly unknown[]): Effect.Effect<void> =>
    Effect.sync(() => {
      entries.push({ stream, text: formatArgs(args) })
    })

  const unsafeWrite = (stream: ConsoleEntry["stream"], args: readonly unknown[]): void => {
    const handle = stream === "stdout" ? process.stdout : process.stderr
    handle.write(formatArgs(args) + "\n")
  }

  const unsafeConsole: EffectConsole.UnsafeConsole = {
    assert: (condition, ...args) => {
      if (!condition) {
        unsafeWrite("stderr", args)
      }
    },
    clear: () => undefined,
    count: () => undefined,
    countReset: () => undefined,
    debug: (...args) => unsafeWrite("stderr", args),
    dir: (item) => unsafeWrite("stdout", [inspect(item, { colors: true, depth: null })]),
    dirxml: (...args) => unsafeWrite("stdout", args),
    error: (...args) => unsafeWrite("stderr", args),
    group: (...args) => unsafeWrite("stdout", args),
    groupCollapsed: (...args) => unsafeWrite("stdout", args),
    groupEnd: () => undefined,
    info: (...args) => unsafeWrite("stdout", args),
    log: (...args) => unsafeWrite("stdout", args),
    table: () => unsafeWrite("stdout", ["[console.table omitted]"]),
    time: () => undefined,
    timeEnd: () => undefined,
    timeLog: (_label, ...args) => unsafeWrite("stdout", args),
    trace: (...args) => unsafeWrite("stderr", args),
    warn: (...args) => unsafeWrite("stderr", args),
  }

  const consoleService: EffectConsole.Console = {
    [EffectConsole.TypeId]: EffectConsole.TypeId,
    assert: (condition, ...args) => (condition ? Effect.void : capture("stderr", args)),
    clear: Effect.void,
    count: () => Effect.void,
    countReset: () => Effect.void,
    debug: (...args) => capture("stderr", args),
    dir: (item) => capture("stdout", [inspect(item, { colors: true, depth: null })]),
    dirxml: (...args) => capture("stdout", args),
    error: (...args) => capture("stderr", args),
    group: (options) =>
      options?.label === undefined ? Effect.void : capture("stdout", [options.label]),
    groupEnd: Effect.void,
    info: (...args) => capture("stdout", args),
    log: (...args) => capture("stdout", args),
    table: () => capture("stdout", ["[console.table omitted]"]),
    time: () => Effect.void,
    timeEnd: () => Effect.void,
    timeLog: (_label, ...args) => capture("stdout", args),
    trace: (...args) => capture("stderr", args),
    warn: (...args) => capture("stderr", args),
    unsafe: unsafeConsole,
  }

  const clear = (): void => {
    entries.length = 0
  }

  const flushToProcess = (): void => {
    for (const entry of entries) {
      const stream = entry.stream === "stdout" ? process.stdout : process.stderr
      stream.write(entry.text + "\n")
    }
    clear()
  }

  return {
    layer: EffectConsole.setConsole(consoleService),
    clear,
    flushToProcess,
  }
}
