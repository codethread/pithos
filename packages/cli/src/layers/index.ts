// Live layers
export { ClockServiceLive } from "./clock.ts";
export { IdServiceLive } from "./ids.ts";
export { FsServiceLive } from "./fs.ts";
export { ProcessServiceLive } from "./process.ts";
export { DbServiceLive, makeDbServiceLive } from "./db.ts";
export { ClaudeHarnessServiceLive } from "./harness.ts";
export { OutputServiceLive, makeOutputServiceTest, makeOutputServiceSilent } from "./output.ts";
export type { OutputCapture } from "./output.ts";
export { LoggerLive, LoggerSilent, makeLogCapture } from "./logger.ts";
export type { LogEntry, LogCapture } from "./logger.ts";
export {
	tasksClaimedCounter,
	heartbeatsWrittenCounter,
	heartbeatsThrottledCounter,
	staleTokensHeartbeatCounter,
	staleTokensCompleteCounter,
	staleTokensFailCounter,
	sweepRequeuedCounter,
	sweepDeadLetteredCounter,
	commandDurationTimer,
	withCommandObservability,
} from "./metrics.ts";

// Test factory functions
export { makeClockServiceTest } from "./clock.ts";
export { makeIdServiceTest } from "./ids.ts";
export { makeFsServiceTest } from "./fs.ts";
export { makeProcessServiceTest } from "./process.ts";
export { makeDbServiceTest } from "./db.ts";
export { makeClaudeHarnessServiceTest } from "./harness.ts";
