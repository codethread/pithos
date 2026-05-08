export interface RegistryEntry {
  readonly runId: string
  readonly taskId?: string
  readonly sessionId?: string
  readonly agent: string
  readonly scopeId: string
  readonly mode: string
  readonly logicalName: string
  readonly tmuxTarget?: string
  readonly pid?: number
  readonly state: "launching" | "live" | "terminating"
}

export interface DaemonState {
  readonly daemon: {
    readonly running: boolean
    readonly home: string
    readonly pid: number
    readonly tmuxTarget: string
    readonly startedAt: string
    readonly socketPath: string
    readonly systemRunId: string
    readonly intervalSeconds: number
  }
  readonly registry: readonly RegistryEntry[]
  readonly queue: {
    readonly claimable: readonly unknown[]
  }
  readonly caps: {
    readonly maxAfk: number
    readonly afkInUse: number
  }
  readonly recent: readonly {
    readonly ts: string
    readonly level: string
    readonly span: string
    readonly msg: string
  }[]
}

export interface DaemonRequest {
  readonly type: "status" | "shutdown"
}

export type DaemonResponse =
  | {
      readonly ok: true
      readonly state?: DaemonState
    }
  | {
      readonly ok: false
      readonly error: {
        readonly message: string
      }
    }
