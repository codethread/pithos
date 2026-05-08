import { runDaemon } from "../daemon.ts"

export const daemonRunCommand = (options: {
  readonly home: string
  readonly intervalSeconds: number
  readonly maxAfk: number
}) => runDaemon({
  home: options.home,
  intervalSeconds: options.intervalSeconds,
  maxAfk: options.maxAfk,
})
