import { Context, type Effect } from "effect";

export class IdService extends Context.Tag("@pithos/IdService")<
	IdService,
	{
		readonly generate: (prefix: string) => Effect.Effect<string>;
	}
>() {}
