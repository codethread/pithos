import { Data } from "effect";

export type PdxErrorCode =
	| "VALIDATION_ERROR"
	| "CONFIG_ERROR"
	| "IPC_ERROR"
	| "PROCESS_ERROR"
	| "HARNESS_ERROR"
	| "LAUNCH_ERROR"
	| "FS_ERROR"
	| "HOOK_OUTPUT_OVERFLOW"
	| "USER_ERROR"
	| "NOT_FOUND"
	| "STALE_TOKEN"
	| "STALE_TOKEN_RACE"
	| "NO_CLAIMABLE_WORK"
	| "ID_COLLISION"
	| "INTERNAL_ERROR";

export class PdxError extends Data.TaggedError("PdxError")<{
	readonly code: PdxErrorCode;
	readonly message: string;
}> {}
