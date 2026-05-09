import { Data } from "effect";

export type PdxErrorCode =
	| "VALIDATION_ERROR"
	| "CONFIG_ERROR"
	| "IPC_ERROR"
	| "PROCESS_ERROR"
	| "FS_ERROR";

export class PdxError extends Data.TaggedError("PdxError")<{
	readonly code: PdxErrorCode;
	readonly message: string;
}> {}
