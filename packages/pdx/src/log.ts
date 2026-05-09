import { Effect } from "effect";
import { FileSystem, Clock, SupervisorLog, type SupervisorLogService } from "./services.js";

export const makeSupervisorLog = (path: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const clock = yield* Clock;
		const service: SupervisorLogService = {
			write: (record) =>
				clock.nowIso.pipe(
					Effect.flatMap((ts) => {
						const full = { ts, ...record };
						return fs.appendFile(path, `${JSON.stringify(full)}\n`).pipe(Effect.as(full));
					}),
				),
		};
		return SupervisorLog.of(service);
	});
