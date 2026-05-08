import { Data } from "effect";

export type ErrorCode =
	| "USER_ERROR"
	| "VALIDATION_ERROR"
	| "NOT_FOUND"
	| "STALE_TOKEN"
	| "STALE_TOKEN_RACE"
	| "NO_CLAIMABLE_WORK"
	| "INTERNAL_ERROR";

export class PithosError extends Data.TaggedError("PithosError")<{
	readonly code: ErrorCode;
	readonly message: string;
}> {}

export const exitCodeFor = (code: ErrorCode): number => {
	switch (code) {
		case "USER_ERROR":
		case "INTERNAL_ERROR":
			return 1;
		case "VALIDATION_ERROR":
			return 2;
		case "NOT_FOUND":
			return 3;
		case "STALE_TOKEN":
		case "STALE_TOKEN_RACE":
			return 4;
		case "NO_CLAIMABLE_WORK":
			return 5;
	}
};

export const fail = (code: ErrorCode, message: string): never => {
	throw new PithosError({ code, message });
};
