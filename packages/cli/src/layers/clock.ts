import { Effect, Layer } from "effect";
import { ClockService } from "../services/clock.ts";

export const ClockServiceLive: Layer.Layer<ClockService> = Layer.succeed(ClockService, {
	now: Effect.sync(() => new Date()),
	nowIso: Effect.sync(() => new Date().toISOString()),
});

export const makeClockServiceTest = (fixedDate: Date): Layer.Layer<ClockService> =>
	Layer.succeed(ClockService, {
		now: Effect.succeed(fixedDate),
		nowIso: Effect.succeed(fixedDate.toISOString()),
	});
