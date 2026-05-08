import { homedir } from "node:os"
import { join, resolve } from "node:path"

export const DEFAULT_HOME = join(homedir(), ".pandora")
export const DAEMON_TARGET = "pdx--daemon"
export const SYSTEM_RUN_ID = "run_pdx_system"
export const SYSTEM_SESSION_ID = "session_pdx_daemon"

export const resolveHome = (home: string | undefined): string =>
  resolve(process.cwd(), home ?? DEFAULT_HOME)
export const socketPath = (home: string): string => join(home, "pdx.sock")
export const statePath = (home: string): string => join(home, "pdx-state.json")
export const logPath = (home: string): string => join(home, "pdx.jsonl")
export const runsDir = (home: string): string => join(home, "runs")
