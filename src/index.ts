import { DurableObject } from "cloudflare:workers";
import { PartitionDO } from "./partition-do";
import { SubDO } from "./sub-do";
import { TableRegistryDO } from "./table-registry-do";
import { validateItemAgainstSchema, ValidationError } from "./validation";
import { MetadataService } from "./metadata-service";
import { CreateTableInput, RoutingTable, ReplicationMessage, Role } from "./types";
import { createLogger } from "./debug";
import { createRequestObserver, recordStage, recordRequestSummary, STAGE } from "./observability";

export { PartitionDO, SubDO, TableRegistryDO };

export interface Env {
	PARTITION_DO: DurableObjectNamespace<PartitionDO>;
	SUB_DO: DurableObjectNamespace<SubDO>;
	TABLE_REGISTRY_DO: DurableObjectNamespace<TableRegistryDO>;
	TABLE_METADATA_CACHE: KVNamespace;
	REPLICATION_QUEUE: Queue;
	SHVM_DEBUG?: string;
	OBSERVABILITY?: AnalyticsEngineDataset;
}

// --- Hashing ---
// djb2 hash: fast, simple, deterministic string -> number
function hashPartitionKey(pk: string, numPartitions: number): number {
	let hash = 5381;
	for (let i = 0; i < pk.length; i++) {
		hash = ((hash << 5) + hash + pk.charCodeAt(i)) >>> 0; // unsigned 32-bit
	}
	return hash % numPartitions;
}

const NUM_PARTITIONS = 100;

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/debug/sentry") {
			throw new Error("Test error for debug route");
		}

		if (url.pathname.startsWith("/api") || request.headers.has("x-amz-target")) {
			const queryId = crypto.randomUUID();
			const requestStartTs = Date.now();
			try {
				return await handleDynamoRequest(request, env, ctx, queryId, requestStartTs);
			} catch (err: any) {
				const requestEndTs = Date.now();
				recordRequestSummary(env, { queryId, requestStartTs, op: "unknown" }, requestEndTs);
				const log = createLogger(env);
				log.error("router", `Error: ${err?.message}`, err?.stack);
				if (err instanceof ValidationError) {
					return new Response(JSON.stringify({ __type: "ValidationException", message: err.message }), {
						status: 400,
						headers: { "Content-Type": "application/x-amz-json-1.0" }
					});
				}
				const type = err.message.includes("not found") ? "ResourceNotFoundException" : "InternalServerError";
				return new Response(JSON.stringify({ __type: type, message: err.message }), {
					status: type === "ResourceNotFoundException" ? 400 : 500,
					headers: { "Content-Type": "application/x-amz-json-1.0" }
				});
			}
		}
		return new Response("Not Found", { status: 404 });
	},

	async queue(batch: MessageBatch<any>, env: Env): Promise<void> {
		const log = createLogger(env);
		const promises: Promise<void>[] = [];
		const routingCache = new Map<string, RoutingTable>();

		for (const message of batch.messages) {
			const msg = message.body;
			const replicationMessageId = crypto.randomUUID();
			const pId = msg.partitionId;
			const tableName = msg.tableName || "default";
			const pKey = `${tableName}::partition-${pId}`;
			const replCtx = { replicationMessageId, tableName, op: "replication" as const };

			const queueMsgStart = Date.now();
			log("queue", `replication type=${msg.type} table=${tableName} partition=${pId} sk=${msg.sk} v=${msg.version}`);
			recordStage(env, replCtx, STAGE.QUEUE_MESSAGE_RECEIVED, queueMsgStart, Date.now());

			promises.push((async () => {
				const standbyId = env.SUB_DO.idFromName(`${pKey}-standby`);
				const standbyStub = env.SUB_DO.get(standbyId);
				const standbyInitStart = Date.now();
				await standbyStub.init(Role.STANDBY);
				recordStage(env, replCtx, STAGE.STANDBY_INIT, standbyInitStart, Date.now());
				const standbyApplyStart = Date.now();
				standbyStub.applyMutation(msg);
				recordStage(env, replCtx, STAGE.STANDBY_APPLY_MUTATION, standbyApplyStart, Date.now());

				const routingCacheHit = routingCache.has(pKey);
				const getRoutingStart = Date.now();
				let routing: RoutingTable;
				if (!routingCacheHit) {
					const pStub = env.PARTITION_DO.get(env.PARTITION_DO.idFromName(pKey));
					routing = await pStub.getRoutingConfig();
					routingCache.set(pKey, routing);
				} else {
					routing = routingCache.get(pKey)!;
				}
				recordStage(env, replCtx, STAGE.QUEUE_GET_ROUTING_CONFIG, getRoutingStart, Date.now(), { routing_cache: routingCacheHit ? "hit" : "miss" });

				const replicas = routing.replicas[pId] || [];
				log("queue", `partition ${pKey} replicas=${replicas.length}`);

				for (const rId of replicas) {
					const replicaApplyStart = Date.now();
					const rStub = env.SUB_DO.get(env.SUB_DO.idFromString(rId));
					rStub.applyMutation(msg);
					recordStage(env, replCtx, STAGE.REPLICA_APPLY_MUTATION, replicaApplyStart, Date.now(), { replica_id: rId });
				}
			})());
		}

		await Promise.allSettled(promises);
	},
} satisfies ExportedHandler<Env, ReplicationMessage>;

// --- Routing ---
const validRoutingCache = new Map<string, RoutingTable>();

async function handleDynamoRequest(request: Request, env: Env, ctx: ExecutionContext, queryId: string, requestStartTs: number): Promise<Response> {
	const log = createLogger(env);
	const observer = createRequestObserver(env, queryId, requestStartTs);

	const parseStart = Date.now();
	const target = request.headers.get("x-amz-target");
	if (!target) {
		observer.recordSummary(Date.now());
		return new Response("Missing x-amz-target header", { status: 400 });
	}

	const body = await request.json() as any;
	const op = target.split(".").pop() || "unknown";
	observer.recordStage(STAGE.PARSE_REQUEST, parseStart, Date.now());
	observer.recordSummary(Date.now()); // early exit for non-api won't reach here

	const metadataService = new MetadataService(env);
	const debugHeaders: Record<string, string> = {
		"Content-Type": "application/x-amz-json-1.0",
		"X-SHIVAM-DB-OP": op || "unknown",
		"X-SHIVAM-DB-REQUEST-TS": String(requestStartTs),
		"X-SHIVAM-DB-Query-Id": queryId,
	};

	log("router", `op=${op} table=${body.TableName || 'N/A'}`);

	// Control Plane
	if (op === "CreateTable") {
		log("control", `CreateTable: ${body.TableName}`);
		const createStart = Date.now();
		const res = await metadataService.createTable(body as CreateTableInput);
		observer.recordStage(STAGE.CREATE_TABLE, createStart, Date.now());
		observer.recordSummary(Date.now());
		return new Response(JSON.stringify(res), { headers: debugHeaders });
	}
	if (op === "DeleteTable") {
		log("control", `DeleteTable: ${body.TableName}`);
		const deleteStart = Date.now();
		const res = await metadataService.deleteTable(body.TableName);
		observer.recordStage(STAGE.DELETE_TABLE, deleteStart, Date.now());
		observer.recordSummary(Date.now());
		return new Response(JSON.stringify(res), { headers: debugHeaders });
	}
	if (op === "ListTables") {
		const listStart = Date.now();
		const registry = env.TABLE_REGISTRY_DO.get(env.TABLE_REGISTRY_DO.idFromName("global-registry"));
		const tables = await registry.listTables(body.Limit, body.ExclusiveStartTableName);
		observer.recordStage(STAGE.LIST_TABLES, listStart, Date.now());
		observer.recordSummary(Date.now());
		return new Response(JSON.stringify({ TableNames: tables }), { headers: debugHeaders });
	}
	if (op === "DescribeTable") {
		const describeStart = Date.now();
		const { metadata } = await metadataService.getTableMetadata(body.TableName);
		observer.recordStage(STAGE.DESCRIBE_TABLE, describeStart, Date.now());
		observer.recordSummary(Date.now());
		return new Response(JSON.stringify({ Table: metadata }), { headers: debugHeaders });
	}

	const supportedDataOps = ["PutItem", "GetItem", "DeleteItem", "UpdateItem"];
	if (!supportedDataOps.includes(op)) {
		if (body.TableName) debugHeaders["X-SHIVAM-DB-TABLE"] = body.TableName;
		observer.recordSummary(Date.now());
		return new Response(JSON.stringify({ __type: "NotImplemented", message: `Operation ${op} not implemented` }), {
			status: 501,
			headers: debugHeaders
		});
	}

	const tableName = body.TableName;
	if (!tableName) throw new ValidationError("TableName is required");

	observer.tableName = tableName;
	observer.op = op;

	const getMetaStart = Date.now();
	const { metadata, metadataCacheHit } = await metadataService.getTableMetadata(tableName);
	const getMetaEnd = Date.now();
	observer.recordStage(STAGE.GET_TABLE_METADATA, getMetaStart, getMetaEnd, { metadata_cache: metadataCacheHit ? "kv_hit" : "kv_miss" });

	const pkDef = metadata.KeySchema.find(k => k.KeyType === "HASH");
	if (!pkDef) throw new Error("Table definition missing Partition Key");

	const pkVal = (op === "PutItem" ? body.Item : body.Key)?.[pkDef.AttributeName];
	const getRaw = (v: any) => v?.S || v?.N || v?.B;
	const pkRaw = getRaw(pkVal);

	if (!pkRaw) throw new ValidationError("Partition Key value invalid");

	const hashStart = Date.now();
	const partitionId = hashPartitionKey(pkRaw, NUM_PARTITIONS);
	const hashEnd = Date.now();
	observer.recordStage(STAGE.HASH_PARTITION_KEY, hashStart, hashEnd);

	const pKey = `${tableName}::partition-${partitionId}`;
	debugHeaders["X-SHIVAM-DB-PARTITION-ID-INTERNAL"] = String(partitionId);
	debugHeaders["X-SHIVAM-DB-PARTITION-KEY"] = pKey;
	debugHeaders["X-SHIVAM-DB-TABLE"] = tableName;

	log("router", `PK=${pkRaw} -> partitionId=${partitionId} pKey=${pKey}`);

	const obsContext = { queryId, requestStartTs, tableName, op };

	if (op === "PutItem" || op === "DeleteItem" || op === "UpdateItem") {
		const leaderStub = env.SUB_DO.get(env.SUB_DO.idFromName(`${pKey}-leader`));
		const initLeaderStart = Date.now();
		await leaderStub.init(Role.LEADER);
		observer.recordStage(STAGE.INIT_LEADER, initLeaderStart, Date.now());

		if (op === "PutItem") {
			validateItemAgainstSchema(body.Item, metadata);
			const skDef = metadata.KeySchema.find(k => k.KeyType === "RANGE");
			const skVal = skDef ? body.Item[skDef.AttributeName] : undefined;
			const skRaw = getRaw(skVal) || "default";
			const doKey = `${pkRaw}#${skRaw}`;
			debugHeaders["X-SHIVAM-DB-SK"] = skRaw;
			debugHeaders["X-SHIVAM-DB-LEADER-DO"] = `${pKey}-leader`;

			const doReachedTs = Date.now();
			await leaderStub.putItem(doKey, body.Item, partitionId, tableName, obsContext);
			debugHeaders["X-SHIVAM-DB-SUB-DO-REACHED-TS"] = String(doReachedTs);
			debugHeaders["X-SHIVAM-DB-SUB-DO-LATENCY-MS"] = String(Date.now() - doReachedTs);
			observer.recordStage(STAGE.DO_PUT_ITEM, doReachedTs, Date.now());
		} else if (op === "DeleteItem") {
			const skDef = metadata.KeySchema.find(k => k.KeyType === "RANGE");
			const skVal = skDef ? body.Key[skDef.AttributeName] : undefined;
			const skRaw = getRaw(skVal) || "default";
			const doKey = `${pkRaw}#${skRaw}`;
			debugHeaders["X-SHIVAM-DB-SK"] = skRaw;

			const doReachedTs = Date.now();
			await leaderStub.deleteItem(doKey, partitionId, tableName, obsContext);
			debugHeaders["X-SHIVAM-DB-SUB-DO-REACHED-TS"] = String(doReachedTs);
			debugHeaders["X-SHIVAM-DB-SUB-DO-LATENCY-MS"] = String(Date.now() - doReachedTs);
			observer.recordStage(STAGE.DO_DELETE_ITEM, doReachedTs, Date.now());
		} else if (op === "UpdateItem") {
			const skDef = metadata.KeySchema.find(k => k.KeyType === "RANGE");
			const skVal = skDef ? body.Key[skDef.AttributeName] : undefined;
			const skRaw = getRaw(skVal) || "default";
			const doKey = `${pkRaw}#${skRaw}`;
			debugHeaders["X-SHIVAM-DB-SK"] = skRaw;

			const updates = body.AttributeUpdates || {};
			const doReachedTs = Date.now();
			await leaderStub.updateItem(doKey, updates, partitionId, tableName, obsContext);
			debugHeaders["X-SHIVAM-DB-SUB-DO-REACHED-TS"] = String(doReachedTs);
			debugHeaders["X-SHIVAM-DB-SUB-DO-LATENCY-MS"] = String(Date.now() - doReachedTs);
			observer.recordStage(STAGE.DO_UPDATE_ITEM, doReachedTs, Date.now());
		}
		observer.recordSummary(Date.now());
		return new Response(JSON.stringify({}), { headers: debugHeaders });
	}

	if (op === "GetItem") {
		const routingCacheHit = validRoutingCache.has(pKey);
		const getRoutingStart = Date.now();
		if (!routingCacheHit) {
			const pStub = env.PARTITION_DO.get(env.PARTITION_DO.idFromName(pKey));
			const r = await pStub.getRoutingConfig(obsContext);
			validRoutingCache.set(pKey, r);
		}
		observer.recordStage(STAGE.GET_ROUTING_CONFIG, getRoutingStart, Date.now(), { routing_cache: routingCacheHit ? "hit" : "miss" });

		const routing = validRoutingCache.get(pKey)!;
		const replicas = routing.replicas[partitionId] || [];
		let readTarget: string;

		let rStub: DurableObjectStub<SubDO>;
		if (replicas.length === 0) {
			const leaderId = `${pKey}-leader`;
			rStub = env.SUB_DO.get(env.SUB_DO.idFromName(leaderId));
			const initLeaderReadStart = Date.now();
			await rStub.init(Role.LEADER);
			observer.recordStage(STAGE.INIT_LEADER_READ, initLeaderReadStart, Date.now());
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

		debugHeaders["X-SHIVAM-DB-SK"] = skRaw;
		debugHeaders["X-SHIVAM-DB-READ-TARGET"] = readTarget;

		const doReachedTs = Date.now();
		const item = await rStub.getItem(doKey, obsContext);
		debugHeaders["X-SHIVAM-DB-SUB-DO-REACHED-TS"] = String(doReachedTs);
		debugHeaders["X-SHIVAM-DB-SUB-DO-LATENCY-MS"] = String(Date.now() - doReachedTs);
		observer.recordStage(STAGE.DO_GET_ITEM, doReachedTs, Date.now(), { read_source: readTarget.startsWith(pKey) ? "leader" : `replica_${readTarget}` });

		ctx.waitUntil((async () => {
			try {
				const pStub = env.PARTITION_DO.get(env.PARTITION_DO.idFromName(pKey));
				await pStub.reportLoad(1);
			} catch (e) {
				log.warn("router", "autoscale hook failed (non-critical)", e);
			}
		})());

		observer.recordSummary(Date.now());
		return new Response(JSON.stringify(item ? { Item: item } : {}), { headers: debugHeaders });
	}

	observer.recordSummary(Date.now());
	return new Response(JSON.stringify({ __type: "NotImplemented", message: `Operation ${op} not implemented` }), {
		status: 501,
		headers: debugHeaders
	});
}
