import { Effect } from "effect";
import { PdxError } from "./errors.js";
import {
	LifecycleReporter,
	type ClockService,
	type LifecycleEvent,
	type LifecycleReporterService,
} from "./services.js";

const green = "\u001b[32m";
const yellow = "\u001b[33m";
const red = "\u001b[31m";
const dim = "\u001b[2m";
const reset = "\u001b[0m";
const monthNames = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
] as const;

const padTwo = (value: number): string => String(value).padStart(2, "0");

const parseLifecycleClock = (nowIso: string): Effect.Effect<Date, PdxError> =>
	Effect.gen(function* () {
		const now = new Date(nowIso);
		if (Number.isNaN(now.getTime())) {
			return yield* Effect.fail(
				new PdxError({
					code: "PROCESS_ERROR",
					message: `clock provided invalid lifecycle pulse timestamp: ${nowIso}`,
				}),
			);
		}
		return now;
	});

const formatLifecycleTimestamp = (now: Date): string =>
	`[${monthNames[now.getUTCMonth()]} ${now.getUTCDate()} ${padTwo(now.getUTCHours())}:${padTwo(now.getUTCMinutes())}]`;

export const formatLifecycleEvent = (now: Date, event: LifecycleEvent): string => {
	const timestamp = formatLifecycleTimestamp(now);
	switch (event.kind) {
		case "spawned":
			return `${timestamp} ${green}spawn${reset} ${event.agent} ${dim}${event.mode}${reset} run=${event.runId} scope=${event.scopeId} session=${event.sessionId}`;
		case "removed":
			return `${timestamp} ${red}remove${reset} ${event.agent} ${dim}${event.reason}${reset} run=${event.runId} scope=${event.scopeId}`;
		case "nudge": {
			const reasonLabel =
				event.reason === "task_dead_lettered_alert"
					? "task-dead-lettered"
					: event.reason === "task_failed_alert"
						? "task-failed"
						: "claimable-escalate";
			return `${timestamp} ${yellow}nudge${reset} pandora ${dim}${reasonLabel}${reset} target=${event.target} claimable-escalate=${event.claimableEscalateCount}`;
		}
		case "error":
			return `${timestamp} ${red}error${reset} ${event.span} ${dim}attempt=${event.attempt}/${event.maxAttempts}${reset} ${event.message}`;
	}
};

export const makeNoopLifecycleReporter = (): LifecycleReporterService => ({
	report: () => Effect.void,
});

export const makeStdoutLifecycleReporter = (clock: ClockService): LifecycleReporterService => ({
	report: (event) =>
		clock.nowIso.pipe(
			Effect.flatMap(parseLifecycleClock),
			Effect.flatMap((now) =>
				Effect.sync(() => void process.stdout.write(`${formatLifecycleEvent(now, event)}\n`)),
			),
		),
});

export const reportLifecycle = (event: LifecycleEvent) =>
	LifecycleReporter.pipe(Effect.flatMap((reporter) => reporter.report(event)));
