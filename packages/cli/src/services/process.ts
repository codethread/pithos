import { Context, type Effect } from "effect";
import type { PithosError } from "../errors/errors.ts";

export interface ProcessResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

export class ProcessService extends Context.Tag("@pithos/ProcessService")<
	ProcessService,
	{
		readonly exec: (
			command: string,
			args: readonly string[],
			options?: {
				readonly env?: Record<string, string>;
				readonly cwd?: string;
			},
		) => Effect.Effect<ProcessResult, PithosError>;
	}
>() {}
