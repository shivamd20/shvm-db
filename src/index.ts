import { DurableObject } from "cloudflare:workers";
import { PartitionDO } from "./partition-do";
import { SubDO } from "./sub-do";
import { TableRegistryDO } from "./table-registry-do";
import { validateItemAgainstSchema, validateKey, ValidationError } from "./validation";
import { PARTITION_KEY_MAX_SIZE, SORT_KEY_MAX_SIZE } from "./constants";
import { MetadataService } from "./metadata-service";
import { CreateTableInput, RoutingTable } from "./types";

export { PartitionDO, SubDO, TableRegistryDO };

// Environment bindings
export interface Env {
	PARTITION_DO: DurableObjectNamespace<PartitionDO>;
	SUB_DO: DurableObjectNamespace<SubDO>;
	TABLE_REGISTRY_DO: DurableObjectNamespace<TableRegistryDO>;
	TABLE_METADATA_CACHE: KVNamespace;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// Handle API requests
		if (url.pathname.startsWith("/api") || request.headers.has("x-amz-target")) {
			try {
				return await handleDynamoRequest(request, env);
			} catch (err: any) {
				console.error("Error handling request:", err);
				if (err instanceof ValidationError) {
					return new Response(JSON.stringify({ __type: "ValidationException", message: err.message }), {
						status: 400,
						headers: { "Content-Type": "application/x-amz-json-1.0" }
					});
				}
				const type = err.message.includes("not found") ? "ResourceNotFoundException" : "InternalServerError";
				const status = type === "ResourceNotFoundException" ? 400 : 500;
				return new Response(JSON.stringify({ __type: type, message: err.message }), {
					status: status,
					headers: { "Content-Type": "application/x-amz-json-1.0" }
				});
			}
		}

		// Fallback for assets
		return new Response("Not Found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;

// Routing Cache: Map <PartitionKey, RoutingTable>
const routingCache = new Map<string, RoutingTable>();

// Internal Helper for Consistent Hashing
function getPartitionId(key: string, partitions: number): number {
	let hash = 0;
	for (let i = 0; i < key.length; i++) {
		hash = ((hash << 5) - hash) + key.charCodeAt(i);
		hash |= 0; // Convert to 32bit integer
	}
	return Math.abs(hash) % partitions;
}

async function handleDynamoRequest(request: Request, env: Env): Promise<Response> {
	const target = request.headers.get("x-amz-target");
	if (!target) {
		return new Response("Missing x-amz-target header", { status: 400 });
	}

	const body = await request.json() as any;
	const strings = target.split(".");
	const operation = strings[strings.length - 1];

	const metadataService = new MetadataService(env);

	// --- Control Plane ---
	if (operation === "CreateTable") {
		const input = body as CreateTableInput;
		if (!input.TableName || !input.KeySchema || !input.AttributeDefinitions) {
			throw new ValidationError("Missing required fields for CreateTable");
		}
		const result = await metadataService.createTable(input);
		return new Response(JSON.stringify(result), {
			headers: { "Content-Type": "application/x-amz-json-1.0" }
		});
	}

	if (operation === "DeleteTable") {
		const tableName = body.TableName;
		if (!tableName) throw new ValidationError("Missing TableName");

		const result = await metadataService.deleteTable(tableName);
		return new Response(JSON.stringify(result), {
			headers: { "Content-Type": "application/x-amz-json-1.0" }
		});
	}

	if (operation === "ListTables") {
		// Quick hack to expose list tables via registry
		//Ideally this should be in MetadataService strictly
		const registryId = env.TABLE_REGISTRY_DO.idFromName("global-registry");
		const registry = env.TABLE_REGISTRY_DO.get(registryId);
		const tables = await registry.listTables(body.Limit, body.ExclusiveStartTableName);
		return new Response(JSON.stringify({ TableNames: tables }), {
			headers: { "Content-Type": "application/x-amz-json-1.0" }
		});
	}

	// --- Data Plane ---
	const tableName = body.TableName;
	if (!tableName) {
		throw new ValidationError("TableName is required");
	}

	if (operation === "Query") {
		return new Response(`Operation ${operation} not implemented`, { status: 501 });
	}

	// Fetch Metadata (Cache -> DO)
	const metadata = await metadataService.getTableMetadata(tableName);

	// Determine PK and SK definitions from Metadata
	const pkDef = metadata.KeySchema.find(k => k.KeyType === "HASH");
	if (!pkDef) throw new Error("Table definition missing Partition Key");

	const skDef = metadata.KeySchema.find(k => k.KeyType === "RANGE");

	// Helper to extract typed value (e.g. { S: "val" })
	const getTypedValue = (source: any, attrName: string) => {
		return source ? source[attrName] : undefined;
	};

	let pkTyped: any;
	let skTyped: any;

	if (operation === "PutItem") {
		pkTyped = getTypedValue(body.Item, pkDef.AttributeName);
		if (skDef) skTyped = getTypedValue(body.Item, skDef.AttributeName);
	} else if (operation === "GetItem" || operation === "DeleteItem" || operation === "UpdateItem") {
		pkTyped = getTypedValue(body.Key, pkDef.AttributeName);
		if (skDef) skTyped = getTypedValue(body.Key, skDef.AttributeName);
	}

	if (!pkTyped) throw new ValidationError(`Missing Partition Key: ${pkDef.AttributeName}`);
	if (skDef && !skTyped) throw new ValidationError(`Missing Sort Key: ${skDef.AttributeName}`);

	// Validate Schema locally before sending to DO
	if (operation === "PutItem") {
		validateItemAgainstSchema(body.Item, metadata);
	}

	// Extract raw string value for partition hashing
	const getRawStr = (val: any) => val.S || val.N || val.B;
	const pkRaw = getRawStr(pkTyped);

	if (!pkRaw) throw new ValidationError("Partition Key value invalid");

	// Routing: Namespace by Table Name
	// <TableName>#<PK>
	const partitionKeyForDo = `${tableName}#${pkRaw}`;

	let retries = 0;
	const MAX_RETRIES = 1;

	while (true) {
		// Check Routing Cache
		let routing = routingCache.get(partitionKeyForDo);
		if (!routing) {
			// Fetch from PartitionDO (Control Plane)
			const id = env.PARTITION_DO.idFromName(partitionKeyForDo);
			const stub = env.PARTITION_DO.get(id);
			routing = await stub.getRoutingConfig();
			routingCache.set(partitionKeyForDo, routing);
		}

		// Apply Routing
		let skRaw = "default";
		if (skDef && skTyped) {
			skRaw = getRawStr(skTyped);
		}

		const partitionId = getPartitionId(skRaw, routing.partitions);
		const subDoId = env.SUB_DO.idFromName(`sub-partition-${partitionId}`);
		const subStub = env.SUB_DO.get(subDoId);

		let result: any;

		try {
			switch (operation) {
				case "PutItem":
					await subStub.putItem(skRaw, body.Item, partitionId, routing.partitions);
					result = {};
					break;

				case "GetItem":
					const item = await subStub.getItem(skRaw, partitionId, routing.partitions);
					result = item ? { Item: item } : {};
					break;

				case "DeleteItem":
					await subStub.deleteItem(skRaw, partitionId, routing.partitions);
					result = {};
					break;

				default:
					return new Response(`Operation ${operation} not implemented`, { status: 400 });
			}

			// Success
			return new Response(JSON.stringify(result), {
				headers: {
					"Content-Type": "application/x-amz-json-1.0"
				}
			});

		} catch (err: any) {
			// Check for routing errors / redirects
			if ((err.message.includes("Wrong PartitionDO") || err.message.includes("Misrouted request")) && retries < MAX_RETRIES) {
				console.warn(`Routing mismatch for ${partitionKeyForDo}, refreshing and retrying...`);
				routingCache.delete(partitionKeyForDo);
				retries++;
				continue;
			}
			throw err;
		}
	}
}
