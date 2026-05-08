import { Context, type Effect } from "effect";
import type { PithosError } from "../errors/errors.ts";

export type DbRow = Record<string, unknown>;

/**
 * DB service — wraps @effect/sql-sqlite-node with a stable interface so
 * commands depend only on this tag and the live/test layer can be swapped.
 *
 * All mutation commands (INSERT/UPDATE/DELETE) without RETURNING use `run`.
 * Queries and RETURNING mutations use `query` (returns rows).
 * Related operations that must be atomic use `withTransaction`.
 */
export class DbService extends Context.Tag("@pithos/DbService")<
	DbService,
	{
		readonly query: (
			sql: string,
			params?: readonly unknown[],
		) => Effect.Effect<readonly DbRow[], PithosError>;
		readonly run: (sql: string, params?: readonly unknown[]) => Effect.Effect<void, PithosError>;
		/**
		 * Execute effectful DB operations inside a single transaction.
		 * Any `Effect.fail` inside the body causes a full rollback.
		 * The transaction-scoped SQL client is threaded automatically.
		 */
		readonly withTransaction: <A, E>(
			effect: Effect.Effect<A, E>,
		) => Effect.Effect<A, E | PithosError>;
	}
>() {}
