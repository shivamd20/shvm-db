
import { DurableObject } from "cloudflare:workers";
import { PartitionDO } from "./partition-do";
import { SubDO } from "./sub-do";
import { TableRegistryDO } from "./table-registry-do";
import { validateItemAgainstSchema, ValidationError } from "./validation";
import { MetadataService } from "./metadata-service";
import { CreateTableInput, RoutingTable, ReplicationMessage, Role } from "./types";
import { createLogger } from "./debug";

export { PartitionDO, SubDO, TableRegistryDO };

export interface Env {
	PARTITION_DO: DurableObjectNamespace<PartitionDO>;
	SUB_DO: DurableObjectNamespace<SubDO>;
	TABLE_REGISTRY_DO: DurableObjectNamespace<TableRegistryDO>;
	TABLE_METADATA_CACHE: KVNamespace;
	REPLICATION_QUEUE: Queue;
	SHVM_DEBUG?: string;
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
		// Handle API requests
		if (url.pathname.startsWith("/api") || request.headers.has("x-amz-target")) {
			try {
				return await handleDynamoRequest(request, env, ctx);
			} catch (err: any) {
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

	async queue(batch: MessageBatch<ReplicationMessage>, env: Env): Promise<void> {
		const log = createLogger(env);
		const promises: Promise<void>[] = [];
		const routingCache = new Map<string, RoutingTable>();

		for (const message of batch.messages) {
			const msg = message.body;
			const pId = msg.partitionId;
			const tableName = msg.tableName || "default";
			const pKey = `${tableName}::partition-${pId}`;

			log("queue", `replication type=${msg.type} table=${tableName} partition=${pId} sk=${msg.sk} v=${msg.version}`);

			// Replicate to standby
			const standbyId = env.SUB_DO.idFromName(`${pKey}-standby`);
			const standbyStub = env.SUB_DO.get(standbyId);
			promises.push(standbyStub.init(Role.STANDBY).then(() => standbyStub.applyMutation(msg)));

			// Get routing config for replicas
			let routing = routingCache.get(pKey);
			if (!routing) {
				const pStub = env.PARTITION_DO.get(env.PARTITION_DO.idFromName(pKey));
				routing = await pStub.getRoutingConfig();
				routingCache.set(pKey, routing);
			}

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

// --- Routing ---
const validRoutingCache = new Map<string, RoutingTable>();

async function handleDynamoRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const log = createLogger(env);
	const requestStartTs = Date.now();
	const target = request.headers.get("x-amz-target");
	if (!target) return new Response("Missing x-amz-target header", { status: 400 });

	const body = await request.json() as any;
	const op = target.split(".").pop();
	const metadataService = new MetadataService(env);

	log("router", `op=${op} table=${body.TableName || 'N/A'}`);

	// --- Debug headers builder ---
	const debugHeaders: Record<string, string> = {
		"Content-Type": "application/x-amz-json-1.0",
		"X-SHIVAM-DB-OP": op || "unknown",
		"X-SHIVAM-DB-REQUEST-TS": String(requestStartTs),
	};

	// ... Control Plane ...
	if (op === "CreateTable") {
		log("control", `CreateTable: ${body.TableName}`);
		const res = await metadataService.createTable(body as CreateTableInput);
		return new Response(JSON.stringify(res), { headers: debugHeaders });
	}
	if (op === "DeleteTable") {
		log("control", `DeleteTable: ${body.TableName}`);
		const res = await metadataService.deleteTable(body.TableName);
		return new Response(JSON.stringify(res), { headers: debugHeaders });
	}
	if (op === "ListTables") {
		const registry = env.TABLE_REGISTRY_DO.get(env.TABLE_REGISTRY_DO.idFromName("global-registry"));
		const tables = await registry.listTables(body.Limit, body.ExclusiveStartTableName);
		return new Response(JSON.stringify({ TableNames: tables }), { headers: debugHeaders });
	}
	if (op === "DescribeTable") {
		const metadata = await metadataService.getTableMetadata(body.TableName);
		return new Response(JSON.stringify({ Table: metadata }), { headers: debugHeaders });
	}

	// --- Early check for unsupported operations ---
	// Must happen before TableName validation because batch ops (BatchWriteItem, etc.)
	// don't have a top-level TableName field.
	const supportedDataOps = ["PutItem", "GetItem", "DeleteItem", "UpdateItem"];
	if (!supportedDataOps.includes(op)) {
		if (body.TableName) debugHeaders["X-SHIVAM-DB-TABLE"] = body.TableName;
		return new Response(JSON.stringify({ __type: "NotImplemented", message: `Operation ${op} not implemented` }), {
			status: 501,
			headers: debugHeaders
		});
	}

	const tableName = body.TableName;
	if (!tableName) throw new ValidationError("TableName is required");

	const metadata = await metadataService.getTableMetadata(tableName);
	const pkDef = metadata.KeySchema.find(k => k.KeyType === "HASH");
	if (!pkDef) throw new Error("Table definition missing Partition Key");

	const pkVal = (op === "PutItem" ? body.Item : body.Key)?.[pkDef.AttributeName];
	const getRaw = (v: any) => v?.S || v?.N || v?.B;
	const pkRaw = getRaw(pkVal);

	if (!pkRaw) throw new ValidationError("Partition Key value invalid");

	// --- Partition Routing (table-scoped) ---
	const partitionId = hashPartitionKey(pkRaw, NUM_PARTITIONS);
	const pKey = `${tableName}::partition-${partitionId}`;

	debugHeaders["X-SHIVAM-DB-PARTITION-ID-INTERNAL"] = String(partitionId);
	debugHeaders["X-SHIVAM-DB-PARTITION-KEY"] = pKey;
	debugHeaders["X-SHIVAM-DB-TABLE"] = tableName;

	log("router", `PK=${pkRaw} -> partitionId=${partitionId} pKey=${pKey}`);

	if (op === "PutItem" || op === "DeleteItem" || op === "UpdateItem") {
		const leaderStub = env.SUB_DO.get(env.SUB_DO.idFromName(`${pKey}-leader`));
		await leaderStub.init(Role.LEADER);

		if (op === "PutItem") {
			validateItemAgainstSchema(body.Item, metadata);
			const skDef = metadata.KeySchema.find(k => k.KeyType === "RANGE");
			const skVal = skDef ? body.Item[skDef.AttributeName] : undefined;
			const skRaw = getRaw(skVal) || "default";
			debugHeaders["X-SHIVAM-DB-SK"] = skRaw;
			debugHeaders["X-SHIVAM-DB-LEADER-DO"] = `${pKey}-leader`;

			const doReachedTs = Date.now();
			await leaderStub.putItem(skRaw, body.Item, partitionId, tableName);
			debugHeaders["X-SHIVAM-DB-SUB-DO-REACHED-TS"] = String(doReachedTs);
			debugHeaders["X-SHIVAM-DB-SUB-DO-LATENCY-MS"] = String(Date.now() - doReachedTs);
		} else if (op === "DeleteItem") {
			const skDef = metadata.KeySchema.find(k => k.KeyType === "RANGE");
			const skVal = skDef ? body.Key[skDef.AttributeName] : undefined;
			const skRaw = getRaw(skVal) || "default";
			debugHeaders["X-SHIVAM-DB-SK"] = skRaw;

			const doReachedTs = Date.now();
			await leaderStub.deleteItem(skRaw, partitionId, tableName);
			debugHeaders["X-SHIVAM-DB-SUB-DO-REACHED-TS"] = String(doReachedTs);
			debugHeaders["X-SHIVAM-DB-SUB-DO-LATENCY-MS"] = String(Date.now() - doReachedTs);
		} else {
			// UpdateItem - not implemented
			return new Response(JSON.stringify({ __type: "NotImplemented", message: "UpdateItem not supported yet" }), {
				status: 501,
				headers: debugHeaders
			});
		}
		return new Response(JSON.stringify({}), { headers: debugHeaders });
	}

	if (op === "GetItem") {
		if (!validRoutingCache.has(pKey)) {
			const pStub = env.PARTITION_DO.get(env.PARTITION_DO.idFromName(pKey));
			const r = await pStub.getRoutingConfig();
			validRoutingCache.set(pKey, r);
		}
		const routing = validRoutingCache.get(pKey)!;

		const replicas = routing.replicas[partitionId] || [];
		let readTarget: string;

		let rStub: DurableObjectStub;
		if (replicas.length === 0) {
			// No read replicas provisioned — read from the Leader directly.
			// The Leader always has the latest data (writes locally before publishing to queue).
			// The Standby only gets data asynchronously via the replication queue.
			const leaderId = `${pKey}-leader`;
			rStub = env.SUB_DO.get(env.SUB_DO.idFromName(leaderId));
			await rStub.init(Role.LEADER);
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

		debugHeaders["X-SHIVAM-DB-SK"] = skRaw;
		debugHeaders["X-SHIVAM-DB-READ-TARGET"] = readTarget;

		const doReachedTs = Date.now();
		const item = await rStub.getItem(skRaw);
		debugHeaders["X-SHIVAM-DB-SUB-DO-REACHED-TS"] = String(doReachedTs);
		debugHeaders["X-SHIVAM-DB-SUB-DO-LATENCY-MS"] = String(Date.now() - doReachedTs);

		// --- Autoscaling Hook (best-effort, non-critical) ---
		ctx.waitUntil((async () => {
			try {
				const pStub = env.PARTITION_DO.get(env.PARTITION_DO.idFromName(pKey));
				await pStub.reportLoad(1);
			} catch (e) {
				log.warn("router", "autoscale hook failed (non-critical)", e);
			}
		})());

		return new Response(JSON.stringify(item ? { Item: item } : {}), { headers: debugHeaders });
	}

	// Unsupported operations => 501
	return new Response(JSON.stringify({ __type: "NotImplemented", message: `Operation ${op} not implemented` }), {
		status: 501,
		headers: debugHeaders
	});
}
