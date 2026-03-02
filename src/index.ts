import { DurableObject } from "cloudflare:workers";
import { PartitionDO } from "./partition-do";
import { SubDO } from "./sub-do";
import { TableRegistryDO } from "./table-registry-do";
import { TraceDO } from "./trace-do";
import { validateItemAgainstSchema, ValidationError } from "./validation";
import { MetadataService } from "./metadata-service";
import { CreateTableInput, RoutingTable, ReplicationMessage, Role, TableMetadata } from "./types";
import { createLogger } from "./debug";
import type { TraceEvent } from "./trace-types";

export { PartitionDO, SubDO, TableRegistryDO, TraceDO };

export interface Env {
	PARTITION_DO: DurableObjectNamespace<PartitionDO>;
	SUB_DO: DurableObjectNamespace<SubDO>;
	TABLE_REGISTRY_DO: DurableObjectNamespace<TableRegistryDO>;
	TRACE_DO: DurableObjectNamespace<TraceDO>;
	TABLE_METADATA_CACHE: KVNamespace;
	REPLICATION_QUEUE: Queue;
	SHVM_DEBUG?: string;
}

const NUM_PARTITIONS = 100;
const TRACE_DO_SINGLETON_NAME = "shvm-db-trace";
const ROUTING_CACHE_MAX_SIZE = 1000;
const METADATA_CACHE_TTL_MS = 60_000;
const METADATA_CACHE_MAX_SIZE = 500;

const metadataCache = new Map<string, { metadata: TableMetadata; expiresAt: number }>();
const keySchemaCache = new Map<string, { pk: string; sk?: string }>();

function hashPartitionKey(pk: string, numPartitions: number): number {
	let hash = 5381;
	for (let i = 0; i < pk.length; i++) {
		hash = ((hash << 5) + hash + pk.charCodeAt(i)) >>> 0;
	}
	return hash % numPartitions;
}

function getRequestId(request: Request): string {
	return request.headers.get("x-request-id") ?? request.headers.get("x-amz-request-id") ?? crypto.randomUUID();
}

const validRoutingCache = new Map<string, RoutingTable>();

async function getOrSetRoutingCache(pKey: string, fetch: () => Promise<RoutingTable>): Promise<{ routing: RoutingTable; fromCache: boolean }> {
	const existing = validRoutingCache.get(pKey);
	if (existing !== undefined) return { routing: existing, fromCache: true };
	const routing = await fetch();
	if (validRoutingCache.size >= ROUTING_CACHE_MAX_SIZE) {
		const firstKey = validRoutingCache.keys().next().value;
		if (firstKey !== undefined) validRoutingCache.delete(firstKey);
	}
	validRoutingCache.set(pKey, routing);
	return { routing, fromCache: false };
}

type MetadataSource = "worker" | "kv" | "registry";

async function getTableMetadataCached(
	tableName: string,
	metadataService: MetadataService
): Promise<{ metadata: TableMetadata; source: MetadataSource }> {
	const now = Date.now();
	const entry = metadataCache.get(tableName);
	if (entry && entry.expiresAt > now) {
		return { metadata: entry.metadata, source: "worker" };
	}
	const result = await metadataService.getTableMetadata(tableName);
	const source: MetadataSource = result.fromCache ? "kv" : "registry";
	if (metadataCache.size >= METADATA_CACHE_MAX_SIZE) {
		let oldestKey: string | undefined;
		let oldest = Infinity;
		for (const [k, v] of metadataCache) {
			if (v.expiresAt < oldest) {
				oldest = v.expiresAt;
				oldestKey = k;
			}
		}
		if (oldestKey !== undefined) metadataCache.delete(oldestKey);
	}
	metadataCache.set(tableName, { metadata: result.metadata, expiresAt: now + METADATA_CACHE_TTL_MS });
	const pkDef = result.metadata.KeySchema.find(k => k.KeyType === "HASH");
	const skDef = result.metadata.KeySchema.find(k => k.KeyType === "RANGE");
	if (pkDef) {
		keySchemaCache.set(tableName, { pk: pkDef.AttributeName, sk: skDef?.AttributeName });
	}
	return { metadata: result.metadata, source };
}

function getRaw(v: any): string | undefined {
	const s = v?.S ?? v?.N ?? v?.B;
	return s != null ? String(s) : undefined;
}

function validateAndGetRawKey(v: any, attrName: string): string {
	if (v === undefined || v === null) throw new ValidationError("One of the required keys was not given a value");
	if (v.S === undefined && v.N === undefined && v.B === undefined) throw new ValidationError("One or more parameter values were invalid: Type mismatch for key");
	const val = v.S ?? v.N ?? v.B;
	if (val === "") throw new ValidationError(`One or more parameter values are not valid. The AttributeValue for a key attribute cannot contain an empty string value. Key: ${attrName}`);
	return String(val);
}

function buildTraceSummary(traceEvents: TraceEvent[], totalMs: number): string {
	const seg: Record<string, number> = { total_ms: totalMs };
	for (const e of traceEvents) {
		if (e.step === "request") continue;
		const key = e.step.replace(/-/g, "_") + "_ms";
		seg[key] = (seg[key] ?? 0) + e.durationMs;
	}
	return Object.entries(seg).map(([k, v]) => `${k}=${v}`).join(",");
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/api/trace") {
			const requestId = url.searchParams.get("requestId");
			if (!requestId) {
				return new Response(JSON.stringify({ error: "Missing requestId" }), { status: 400, headers: { "Content-Type": "application/json" } });
			}
			const traceStub = env.TRACE_DO.get(env.TRACE_DO.idFromName(TRACE_DO_SINGLETON_NAME));
			const events = await traceStub.getTrace(requestId);
			return new Response(JSON.stringify({ requestId, events }), {
				headers: { "Content-Type": "application/json" }
			});
		}

		if (url.pathname.startsWith("/api") || request.headers.has("x-amz-target")) {
			try {
				return await handleDynamoRequest(request, env, ctx);
			} catch (err: any) {
				const log = createLogger(env);
				if (err.name === "ValidationError" || err.message.includes("Validation") || err.message.includes("No defined key schema")) {
					log("router", `Validation err: ${err.message}`);
					return new Response(JSON.stringify({ __type: "ValidationException", message: err.message.replace(/^ValidationError: /, '').replace(/^Error: /, '') }), {
						status: 400,
						headers: { "Content-Type": "application/x-amz-json-1.0" }
					});
				}
				const type = err.message.includes("Cannot do operations on a non-existent table") || err.message.includes("ResourceNotFoundException") ? "ResourceNotFoundException"
					: err.message.includes("already exists") ? "ResourceInUseException"
						: "InternalServerError";
				const status = type === "ResourceNotFoundException" || type === "ResourceInUseException" ? 400 : 500;
				let displayMessage = err.message.replace(/^Error: /, '');
				if (type === "ResourceInUseException" && err.message.includes("already exists")) {
					displayMessage = "Cannot create preexisting table";
				}

				if (status === 500) {
					log.error("router", `Error: ${err?.message}`, err?.stack);
				} else {
					log("router", `Expected err [${type}]: ${displayMessage}`);
				}

				return new Response(JSON.stringify({ __type: type, message: displayMessage }), {
					status,
					headers: { "Content-Type": "application/x-amz-json-1.0" }
				});
			}
		}
		return new Response("Not Found", { status: 404 });
	},

	async queue(batch: MessageBatch<any>, env: Env): Promise<void> {
		const log = createLogger(env);
		const routingCache = new Map<string, RoutingTable>();

		const pKeys = [...new Set(batch.messages.map((m: any) => {
			const msg = m.body;
			const tableName = msg.tableName || "default";
			return `${tableName}::partition-${msg.partitionId}`;
		}))];

		await Promise.all(pKeys.map(async (pKey) => {
			if (routingCache.has(pKey)) return;
			const pStub = env.PARTITION_DO.get(env.PARTITION_DO.idFromName(pKey));
			const r = await pStub.getRoutingConfig();
			routingCache.set(pKey, r);
		}));

		const promises: Promise<void>[] = [];
		for (const message of batch.messages) {
			const msg = message.body;
			const pId = msg.partitionId;
			const tableName = msg.tableName || "default";
			const pKey = `${tableName}::partition-${pId}`;

			log("queue", `replication type=${msg.type} table=${tableName} partition=${pId} sk=${msg.sk} v=${msg.version}`);

			const standbyId = env.SUB_DO.idFromName(`${pKey}-standby`);
			const standbyStub = env.SUB_DO.get(standbyId);
			promises.push(standbyStub.init(Role.STANDBY).then(() => standbyStub.applyMutation(msg)));

			const routing = routingCache.get(pKey)!;
			const replicas = routing.replicas[pId] || [];
			log("queue", `partition ${pKey} replicas=${replicas.length}`);

			for (const rId of replicas) {
				const rStub = env.SUB_DO.get(env.SUB_DO.idFromString(rId));
				promises.push(rStub.applyMutation(msg));
			}
		}

		await Promise.allSettled(promises);
	},
} satisfies ExportedHandler<Env, ReplicationMessage>;

async function handleDynamoRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const log = createLogger(env);
	const requestId = getRequestId(request);
	const requestStartTs = Date.now();
	const target = request.headers.get("x-amz-target");
	if (!target) return new Response("Missing x-amz-target header", { status: 400 });

	const body = await request.json() as any;
	const op = target.split(".").pop() || "unknown";
	const metadataService = new MetadataService(env);

	const traceEvents: TraceEvent[] = [];
	const baseHeaders: Record<string, string> = {
		"Content-Type": "application/x-amz-json-1.0",
		"X-Request-Id": requestId,
		"X-SHIVAM-DB-OP": op || "unknown",
		"X-SHIVAM-DB-REQUEST-TS": String(requestStartTs),
	};

	function addEvent(step: string, startMs: number, durationMs: number, attributes?: Record<string, string | number | boolean>) {
		traceEvents.push({ requestId, step, startMs, durationMs, attributes });
	}

	function flushTrace() {
		if (traceEvents.length === 0) return;
		const traceStub = env.TRACE_DO.get(env.TRACE_DO.idFromName(TRACE_DO_SINGLETON_NAME));
		ctx.waitUntil(traceStub.recordEvents(traceEvents));
	}

	log("router", `op=${op} table=${body.TableName || "N/A"} requestId=${requestId}`);

	if (op === "CreateTable") {
		log("control", `CreateTable: ${body.TableName}`);
		const res = await metadataService.createTable(body as CreateTableInput);
		return new Response(JSON.stringify(res), { headers: baseHeaders });
	}
	if (op === "DeleteTable") {
		log("control", `DeleteTable: ${body.TableName}`);
		const res = await metadataService.deleteTable(body.TableName);
		metadataCache.delete(body.TableName);
		keySchemaCache.delete(body.TableName);
		return new Response(JSON.stringify(res), { headers: baseHeaders });
	}
	if (op === "ListTables") {
		const registry = env.TABLE_REGISTRY_DO.get(env.TABLE_REGISTRY_DO.idFromName("global-registry"));
		const tables = await registry.listTables(body.Limit, body.ExclusiveStartTableName);
		return new Response(JSON.stringify({ TableNames: tables }), { headers: baseHeaders });
	}
	if (op === "DescribeTable") {
		const { metadata } = await getTableMetadataCached(body.TableName, metadataService);
		return new Response(JSON.stringify({ Table: metadata }), { headers: baseHeaders });
	}

	const supportedDataOps = ["PutItem", "GetItem", "DeleteItem", "UpdateItem"];
	if (!supportedDataOps.includes(op)) {
		if (body.TableName) baseHeaders["X-SHIVAM-DB-TABLE"] = body.TableName;
		return new Response(JSON.stringify({ __type: "NotImplemented", message: `Operation ${op} not implemented` }), {
			status: 501,
			headers: baseHeaders
		});
	}

	const tableName = body.TableName;
	if (!tableName) throw new ValidationError("TableName is required");

	const keySchema = keySchemaCache.get(tableName);
	let metadata: TableMetadata;
	let metaSource: MetadataSource;
	let routing: RoutingTable;
	let routingCacheHit: boolean;
	let partitionId: number;
	let pKey: string;

	if (keySchema) {
		const pkVal = body.Key?.[keySchema.pk] ?? body.Item?.[keySchema.pk];
		const pkRaw = validateAndGetRawKey(pkVal, keySchema.pk);
		partitionId = hashPartitionKey(pkRaw, NUM_PARTITIONS);
		pKey = `${tableName}::partition-${partitionId}`;
		addEvent("hash_partition_key", 0, 0, { from_cache: true });
		if (op === "GetItem") {
			const parallelStart = Date.now() - requestStartTs;
			const [metaResult, routingResult] = await Promise.all([
				getTableMetadataCached(tableName, metadataService),
				getOrSetRoutingCache(pKey, () => env.PARTITION_DO.get(env.PARTITION_DO.idFromName(pKey)).getRoutingConfig(requestId))
			]);
			metadata = metaResult.metadata;
			metaSource = metaResult.source;
			routing = routingResult.routing;
			routingCacheHit = routingResult.fromCache;
			const parallelMs = Date.now() - requestStartTs - parallelStart;
			addEvent("get_table_metadata", parallelStart, parallelMs, { metadata_source: metaSource, parallel: true });
			addEvent("get_routing_config", parallelStart, parallelMs, { routing_cache: routingCacheHit ? "hit" : "miss", parallel: true });
		} else {
			const metaStart = Date.now() - requestStartTs;
			const metaResult = await getTableMetadataCached(tableName, metadataService);
			metadata = metaResult.metadata;
			metaSource = metaResult.source;
			addEvent("get_table_metadata", metaStart, Date.now() - requestStartTs - metaStart, { metadata_source: metaSource });
			routing = { version: 0, partitions: NUM_PARTITIONS, replicas: {} };
			routingCacheHit = true;
		}
	} else {
		const metaStart = Date.now() - requestStartTs;
		const metaResult = await getTableMetadataCached(tableName, metadataService);
		metadata = metaResult.metadata;
		metaSource = metaResult.source;
		addEvent("get_table_metadata", metaStart, Date.now() - requestStartTs - metaStart, { metadata_source: metaSource });
		const pkDef = metadata.KeySchema.find(k => k.KeyType === "HASH");
		if (!pkDef) throw new Error("Table definition missing Partition Key");
		const pkVal = body.Key?.[pkDef.AttributeName] ?? body.Item?.[pkDef.AttributeName];
		const pkRaw = validateAndGetRawKey(pkVal, pkDef.AttributeName);
		partitionId = hashPartitionKey(pkRaw, NUM_PARTITIONS);
		pKey = `${tableName}::partition-${partitionId}`;
		addEvent("hash_partition_key", Date.now() - requestStartTs, 0);
		if (op === "GetItem") {
			const routingStart = Date.now() - requestStartTs;
			const routingResult = await getOrSetRoutingCache(pKey, () => env.PARTITION_DO.get(env.PARTITION_DO.idFromName(pKey)).getRoutingConfig(requestId));
			routing = routingResult.routing;
			routingCacheHit = routingResult.fromCache;
			addEvent("get_routing_config", routingStart, Date.now() - requestStartTs - routingStart, { routing_cache: routingCacheHit ? "hit" : "miss" });
		} else {
			routing = { version: 0, partitions: NUM_PARTITIONS, replicas: {} };
			routingCacheHit = true;
		}
	}

	const pkDef = metadata.KeySchema.find(k => k.KeyType === "HASH");
	const pkVal = (op === "PutItem" ? body.Item : body.Key)?.[pkDef!.AttributeName];
	const pkRaw = validateAndGetRawKey(pkVal, pkDef!.AttributeName);

	baseHeaders["X-SHIVAM-DB-PARTITION-ID-INTERNAL"] = String(partitionId);
	baseHeaders["X-SHIVAM-DB-PARTITION-KEY"] = pKey;
	baseHeaders["X-SHIVAM-DB-TABLE"] = tableName;

	log("router", `PK=${pkRaw} -> partitionId=${partitionId} pKey=${pKey}`);

	if (op === "PutItem" || op === "DeleteItem" || op === "UpdateItem") {
		const leaderStub = env.SUB_DO.get(env.SUB_DO.idFromName(`${pKey}-leader`));
		const opStart = Date.now() - requestStartTs;
		if (op === "PutItem") {
			validateItemAgainstSchema(body.Item, metadata);
			const skDef = metadata.KeySchema.find(k => k.KeyType === "RANGE");
			const skVal = skDef ? body.Item[skDef.AttributeName] : undefined;
			const skRaw = getRaw(skVal) || "default";
			const doKey = `${pkRaw}#${skRaw}`;
			baseHeaders["X-SHIVAM-DB-SK"] = skRaw;
			baseHeaders["X-SHIVAM-DB-LEADER-DO"] = `${pKey}-leader`;
			await leaderStub.ensureLeaderAndPutItem(doKey, body.Item, partitionId, tableName, requestId);
			addEvent("do_put_item", opStart, Date.now() - requestStartTs - opStart);
		} else if (op === "DeleteItem") {
			const skDef = metadata.KeySchema.find(k => k.KeyType === "RANGE");
			const skVal = skDef ? body.Key[skDef.AttributeName] : undefined;
			const skRaw = getRaw(skVal) || "default";
			const doKey = `${pkRaw}#${skRaw}`;
			baseHeaders["X-SHIVAM-DB-SK"] = skRaw;
			await leaderStub.ensureLeaderAndDeleteItem(doKey, partitionId, tableName, requestId);
			addEvent("do_delete_item", opStart, Date.now() - requestStartTs - opStart);
		} else if (op === "UpdateItem") {
			const skDef = metadata.KeySchema.find(k => k.KeyType === "RANGE");
			const skVal = skDef ? body.Key[skDef.AttributeName] : undefined;
			const skRaw = getRaw(skVal) || "default";
			const doKey = `${pkRaw}#${skRaw}`;
			baseHeaders["X-SHIVAM-DB-SK"] = skRaw;
			const updates = body.AttributeUpdates || {};
			await leaderStub.ensureLeaderAndUpdateItem(doKey, updates, partitionId, tableName, requestId);
			addEvent("do_update_item", opStart, Date.now() - requestStartTs - opStart);
		}
		ctx.waitUntil(
			getOrSetRoutingCache(pKey, () => env.PARTITION_DO.get(env.PARTITION_DO.idFromName(pKey)).getRoutingConfig()).then(() => { })
		);
		const totalMsWrite = Date.now() - requestStartTs;
		addEvent("request", 0, totalMsWrite, { cold_path: metaSource !== "worker" });
		flushTrace();
		baseHeaders["X-SHIVAM-DB-Trace-Summary"] = buildTraceSummary(traceEvents, totalMsWrite);
		return new Response(JSON.stringify({}), { headers: baseHeaders });
	}

	if (op === "GetItem") {
		const replicas = routing.replicas[partitionId] || [];
		const routingTarget = replicas.length === 0 ? "leader" : "replica";
		let readTarget: string;
		let rStub: DurableObjectStub<SubDO>;
		if (replicas.length === 0) {
			const leaderId = `${pKey}-leader`;
			rStub = env.SUB_DO.get(env.SUB_DO.idFromName(leaderId));
			readTarget = leaderId;
			log("router", `GetItem: no replicas, reading from leader ${leaderId}`);
		} else {
			const rId = replicas[Math.floor(Math.random() * replicas.length)];
			rStub = env.SUB_DO.get(env.SUB_DO.idFromString(rId));
			readTarget = rId;
			log("router", `GetItem: reading from replica ${rId}`);
		}

		const skDef = metadata.KeySchema.find(k => k.KeyType === "RANGE");
		const skVal = skDef ? body.Key[skDef.AttributeName] : undefined;
		const skRaw = getRaw(skVal) || "default";
		const doKey = `${pkRaw}#${skRaw}`;

		baseHeaders["X-SHIVAM-DB-SK"] = skRaw;
		baseHeaders["X-SHIVAM-DB-READ-TARGET"] = readTarget;

		const doStart = Date.now() - requestStartTs;
		const item = replicas.length === 0
			? await rStub.ensureLeaderAndGetItem(doKey, requestId)
			: await rStub.getItem(doKey, requestId);
		const doEnd = Date.now() - requestStartTs;
		addEvent("do_get_item", doStart, doEnd - doStart, { routing_target: routingTarget });
		const totalMs = Date.now() - requestStartTs;
		const coldPath = metaSource !== "worker" || !routingCacheHit;
		addEvent("request", 0, totalMs, { cold_path: coldPath });
		flushTrace();
		baseHeaders["X-SHIVAM-DB-Trace-Summary"] = buildTraceSummary(traceEvents, totalMs);

		ctx.waitUntil((async () => {
			try {
				const pStub = env.PARTITION_DO.get(env.PARTITION_DO.idFromName(pKey));
				await pStub.reportLoad(1, requestId);
			} catch (e) {
				log.warn("router", "autoscale hook failed (non-critical)", e);
			}
		})());

		return new Response(JSON.stringify(item !== undefined && item !== null ? { Item: item } : {}), { headers: baseHeaders });
	}

	const totalMsFallback = Date.now() - requestStartTs;
	addEvent("request", 0, totalMsFallback, { cold_path: true });
	flushTrace();
	baseHeaders["X-SHIVAM-DB-Trace-Summary"] = buildTraceSummary(traceEvents, totalMsFallback);
	return new Response(JSON.stringify({ __type: "NotImplemented", message: `Operation ${op} not implemented` }), {
		status: 501,
		headers: baseHeaders
	});
}
