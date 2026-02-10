import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { TestClient } from "./utils";

describe("Functional Tests (DynamoDB Parity)", () => {
    const client = new TestClient();
    const tableName = "TestTable";
    const pk = "user_functional_test";
    const skPrefix = "meta_";

    // Helper to generate unique SKs
    const generateSk = () => `${skPrefix}${Date.now()}_${Math.random()}`;

    // Create table for functional tests
    beforeAll(async () => {
        try {
            await client.dynamoRequest("DynamoDB_20120810.CreateTable", {
                TableName: tableName,
                KeySchema: [
                    { AttributeName: "PK", KeyType: "HASH" },
                    { AttributeName: "SK", KeyType: "RANGE" }
                ],
                AttributeDefinitions: [
                    { AttributeName: "PK", AttributeType: "S" },
                    { AttributeName: "SK", AttributeType: "S" }
                ],
                ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 }
            });
        } catch (e) {
            // Ignore if already exists (though likely fresh env)
        }
    });




    it("should PutItem and GetItem correctly", async () => {
        const sk = generateSk();
        const item = {
            PK: { S: pk },
            SK: { S: sk },
            data: { S: "test_value" }
        };

        // PutItem
        const putRes = await client.dynamoRequest("DynamoDB_20120810.PutItem", {
            TableName: tableName,
            Item: item
        });
        expect(putRes.status).toBe(200);

        // GetItem
        const getRes = await client.dynamoRequest("DynamoDB_20120810.GetItem", {
            TableName: tableName,
            Key: {
                PK: { S: pk },
                SK: { S: sk }
            }
        });
        expect(getRes.status).toBe(200);
        const body = await getRes.json() as any;
        expect(body.Item).toEqual(item);
    });

    it("should return empty when GetItem item does not exist", async () => {
        const sk = generateSk();
        const getRes = await client.dynamoRequest("DynamoDB_20120810.GetItem", {
            TableName: tableName,
            Key: {
                PK: { S: pk },
                SK: { S: "non_existent_sk" }
            }
        });
        expect(getRes.status).toBe(200);
        const body = await getRes.json() as any;
        expect(body.Item).toBeUndefined(); // DynamoDB returns empty object or just no Item property
        // Note: Our implementation currently returns { Item: null } if not found, 
        // which might deviate from strict DynamoDB (which returns empty {}).
        // Let's adjust expectation based on typical DynamoDB SDK behavior if we want strict parity,
        // but for now we check what our implementation does or should do.
        // Current impl returns null. TODO: Fix to match DynamoDB.
    });

    it("should fail Query (Not Implemented)", async () => {
        // Query is disabled for MVP
        const queryRes = await client.dynamoRequest("DynamoDB_20120810.Query", {
            TableName: tableName,
            KeyConditionExpression: "PK = :pk",
            ExpressionAttributeValues: { ":pk": { S: pk } }
        });

        expect(queryRes.status).toBe(501);
    });

    it.skip("should UpdateItem (mocked/missing)", async () => {
        // ... UpdateItem remains skipped
    });

    it("should DeleteItem", async () => {
        const sk = generateSk();
        await client.dynamoRequest("DynamoDB_20120810.PutItem", {
            TableName: tableName,
            Item: { PK: { S: pk }, SK: { S: sk }, val: { S: "to_delete" } }
        });

        const delRes = await client.dynamoRequest("DynamoDB_20120810.DeleteItem", {
            TableName: tableName,
            Key: { PK: { S: pk }, SK: { S: sk } }
        });

        expect(delRes.status).toBe(200);

        // Verify it's gone
        const getRes = await client.dynamoRequest("DynamoDB_20120810.GetItem", {
            TableName: tableName,
            Key: { PK: { S: pk }, SK: { S: sk } }
        });
        const body = await getRes.json() as any;
        expect(body.Item).toBeUndefined(); // or null/empty depending on impl, strictly DynamoDB returns empty object but our impl returns empty object or null?
        // Index.ts: result = item ? { Item: item } : {};
        // So if item is null, result is {}. body.Item is undefined. Correct.
    });
});
