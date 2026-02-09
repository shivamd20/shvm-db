import { DurableObject } from "cloudflare:workers";
import { MyDurableObject } from "./durable-object";

export { MyDurableObject };

// Environment bindings
export interface Env {
	MY_DURABLE_OBJECT: DurableObjectNamespace<MyDurableObject>;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// Handle API requests
		if (url.pathname.startsWith("/api") || request.headers.has("x-amz-target")) {
			try {
				return await handleDynamoRequest(request, env);
			} catch (err: any) {
				return new Response(JSON.stringify({ __type: "InternalServerError", message: err.message }), {
					status: 500,
					headers: { "Content-Type": "application/x-amts-json-1.0" }
				});
			}
		}

		// Fallback for assets
		return new Response("Not Found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;

async function handleDynamoRequest(request: Request, env: Env): Promise<Response> {
	const target = request.headers.get("x-amz-target");
	if (!target) {
		return new Response("Missing x-amz-target header", { status: 400 });
	}

	const body = await request.json() as any;
	const strings = target.split(".");
	const operation = strings[strings.length - 1];

	// Extract TableName and Key to determine partition
	// In strict DynamoDB, TableName is the table.
	// For shvm-db MVP, we map TableName + PartitionKey to the Durable Object?
	// The README says: "One partition == one Durable Object".
	// "partition_id = hash(PK)"
	// We need to find the PK from the body.

	let pk: string | undefined;

	// Helper to extract PK from Item or Key
	const getPk = (item: any) => {
		// Assumption: PK is the first key or explicitly named "PK" (as per README data model)
		// README: "PK": "...", "SK": "..."
		// But DynamoDB uses AttributeDefinitions.
		// For MVP, let's enforce "PK" as the partition key name for simplicity, 
		// or attempt to detect `PK` or `id`.
		if (item?.PK?.S) return item.PK.S;
		if (item?.pk?.S) return item.pk.S;
		if (item?.id?.S) return item.id.S;
		// Fallback: use the first key that looks like a string
		return "default";
	};

	if (operation === "PutItem") {
		pk = getPk(body.Item);
	} else if (operation === "GetItem" || operation === "DeleteItem" || operation === "UpdateItem") {
		pk = getPk(body.Key);
	} else if (operation === "Query") {
		// Query usually specifies KeyConditionExpression or Key
		// We might need to parse ExpressionAttributeValues to find PK.
		// MVP: Require "PK = :pk" and look in ExpressionAttributeValues
		if (body.ExpressionAttributeValues) {
			for (const key in body.ExpressionAttributeValues) {
				if (body.ExpressionAttributeValues[key].S) {
					// Heuristic: first string value is likely PK if strict schema isn't known
					// Ideally we parse the condition.
					// Let's just look for a value named :pk or :v1
					if (key === ":pk" || key === ":id") pk = body.ExpressionAttributeValues[key].S;
				}
			}
		}
	}

	if (!pk) {
		pk = "default"; // Fallback
	}

	const id = env.MY_DURABLE_OBJECT.idFromName(pk);
	const stub = env.MY_DURABLE_OBJECT.get(id);

	let result: any;

	switch (operation) {
		case "PutItem":
			// body.Item is { PK: { S: "..." }, ... }
			// We store generic JSON in SQLite.
			// Extract SK if present
			let sk = body.Item.SK?.S || body.Item.sk?.S || "default";
			await stub.putItem(sk, body.Item);
			result = {}; // DynamoDB PutItem returns empty unless ReturnValues is set
			break;

		case "GetItem":
			let getSk = body.Key.SK?.S || body.Key.sk?.S || "default";
			const item = await stub.getItem(getSk);
			result = item ? { Item: item } : {};
			break;

		case "Query":
			// MVP: Supports basic prefix query on SK?
			// DO query method expects prefix
			// Let's just return all for now or empty
			const items = (await stub.query("")) as unknown[];
			result = { Items: items, Count: items.length };
			break;

		default:
			return new Response(`Operation ${operation} not implemented`, { status: 400 });
	}

	return new Response(JSON.stringify(result), {
		headers: {
			"Content-Type": "application/x-amz-json-1.0"
		}
	});
}
