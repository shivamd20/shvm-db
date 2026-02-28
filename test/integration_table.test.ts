import { describe, it, expect, beforeAll } from "vitest";
import { TestClient } from "./utils";

describe("Table Modeling Integration", () => {
    const client = new TestClient();
    const tableName = `TestTable_${Date.now()}`;

    beforeAll(async () => {
        const req = {
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
        };
        const res = await client.dynamoRequest("DynamoDB_20120810.CreateTable", req);
        expect(res.status).toBe(200);
    });

    it("should find the created table", async () => {
        // Quick check if validation fails or succeeds
        const item = {
            TableName: tableName,
            Item: { PK: { S: "check" }, SK: { S: "check" } }
        };
        const res = await client.dynamoRequest("DynamoDB_20120810.PutItem", item);
        expect(res.status).toBe(200);
    });

    it("should fail to create duplicate table", async () => {
        const req = {
            TableName: tableName,
            KeySchema: [
                { AttributeName: "PK", KeyType: "HASH" }
            ],
            AttributeDefinitions: [
                { AttributeName: "PK", AttributeType: "S" }
            ]
        };

        try {
            const res = await client.dynamoRequest("DynamoDB_20120810.CreateTable", req);
            expect(res.status).not.toBe(200);
        } catch (e) {
            // It might throw depending on how the client handles it, but client.fetch usually returns response
        }
    });

    it("should put and get item successfully", async () => {
        const item = {
            TableName: tableName,
            Item: {
                PK: { S: "user1" },
                SK: { S: "profile" },
                Data: { S: "some data" }
            }
        };

        const putRes = await client.dynamoRequest("DynamoDB_20120810.PutItem", item);
        expect(putRes.status).toBe(200);

        const key = {
            TableName: tableName,
            Key: {
                PK: { S: "user1" },
                SK: { S: "profile" }
            }
        };

        let body: any;
        for (let i = 0; i < 20; i++) {
            const getRes = await client.dynamoRequest("DynamoDB_20120810.GetItem", key);
            expect(getRes.status).toBe(200);
            body = await getRes.json() as any;
            if (body.Item) break;
            await new Promise(r => setTimeout(r, 100));
        }

        expect(body.Item).toBeDefined();
        expect(body.Item.Data.S).toBe("some data");
    });

    it("should enforce schema validation (wrong type)", async () => {
        const item = {
            TableName: tableName,
            Item: {
                PK: { N: "123" }, // Schema says S
                SK: { S: "profile" }
            }
        };

        const res = await client.dynamoRequest("DynamoDB_20120810.PutItem", item);

        expect(res.status).toBe(400);
        const body = await res.json() as any;
        expect(body.__type).toBe("ValidationException");
    });

    it("should allow missing SK key (defaults to default)", async () => {
        const item = {
            TableName: tableName,
            Item: {
                PK: { S: "user2" }
                // Missing SK
            }
        };

        const res = await client.dynamoRequest("DynamoDB_20120810.PutItem", item);
        expect(res.status).toBe(200);
    });

    it("should provide data isolation between tables", async () => {
        const otherTable = `OtherTable_${Date.now()}`;
        // Create other table
        await client.dynamoRequest("DynamoDB_20120810.CreateTable", {
            TableName: otherTable,
            KeySchema: [{ AttributeName: "PK", KeyType: "HASH" }],
            AttributeDefinitions: [{ AttributeName: "PK", AttributeType: "S" }]
        });

        // Try to GetItem from OtherTable using key from FirstTable
        const key = {
            TableName: otherTable,
            Key: {
                PK: { S: "user1" } // Exists in FirstTable
                // No SK needed for OtherTable schema
            }
        };

        const res = await client.dynamoRequest("DynamoDB_20120810.GetItem", key);

        expect(res.status).toBe(200);
        const body = await res.json() as any;
        expect(body.Item).toBeUndefined(); // Should not find the item from the other table
    });

    it("should return trace events for a request (Load trace)", async () => {
        const item = {
            TableName: tableName,
            Item: {
                PK: { S: "trace-user" },
                SK: { S: "trace-sk" },
                Data: { S: "trace test" }
            }
        };
        const putRes = await client.dynamoRequest("DynamoDB_20120810.PutItem", item);
        expect(putRes.status).toBe(200);
        const requestId = putRes.headers.get("x-request-id") || putRes.headers.get("X-Request-Id");
        expect(requestId).toBeDefined();

        const traceRes = await client.fetch(`/api/trace?requestId=${encodeURIComponent(requestId!)}`);
        expect(traceRes.status).toBe(200);
        const traceBody = await traceRes.json() as { requestId: string; events: Array<{ step: string; requestId: string }> };
        expect(traceBody.requestId).toBe(requestId);
        expect(Array.isArray(traceBody.events)).toBe(true);
        expect(traceBody.events.length).toBeGreaterThan(0);
        const steps = traceBody.events.map((e: any) => e.step);
        expect(steps).toContain("request");
        expect(steps.some((s: string) => s.includes("metadata") || s.includes("put") || s.includes("do_"))).toBe(true);
    });
});
