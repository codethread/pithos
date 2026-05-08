import { Data } from "effect";

export type ErrorCode = "VALIDATION_ERROR" | "NOT_FOUND" | "UPSTREAM_ERROR";

export class SpawnerError extends Data.TaggedError("SpawnerError")<{
	readonly code: ErrorCode;
	readonly message: string;
}> {}

export const exitCodeFor = (code: ErrorCode): number => {
	switch (code) {
		case "VALIDATION_ERROR":
			return 2;
		case "NOT_FOUND":
			return 3;
		case "UPSTREAM_ERROR":
			return 1;
	}
};
