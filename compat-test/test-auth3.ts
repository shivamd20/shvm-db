import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";

const client = new DynamoDBClient({
    region: "local",
    endpoint: "http://localhost:8787/api/",
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
        console.log("Success item 1");
    } catch (e: any) {
        console.error("ERROR 1:", e);
    }

    try {
        let nestedMap: any = { S: "bottom" };
        for (let i = 0; i < 33; i++) {
            nestedMap = { M: { level: nestedMap } };
        }
        await client.send(new PutItemCommand({
            TableName: "test-auth-table",
            Item: {
                pk: { S: "nested" },
                deep: nestedMap
            }
        }));
        console.log("Success item 2");
    } catch (e: any) {
        console.error("ERROR 2:", e);
    }
}
run();
