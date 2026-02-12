
import { describe, it, expect } from "vitest";
import { TestClient } from "./utils";

// Helper to delay
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Replication & Read Distribution", () => {
    it("should replicate data to all followers and allow reading from them", async () => {
        const client = new TestClient(); // No env needed in constructor as per utils.ts
        const tableName = `ReplicationTest-${Date.now()}`;

        // 1. Create Table
        await client.dynamoRequest("DynamoDB_20120810.CreateTable", {
            TableName: tableName,
            KeySchema: [
                { AttributeName: "pk", KeyType: "HASH" },
                { AttributeName: "sk", KeyType: "RANGE" }
            ],
            AttributeDefinitions: [
                { AttributeName: "pk", AttributeType: "S" },
                { AttributeName: "sk", AttributeType: "S" }
            ],
            ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 }
        });

        // 2. Put Item
        await client.dynamoRequest("DynamoDB_20120810.PutItem", {
            TableName: tableName,
            Item: {
                pk: { S: "user1" },
                sk: { S: "profile" },
                data: { S: "replicated-data" }
            }
        });

        // Allow some time for async replication
        await sleep(1000);

        // 3. Read multiple times
        let successCount = 0;
        const attempts = 20;

        for (let i = 0; i < attempts; i++) {
            const res = await client.dynamoRequest("DynamoDB_20120810.GetItem", {
                TableName: tableName,
                Key: {
                    pk: { S: "user1" },
                    sk: { S: "profile" }
                }
            });

            const json = await res.json() as any;
            if (json.Item && json.Item.data && json.Item.data.S === "replicated-data") {
                successCount++;
            }
        }

        console.log(`Success count: ${successCount}/${attempts}`);
        expect(successCount).toBeGreaterThan(15);
    });
});
