import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";

const client = new DynamoDBClient({
    region: "local",
    endpoint: "http://localhost:53803/api/", // Cloudflare bound port from earlier
    credentials: { accessKeyId: "x", secretAccessKey: "x" },
});

async function run() {
    try {
        await client.send(new PutItemCommand({
            TableName: "test-auth-table",
            Item: {
                pk: { S: "empty" },
                emptyMap: { M: {} },
                emptyList: { L: [] }
            }
        }));
    } catch (e: any) {
        console.error("ERROR", e);
    }
}
run();
