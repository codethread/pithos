import { Context, type Effect } from "effect";
import type { PithosError } from "../errors/errors.ts";

export interface ClaudeSpawnOptions {
	readonly agent: string;
	readonly appendSystemPrompt?: string;
	readonly model?: string;
	readonly sessionId?: string;
	readonly env?: Record<string, string>;
}

export interface ClaudeSpawnResult {
	readonly sessionId: string;
	readonly pid: number;
}

/**
 * Injectable interface for fake/real Claude execution.
 * Live implementation added in task 18 (fake Claude harness).
 */
export class ClaudeHarnessService extends Context.Tag("@pithos/ClaudeHarnessService")<
	ClaudeHarnessService,
	{
		readonly spawn: (options: ClaudeSpawnOptions) => Effect.Effect<ClaudeSpawnResult, PithosError>;
	}
>() {}
