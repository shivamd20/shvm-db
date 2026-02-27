/**
 * Observability ingestion for request and replication stages.
 * Writes to Workers Analytics Engine (WAE); fire-and-forget, no await.
 *
 * WAE schema (fixed order for SQL):
 * - index1: table name (data plane), "control" (control plane), or "replication" (queue). Sampling key.
 * - blob1: query_id (request) or replication_message_id (queue).
 * - blob2: stage_name.
 * - blob3: op (e.g. GetItem, PutItem, replication).
 * - blob4: cache (lru_hit | lru_miss | "").
 * - blob5: read_source (leader | replica_<id> | "").
 * - blob6: metadata_cache (kv_hit | kv_miss | "").
 * - blob7: bloom_filter (hit | miss | not_checked | "").
 * - blob8: routing_cache (hit | miss | "").
 * - blob9: replica_id (queue replica_apply_mutation; "" otherwise).
 * - double1, double2, double3: start_ts, end_ts, duration_ms.
 * Summary event: blob2 = "request_summary"; doubles = request_start_ts, request_end_ts, total_duration_ms.
 */

export interface RequestObsContext {
	queryId: string;
	requestStartTs: number;
	tableName?: string;
	op?: string;
}

export interface ReplicationObsContext {
	replicationMessageId: string;
	tableName: string;
	op: string;
}

export type ObsContext = RequestObsContext | ReplicationObsContext;

export function isRequestContext(ctx: ObsContext): ctx is RequestObsContext {
	return "queryId" in ctx && "requestStartTs" in ctx;
}

export interface StageExtraProps {
	cache?: "lru_hit" | "lru_miss";
	read_source?: string;
	metadata_cache?: "kv_hit" | "kv_miss";
	bloom_filter?: "hit" | "miss" | "not_checked";
	routing_cache?: "hit" | "miss";
	replica_id?: string;
}

export interface EnvWithObservability {
	OBSERVABILITY?: AnalyticsEngineDataset;
}

// Stage name constants for consistent SQL querying
export const STAGE = {
	PARSE_REQUEST: "parse_request",
	GET_TABLE_METADATA: "get_table_metadata",
	HASH_PARTITION_KEY: "hash_partition_key",
	INIT_LEADER: "init_leader",
	DO_PUT_ITEM: "do_put_item",
	DO_DELETE_ITEM: "do_delete_item",
	DO_UPDATE_ITEM: "do_update_item",
	GET_ROUTING_CONFIG: "get_routing_config",
	INIT_LEADER_READ: "init_leader_read",
	DO_GET_ITEM: "do_get_item",
	CREATE_TABLE: "create_table",
	DELETE_TABLE: "delete_table",
	LIST_TABLES: "list_tables",
	DESCRIBE_TABLE: "describe_table",
	REQUEST_SUMMARY: "request_summary",
	// PartitionDO
	PARTITION_REGISTER_REPLICA: "partition_register_replica",
	PARTITION_DEREGISTER_REPLICA: "partition_deregister_replica",
	PARTITION_GET_ROUTING: "partition_get_routing",
	PARTITION_REPORT_LOAD: "partition_report_load",
	PARTITION_CHECK_SCALING: "partition_check_scaling",
	// SubDO
	SUBDO_INIT_STORAGE: "subdo_init_storage",
	SUBDO_LOAD_STATE: "subdo_load_state",
	SUBDO_PUT_ITEM: "subdo_put_item",
	SUBDO_DELETE_ITEM: "subdo_delete_item",
	SUBDO_UPDATE_ITEM: "subdo_update_item",
	SUBDO_APPLY_MUTATION: "subdo_apply_mutation",
	SUBDO_GET_ITEM: "subdo_get_item",
	STREAM_HISTORY: "stream_history",
	START_BACKFILL: "start_backfill",
	PROVISION_REPLICA: "provision_replica",
	PROMOTE_TO_READABLE: "promote_to_readable",
	// Queue
	QUEUE_MESSAGE_RECEIVED: "queue_message_received",
	STANDBY_INIT: "standby_init",
	STANDBY_APPLY_MUTATION: "standby_apply_mutation",
	QUEUE_GET_ROUTING_CONFIG: "queue_get_routing_config",
	REPLICA_APPLY_MUTATION: "replica_apply_mutation",
} as const;

const EMPTY = "";

function indexForContext(ctx: ObsContext): string {
	if (isRequestContext(ctx)) {
		return ctx.tableName ?? "control";
	}
	return ctx.tableName || "replication";
}

function queryOrReplicationId(ctx: ObsContext): string {
	if (isRequestContext(ctx)) return ctx.queryId;
	return ctx.replicationMessageId;
}

function opForContext(ctx: ObsContext): string {
	return ctx.op ?? EMPTY;
}

export function recordStage(
	env: EnvWithObservability,
	ctx: ObsContext,
	stageName: string,
	startTs: number,
	endTs: number,
	extra?: StageExtraProps
): void {
	if (!env.OBSERVABILITY) return;
	const durationMs = endTs - startTs;
	env.OBSERVABILITY.writeDataPoint({
		indexes: [indexForContext(ctx)],
		blobs: [
			queryOrReplicationId(ctx),
			stageName,
			opForContext(ctx),
			extra?.cache ?? EMPTY,
			extra?.read_source ?? EMPTY,
			extra?.metadata_cache ?? EMPTY,
			extra?.bloom_filter ?? EMPTY,
			extra?.routing_cache ?? EMPTY,
			extra?.replica_id ?? EMPTY,
		],
		doubles: [startTs, endTs, durationMs],
	});
}

export function recordRequestSummary(
	env: EnvWithObservability,
	ctx: RequestObsContext,
	requestEndTs: number
): void {
	if (!env.OBSERVABILITY) return;
	const totalDurationMs = requestEndTs - ctx.requestStartTs;
	env.OBSERVABILITY.writeDataPoint({
		indexes: [ctx.tableName ?? "control"],
		blobs: [
			ctx.queryId,
			STAGE.REQUEST_SUMMARY,
			ctx.op ?? EMPTY,
			EMPTY,
			EMPTY,
			EMPTY,
			EMPTY,
			EMPTY,
			EMPTY,
		],
		doubles: [ctx.requestStartTs, requestEndTs, totalDurationMs],
	});
}

export interface RequestObserver {
	queryId: string;
	requestStartTs: number;
	tableName?: string;
	op?: string;
	recordStage(stageName: string, startTs: number, endTs: number, extra?: StageExtraProps): void;
	recordSummary(requestEndTs: number): void;
}

export function createRequestObserver(
	env: EnvWithObservability,
	queryId: string,
	requestStartTs: number,
	tableName?: string,
	op?: string
): RequestObserver {
	const obs: RequestObserver = {
		queryId,
		requestStartTs,
		tableName,
		op,
		recordStage(stageName, startTs, endTs, extra) {
			recordStage(env, { queryId, requestStartTs, tableName: obs.tableName, op: obs.op }, stageName, startTs, endTs, extra);
		},
		recordSummary(requestEndTs) {
			recordRequestSummary(env, { queryId, requestStartTs, tableName: obs.tableName, op: obs.op }, requestEndTs);
		},
	};
	return obs;
}
