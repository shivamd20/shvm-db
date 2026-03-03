import { DurableObject } from "cloudflare:workers";
import { PartitionDO } from "./partition-do";

import { TableRegistryDO } from "./table-registry-do";
import { TraceDO } from "./trace-do";
import { validateItemAgainstSchema, ValidationError, CreateTableSchema } from "./validation";
import { MetadataService } from "./metadata-service";
import { mapDynamoError } from "./error-mapping";
import { CreateTableInput, TableMetadata } from "./types";
import { createLogger } from "./debug";
import type { TraceEvent } from "./trace-types";

export { PartitionDO, TableRegistryDO, TraceDO };

export interface Env {
	PARTITION_DO: DurableObjectNamespace<PartitionDO>;
	TABLE_REGISTRY_DO: DurableObjectNamespace<TableRegistryDO>;
	TRACE_DO: DurableObjectNamespace<TraceDO>;
	SHVM_DEBUG?: string;
	NUM_PARTITIONS?: number; // Added for central config mapping
}

const TRACE_DO_SINGLETON_NAME = "shvm-db-trace";
let isWorkerColdStart = true;

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
	const seg: Record<string, number | boolean | string> = { total_ms: totalMs };
	for (const e of traceEvents) {
		if (e.step === "request") continue;
		const key = e.step.replace(/-/g, "_") + "_ms";
		seg[key] = ((seg[key] as number) ?? 0) + e.durationMs;

		if (e.attributes) {
			for (const [k, v] of Object.entries(e.attributes)) {
				seg[`${e.step.replace(/-/g, "_")}_${k}`] = v;
			}
		}
	}
	return Object.entries(seg).map(([k, v]) => `${k}=${v}`).join(",");
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const workerInvokeTs = Date.now();
		const coldStart = isWorkerColdStart;
		if (isWorkerColdStart) {
			isWorkerColdStart = false;
		}

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
				return await handleDynamoRequest(request, env, ctx, workerInvokeTs, coldStart);
			} catch (err: any) {
				const log = createLogger(env);
				const mappedErr = mapDynamoError(err);

				if (mappedErr.status === 500) {
					log.error("router", `Error: ${err?.message}`, err?.stack);
				} else {
					log("router", `Expected err [${mappedErr.type}]: ${mappedErr.message}`);
				}

				return new Response(JSON.stringify({ __type: mappedErr.type, message: mappedErr.message }), {
					status: mappedErr.status,
					headers: { "Content-Type": "application/x-amz-json-1.0" }
				});
			}
		}
		return new Response("Not Found", { status: 404 });
	},

} satisfies ExportedHandler<Env>;

async function handleDynamoRequest(request: Request, env: Env, ctx: ExecutionContext, workerInvokeTs: number = Date.now(), isColdStart: boolean = false): Promise<Response> {
	const log = createLogger(env);
	const requestId = getRequestId(request);
	const requestStartTs = Date.now();
	const target = request.headers.get("x-amz-target");
	if (!target) return new Response("Missing x-amz-target header", { status: 400 });

	const traceEvents: TraceEvent[] = [];
	const requestBytes = Number(request.headers.get("content-length")) || 0;

	const clientTsHeader = request.headers.get("x-shvm-client-ts");
	if (clientTsHeader) {
		const clientTs = parseInt(clientTsHeader, 10);
		if (!isNaN(clientTs)) {
			traceEvents.push({ requestId, step: "client_to_worker", startMs: 0, durationMs: workerInvokeTs - clientTs });
		}
	}
	traceEvents.push({ requestId, step: "worker_routing", startMs: workerInvokeTs - requestStartTs, durationMs: requestStartTs - workerInvokeTs });

	const reqCf = request.cf as any;
	const cfAttributes: Record<string, string | number | boolean> = {};
	if (reqCf) {
		if (reqCf.colo) cfAttributes["cf_colo"] = reqCf.colo;
		if (reqCf.clientTcpRtt) cfAttributes["cf_client_tcp_rtt"] = reqCf.clientTcpRtt;
		if (reqCf.asOrganization) cfAttributes["cf_as_org"] = reqCf.asOrganization;
	}

	const body = await request.json() as any;
	const op = target.split(".").pop() || "unknown";
	const metadataService = new MetadataService(env);

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
		return new Response(JSON.stringify(res), { headers: baseHeaders });
	}
	if (op === "ListTables") {
		const registry = env.TABLE_REGISTRY_DO.get(env.TABLE_REGISTRY_DO.idFromName("global-registry"));
		const listResult = await registry.listTables(body.Limit, body.ExclusiveStartTableName);
		return new Response(JSON.stringify(listResult), { headers: baseHeaders });
	}
	if (op === "DescribeTable") {
		const { metadata } = await metadataService.getTableMetadata(body.TableName);
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

	let partitionId: number;
	let pKey: string;

	// Optimization: we could cache schema, but for now we fetch it
	const metaStart = Date.now() - requestStartTs;
	const metaResult = await metadataService.getTableMetadata(tableName);
	const metadata = metaResult.metadata;
	addEvent("get_table_metadata", metaStart, Date.now() - requestStartTs - metaStart, { metadata_source: "registry" });
	const pkDef = metadata.KeySchema.find(k => k.KeyType === "HASH");
	if (!pkDef) throw new Error("Table definition missing Partition Key");
	const pkVal = body.Key?.[pkDef.AttributeName] ?? body.Item?.[pkDef.AttributeName];
	const pkRaw = validateAndGetRawKey(pkVal, pkDef.AttributeName);
	partitionId = hashPartitionKey(pkRaw, env.NUM_PARTITIONS ?? 100);
	pKey = `${tableName}::partition-${partitionId}`;
	const pStub = env.PARTITION_DO.get(env.PARTITION_DO.idFromName(pKey));

	baseHeaders["X-SHIVAM-DB-PARTITION-ID-INTERNAL"] = String(partitionId);
	baseHeaders["X-SHIVAM-DB-PARTITION-KEY"] = pKey;
	baseHeaders["X-SHIVAM-DB-TABLE"] = tableName;

	log("router", `PK=${pkRaw} -> partitionId=${partitionId} pKey=${pKey}`);

	if (op === "PutItem" || op === "DeleteItem" || op === "UpdateItem") {
		const opStart = Date.now() - requestStartTs;
		if (op === "PutItem") {
			validateItemAgainstSchema(body.Item, metadata);
			const skDef = metadata.KeySchema.find(k => k.KeyType === "RANGE");
			const skVal = skDef ? body.Item[skDef.AttributeName] : undefined;
			const skRaw = getRaw(skVal) || "default";
			const doKey = `${pkRaw}#${skRaw}`;
			baseHeaders["X-SHIVAM-DB-SK"] = skRaw;
			baseHeaders["X-SHIVAM-DB-TARGET-DO"] = pKey;
			const res: any = await pStub.handlePutItem(doKey, body.Item, partitionId, tableName, requestId, body.ConditionExpression, body.ExpressionAttributeNames, body.ExpressionAttributeValues, body.ReturnValues, Date.now());
			addEvent("do_put_item", opStart, Date.now() - requestStartTs - opStart);
			const resJson = JSON.stringify(res || {});
			const totalMsWrite = Date.now() - requestStartTs;
			addEvent("request", 0, totalMsWrite, { cold_path: true, worker_cold_start: isColdStart, request_bytes: requestBytes, response_bytes: resJson.length, ...cfAttributes });
			flushTrace();
			baseHeaders["X-SHIVAM-DB-Trace-Summary"] = buildTraceSummary(traceEvents, totalMsWrite);
			return new Response(resJson, { headers: baseHeaders });
		} else if (op === "DeleteItem") {
			const skDef = metadata.KeySchema.find(k => k.KeyType === "RANGE");
			const skVal = skDef ? body.Key[skDef.AttributeName] : undefined;
			const skRaw = getRaw(skVal) || "default";
			const doKey = `${pkRaw}#${skRaw}`;
			baseHeaders["X-SHIVAM-DB-SK"] = skRaw;
			const res: any = await pStub.handleDeleteItem(doKey, partitionId, tableName, requestId, body.ConditionExpression, body.ExpressionAttributeNames, body.ExpressionAttributeValues, body.ReturnValues, Date.now());
			addEvent("do_delete_item", opStart, Date.now() - requestStartTs - opStart);
			const resJson = JSON.stringify(res || {});
			const totalMsWrite = Date.now() - requestStartTs;
			addEvent("request", 0, totalMsWrite, { cold_path: true, worker_cold_start: isColdStart, request_bytes: requestBytes, response_bytes: resJson.length, ...cfAttributes });
			flushTrace();
			baseHeaders["X-SHIVAM-DB-Trace-Summary"] = buildTraceSummary(traceEvents, totalMsWrite);
			return new Response(resJson, { headers: baseHeaders });
		} else if (op === "UpdateItem") {
			const skDef = metadata.KeySchema.find(k => k.KeyType === "RANGE");
			const skVal = skDef ? body.Key[skDef.AttributeName] : undefined;
			const skRaw = getRaw(skVal) || "default";
			const doKey = `${pkRaw}#${skRaw}`;
			baseHeaders["X-SHIVAM-DB-SK"] = skRaw;
			const updates = body.AttributeUpdates || {};
			const res: any = await pStub.handleUpdateItem(doKey, updates, partitionId, tableName, requestId, body.UpdateExpression, body.ConditionExpression, body.ExpressionAttributeNames, body.ExpressionAttributeValues, body.ReturnValues, Date.now());
			addEvent("do_update_item", opStart, Date.now() - requestStartTs - opStart);

			const resJson = JSON.stringify(res || {});
			const totalMsWrite = Date.now() - requestStartTs;
			addEvent("request", 0, totalMsWrite, { cold_path: true, worker_cold_start: isColdStart, request_bytes: requestBytes, response_bytes: resJson.length, ...cfAttributes });
			flushTrace();
			baseHeaders["X-SHIVAM-DB-Trace-Summary"] = buildTraceSummary(traceEvents, totalMsWrite);
			return new Response(resJson, { headers: baseHeaders });
		}
	}

	if (op === "GetItem") {
		const skDef = metadata.KeySchema.find(k => k.KeyType === "RANGE");
		const skVal = skDef ? body.Key[skDef.AttributeName] : undefined;
		const skRaw = getRaw(skVal) || "default";
		const doKey = `${pkRaw}#${skRaw}`;

		baseHeaders["X-SHIVAM-DB-SK"] = skRaw;
		baseHeaders["X-SHIVAM-DB-READ-TARGET"] = pKey;

		const doStart = Date.now() - requestStartTs;
		const item = await pStub.handleGetItem(doKey, requestId, Date.now());
		const doEnd = Date.now() - requestStartTs;
		addEvent("do_get_item", doStart, doEnd - doStart);
		const totalMs = Date.now() - requestStartTs;
		const coldPath = true;
		const resObj = item !== undefined && item !== null ? { Item: item } : {};
		const resJson = JSON.stringify(resObj);
		addEvent("request", 0, totalMs, { cold_path: coldPath, worker_cold_start: isColdStart, request_bytes: requestBytes, response_bytes: resJson.length, ...cfAttributes });
		flushTrace();
		baseHeaders["X-SHIVAM-DB-Trace-Summary"] = buildTraceSummary(traceEvents, totalMs);

		ctx.waitUntil((async () => {
			try {
				await pStub.reportLoad(1, requestId);
			} catch (e) {
				log.warn("router", "autoscale hook failed (non-critical)", e);
			}
		})());

		return new Response(resJson, { headers: baseHeaders });
	}

	const totalMsFallback = Date.now() - requestStartTs;
	const resJson = JSON.stringify({ __type: "NotImplemented", message: `Operation ${op} not implemented` });
	addEvent("request", 0, totalMsFallback, { cold_path: true, worker_cold_start: isColdStart, request_bytes: requestBytes, response_bytes: resJson.length, ...cfAttributes });
	flushTrace();
	baseHeaders["X-SHIVAM-DB-Trace-Summary"] = buildTraceSummary(traceEvents, totalMsFallback);
	return new Response(resJson, {
		status: 501,
		headers: baseHeaders
	});
}
