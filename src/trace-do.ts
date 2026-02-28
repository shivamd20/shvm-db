import { DurableObject } from "cloudflare:workers";
import { TraceDOQueries } from "./sql/queries";
import type { TraceEvent } from "./trace-types";

const TRACE_RETENTION_MS = 2 * 60 * 60 * 1000; // 2 hours

export interface Env {
	TRACE_DO: DurableObjectNamespace<TraceDO>;
}

export class TraceDO extends DurableObject<Env> {
	sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		this.sql.exec(TraceDOQueries.Schema.CREATE_EVENTS);
	}

	async recordEvent(event: TraceEvent): Promise<void> {
		const now = Date.now();
		this.sql.exec(
			TraceDOQueries.Events.INSERT,
			event.requestId,
			event.step,
			event.startMs,
			event.durationMs,
			event.parent ?? null,
			event.attributes ? JSON.stringify(event.attributes) : null,
			now
		);
		this.evictOldTraces(now - TRACE_RETENTION_MS);
	}

	async recordEvents(events: TraceEvent[]): Promise<void> {
		const now = Date.now();
		for (const e of events) {
			this.sql.exec(
				TraceDOQueries.Events.INSERT,
				e.requestId,
				e.step,
				e.startMs,
				e.durationMs,
				e.parent ?? null,
				e.attributes ? JSON.stringify(e.attributes) : null,
				now
			);
		}
		this.evictOldTraces(now - TRACE_RETENTION_MS);
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
		return rows.map(r => ({
			requestId: r.request_id,
			step: r.step,
			startMs: r.start_ms,
			durationMs: r.duration_ms,
			parent: r.parent ?? undefined,
			attributes: r.attributes ? JSON.parse(r.attributes) : undefined
		}));
	}
}
