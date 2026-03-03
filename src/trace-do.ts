import { DurableObject } from "cloudflare:workers";
import { TraceDOQueries } from "./sql/queries";
import { runTraceDOMigrations } from "./sql/migrations";
import type { TraceEvent } from "./trace-types";

const TRACE_RETENTION_MS = 2 * 60 * 60 * 1000; // 2 hours
const TRACE_FLUSH_DELAY_MS = 2000;
/** SQLite bind param limit can be lower in some runtimes (99 parameters); 7 params per row -> chunk at 10 */
const TRACE_INSERT_CHUNK_SIZE = 10;

export interface Env {
	TRACE_DO: DurableObjectNamespace<TraceDO>;
}

export class TraceDO extends DurableObject<Env> {
	sql: SqlStorage;
	private pendingEvents: TraceEvent[] = [];

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		runTraceDOMigrations(this.sql);
	}

	private scheduleFlushAlarm(): void {
		this.ctx.storage.setAlarm(Date.now() + TRACE_FLUSH_DELAY_MS);
	}

	async alarm(): Promise<void> {
		const snapshot = this.pendingEvents;
		this.pendingEvents = [];
		if (snapshot.length === 0) return;

		const now = Date.now();
		try {
			for (let off = 0; off < snapshot.length; off += TRACE_INSERT_CHUNK_SIZE) {
				const chunk = snapshot.slice(off, off + TRACE_INSERT_CHUNK_SIZE);
				const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
				const sql = `INSERT INTO trace_events (request_id, step, start_ms, duration_ms, parent, attributes, created_at) VALUES ${placeholders}`;
				const params: (string | number | null)[] = [];
				for (const e of chunk) {
					params.push(
						e.requestId,
						e.step,
						e.startMs,
						e.durationMs,
						e.parent ?? null,
						e.attributes ? JSON.stringify(e.attributes) : null,
						now
					);
				}
				this.sql.exec(sql, ...params);
			}
			this.evictOldTraces(now - TRACE_RETENTION_MS);
		} catch (err) {
			this.pendingEvents.push(...snapshot);
			this.scheduleFlushAlarm();
			console.error("[TraceDO] alarm flush failed, re-queued", snapshot.length, "events", err);
		}

		if (this.pendingEvents.length > 0) this.scheduleFlushAlarm();
	}

	async recordEvent(event: TraceEvent): Promise<void> {
		this.pendingEvents.push(event);
		const currentAlarm = await this.ctx.storage.getAlarm();
		if (currentAlarm == null) this.scheduleFlushAlarm();
	}

	async recordEvents(events: TraceEvent[]): Promise<void> {
		this.pendingEvents.push(...events);
		const currentAlarm = await this.ctx.storage.getAlarm();
		if (currentAlarm == null) this.scheduleFlushAlarm();
	}

	private evictOldTraces(olderThanMs: number): void {
		try {
			this.sql.exec(TraceDOQueries.Events.DELETE_OLDER_THAN, olderThanMs);
		} catch (_) {
			// ignore
		}
	}

	async getTrace(requestId: string): Promise<TraceEvent[]> {
		this.evictOldTraces(Date.now() - TRACE_RETENTION_MS);
		const cursor = this.sql.exec(TraceDOQueries.Events.GET_BY_REQUEST, requestId);
		const rows = Array.from(cursor) as any[];
		const fromDb = rows.map(r => ({
			requestId: r.request_id,
			step: r.step,
			startMs: r.start_ms,
			durationMs: r.duration_ms,
			parent: r.parent ?? undefined,
			attributes: r.attributes ? JSON.parse(r.attributes) : undefined
		}));
		const fromPending = this.pendingEvents.filter(e => e.requestId === requestId);
		const combined = [...fromDb, ...fromPending];
		combined.sort((a, b) => a.startMs - b.startMs);
		return combined;
	}
}
