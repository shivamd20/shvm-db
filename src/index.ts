import { DurableObject } from "cloudflare:workers";
import { PartitionDO } from "./partition-do";
import { SubDO } from "./sub-do";

export { PartitionDO, SubDO };

// Environment bindings
export interface Env {
	PARTITION_DO: DurableObjectNamespace<PartitionDO>;
	SUB_DO: DurableObjectNamespace<SubDO>;
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
					headers: { "Content-Type": "application/x-amz-json-1.0" }
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

	let pk: string | undefined;

	// Helper to extract PK from Item or Key
	const getPk = (item: any) => {
		if (item?.PK?.S) return item.PK.S;
		if (item?.pk?.S) return item.pk.S;
		if (item?.id?.S) return item.id.S;
		return "default";
	};

	if (operation === "PutItem") {
		pk = getPk(body.Item);
	} else if (operation === "GetItem" || operation === "DeleteItem" || operation === "UpdateItem") {
		pk = getPk(body.Key);
	}

	if (!pk) {
		pk = "default"; // Fallback
	}

	// MVP: Routing to PartitionDO based on PK
	const id = env.PARTITION_DO.idFromName(pk);
	const stub = env.PARTITION_DO.get(id);

	let result: any;

	switch (operation) {
		case "PutItem":
			// body.Item is { PK: { S: "..." }, ... }
			let skCheck = body.Item.SK?.S || body.Item.sk?.S;
			if (!skCheck) throw new Error("Missing SK in Item - Required for Partitioning");
			await stub.putItem(skCheck, body.Item);
			result = {};
			break;

		case "GetItem":
			let getSk = body.Key.SK?.S || body.Key.sk?.S;
			if (!getSk) throw new Error("Missing SK in Key - Required for Partitioning");
			const item = await stub.getItem(getSk);
			result = item ? { Item: item } : {};
			break;

		case "DeleteItem":
			let delSk = body.Key.SK?.S || body.Key.sk?.S;
			if (!delSk) throw new Error("Missing SK in Key - Required for Partitioning");
			await stub.deleteItem(delSk);
			result = {};
			break;

		case "Query":
			return new Response(`Operation ${operation} not implemented`, { status: 501 });

		default:
			return new Response(`Operation ${operation} not implemented`, { status: 400 });
	}

	return new Response(JSON.stringify(result), {
		headers: {
			"Content-Type": "application/x-amz-json-1.0"
		}
	});
}
