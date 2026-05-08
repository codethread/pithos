import { Context, type Effect } from "effect";

export class ClockService extends Context.Tag("@pithos/ClockService")<
	ClockService,
	{
		readonly now: Effect.Effect<Date>;
		readonly nowIso: Effect.Effect<string>;
	}
>() {}
