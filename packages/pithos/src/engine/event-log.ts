import { Effect, Either, ParseResult, Schema } from "effect";
import type { Db } from "../db.js";
import { sql } from "../db.js";
import { fail } from "../errors.js";
import { decodeRow, EventRowSchema } from "../rows.js";
import { withCollisionGuard, withDb } from "./db-helpers.js";
import type { EngineContext, Json } from "./types.js";

const HEARTBEAT_EVENT_TYPES = ["run.heartbeat", "task.heartbeat"] as const;

const eventPayload = sql`
INSERT INTO events(
	id, type, task_id, run_id, actor_run_id, payload_json
) VALUES (
	?,?,?,?,?,?
)
`;

export const event = (
	ctx: EngineContext,
	db: Db,
	type: string,
	payload: { task_id?: string; run_id?: string; actor_run_id?: string; payload: Json },
): void => {
	const eventId = Effect.runSync(ctx.services.ids.make("event"));
	withCollisionGuard(eventId, () =>
		db
			.prepare(eventPayload)
			.run(
				eventId,
				type,
				payload.task_id ?? null,
				payload.run_id ?? null,
				payload.actor_run_id ?? null,
				JSON.stringify(payload.payload),
			),
	);
};

const EventPayloadSchema = Schema.parseJson(Schema.Unknown);

const decodeEventPayload = (payloadJson: string, eventId: string): Json => {
	const decoded = Schema.decodeUnknownEither(EventPayloadSchema)(payloadJson);
	return Either.match(decoded, {
		onLeft: (error) =>
			fail(
				"INTERNAL_ERROR",
				`malformed event payload_json for ${eventId}: ${ParseResult.TreeFormatter.formatErrorSync(error)}`,
			),
		onRight: (payload) => payload as Json,
	});
};

export const eventsTail = (ctx: EngineContext, limit: number | undefined) =>
	withDb(ctx, (db) => {
		if (limit !== undefined && limit < 1) fail("VALIDATION_ERROR", "--limit must be positive");
		const rows = db
			.prepare(
				sql`
				SELECT id,type,task_id,run_id,actor_run_id,payload_json,created_at
				FROM events
				ORDER BY created_at DESC, id DESC
				LIMIT ?
				`,
			)
			.all(limit ?? 100)
			.map((row) => decodeRow(EventRowSchema, row, "malformed event row"));
		return {
			ok: true as const,
			events: rows.reverse().map((row) => ({
				id: row.id,
				type: row.type,
				task_id: row.task_id,
				run_id: row.run_id,
				actor_run_id: row.actor_run_id,
				payload: decodeEventPayload(row.payload_json, row.id),
				created_at: row.created_at,
			})),
		};
	});

const requirePositiveInteger = (value: number, name: string): number => {
	if (!Number.isSafeInteger(value) || value < 1) {
		fail("VALIDATION_ERROR", `${name} must be a positive integer`);
	}
	return value;
};

const toDbTimestamp = (date: Date): string =>
	date
		.toISOString()
		.replace("T", " ")
		.replace(/\.\d{3}Z$/, "");

export const pruneEvents = (
	ctx: EngineContext,
	input: { heartbeatOlderThanDays?: number; otherOlderThanDays?: number } | undefined,
) =>
	withDb(ctx, (db) => {
		const heartbeatOlderThanDays = requirePositiveInteger(
			input?.heartbeatOlderThanDays ?? 1,
			"heartbeatOlderThanDays",
		);
		const otherOlderThanDays = requirePositiveInteger(
			input?.otherOlderThanDays ?? 7,
			"otherOlderThanDays",
		);
		const nowIso = Effect.runSync(ctx.services.clock.nowIso());
		const now = new Date(nowIso);
		if (Number.isNaN(now.getTime())) {
			fail("INTERNAL_ERROR", `clock returned invalid ISO timestamp: ${nowIso}`);
		}
		const heartbeatCutoff = toDbTimestamp(
			new Date(now.getTime() - heartbeatOlderThanDays * 24 * 60 * 60 * 1000),
		);
		const otherCutoff = toDbTimestamp(
			new Date(now.getTime() - otherOlderThanDays * 24 * 60 * 60 * 1000),
		);
		const deleted = db.transaction(() => {
			const deletedHeartbeat = db
				.prepare(sql`DELETE FROM events WHERE type IN (?, ?) AND created_at < ?`)
				.run(HEARTBEAT_EVENT_TYPES[0], HEARTBEAT_EVENT_TYPES[1], heartbeatCutoff).changes;
			const deletedOther = db
				.prepare(sql`DELETE FROM events WHERE type NOT IN (?, ?) AND created_at < ?`)
				.run(HEARTBEAT_EVENT_TYPES[0], HEARTBEAT_EVENT_TYPES[1], otherCutoff).changes;
			return { deletedHeartbeat, deletedOther };
		})();
		return {
			ok: true as const,
			deleted_heartbeat: deleted.deletedHeartbeat,
			deleted_other: deleted.deletedOther,
		};
	});
