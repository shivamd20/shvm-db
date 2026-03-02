import { describe, it, beforeAll, afterAll } from "vitest";
import { CreateTableCommand, DeleteTableCommand, PutItemCommand, QueryCommand, ScanCommand } from "@aws-sdk/client-dynamodb";
import { executeAgainstBoth } from "../testHarness";

describe.skip("Query and Scan APIs", () => {
    const tableName = `test-query-${crypto.randomUUID()}`;

    beforeAll(async () => {
        // Create a table with a Hash and Range key for Query testing
        await executeAgainstBoth(client => client.send(new CreateTableCommand({
            TableName: tableName,
            KeySchema: [
                { AttributeName: "pk", KeyType: "HASH" },
                { AttributeName: "sk", KeyType: "RANGE" }
            ],
            AttributeDefinitions: [
                { AttributeName: "pk", AttributeType: "S" },
                { AttributeName: "sk", AttributeType: "N" }
            ],
            BillingMode: "PAY_PER_REQUEST"
        })));

        // Seed data
        const items = [
            { pk: { S: "user1" }, sk: { N: "10" }, data: { S: "a" } },
            { pk: { S: "user1" }, sk: { N: "20" }, data: { S: "b" } },
            { pk: { S: "user1" }, sk: { N: "30" }, data: { S: "c" } },
            { pk: { S: "user2" }, sk: { N: "10" }, data: { S: "d" } }
        ];

        for (const item of items) {
            await executeAgainstBoth(client => client.send(new PutItemCommand({
                TableName: tableName,
                Item: item
            })));
        }
    });

    afterAll(async () => {
        await executeAgainstBoth(client => client.send(new DeleteTableCommand({
            TableName: tableName
        })));
    });

    it("Query - Exact PK matches", async () => {
        const cmd = new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: "pk = :pk",
            ExpressionAttributeValues: {
                ":pk": { S: "user1" }
            }
        });
        await executeAgainstBoth(client => client.send(cmd));
    });

    it("Query - PK and Exact SK match", async () => {
        const cmd = new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: "pk = :pk AND sk = :sk",
            ExpressionAttributeValues: {
                ":pk": { S: "user1" },
                ":sk": { N: "20" }
            }
        });
        await executeAgainstBoth(client => client.send(cmd));
    });

    it("Query - Less than SK", async () => {
        const cmd = new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: "pk = :pk AND sk < :sk",
            ExpressionAttributeValues: {
                ":pk": { S: "user1" },
                ":sk": { N: "25" }
            }
        });
        await executeAgainstBoth(client => client.send(cmd));
    });

    it("Query - Limit and Pagination", async () => {
        const cmd1 = new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: "pk = :pk",
            ExpressionAttributeValues: {
                ":pk": { S: "user1" }
            },
            Limit: 2
        });
        // We cannot just pass cmd1 directly if we need to extract LastEvaluatedKey to chain tests.
        // For Differential execution, if Limit is 2 and we have 3 items, LastEvaluatedKey will be returned.
        // We just assert they behave the same on the first page!
        await executeAgainstBoth(client => client.send(cmd1));
    });

    it("Scan - Full Table", async () => {
        const cmd = new ScanCommand({
            TableName: tableName
        });
        await executeAgainstBoth(client => client.send(cmd));
    });

    it("Scan - With Limit", async () => {
        const cmd = new ScanCommand({
            TableName: tableName,
            Limit: 2
        });
        await executeAgainstBoth(client => client.send(cmd));
    });
});
