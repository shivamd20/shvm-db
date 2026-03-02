import { describe, it, beforeAll, afterAll } from "vitest";
import { CreateTableCommand, DeleteTableCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { executeAgainstBoth } from "../testHarness";

describe("Input Validation and Edge Cases", () => {
    const tableName = `test-validation-${crypto.randomUUID()}`;

    beforeAll(async () => {
        await executeAgainstBoth(client => client.send(new CreateTableCommand({
            TableName: tableName,
            KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
            AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
            BillingMode: "PAY_PER_REQUEST"
        })));
    });

    afterAll(async () => {
        await executeAgainstBoth(client => client.send(new DeleteTableCommand({
            TableName: tableName
        })));
    });

    it("PutItem - Missing PK", async () => {
        const cmd = new PutItemCommand({
            TableName: tableName,
            Item: {
                name: { S: "shivam" }
            }
        });
        await executeAgainstBoth(client => client.send(cmd));
    });

    it("PutItem - Empty String in PK", async () => {
        const cmd = new PutItemCommand({
            TableName: tableName,
            Item: {
                pk: { S: "" },
                name: { S: "shivam" }
            }
        });
        await executeAgainstBoth(client => client.send(cmd));
    });

    it("PutItem - Empty String in Non-Key Attribute (Supported now)", async () => {
        const cmd = new PutItemCommand({
            TableName: tableName,
            Item: {
                pk: { S: "empty-string" },
                emptyStr: { S: "" }
            }
        });
        await executeAgainstBoth(client => client.send(cmd));
    });

    it("PutItem - Empty Set", async () => {
        const cmd = new PutItemCommand({
            TableName: tableName,
            Item: {
                pk: { S: "empty-set" },
                strSet: { SS: [] }
            }
        });
        await executeAgainstBoth(client => client.send(cmd));
    });

    it("PutItem - Duplicate Elements in Set", async () => {
        const cmd = new PutItemCommand({
            TableName: tableName,
            Item: {
                pk: { S: "duplicate-set" },
                strSet: { SS: ["a", "a", "b"] }
            }
        });
        await executeAgainstBoth(client => client.send(cmd));
    });

    it("PutItem - Item Size > 400KB", async () => {
        // Create a 401KB string
        const largeString = "a".repeat(401 * 1024);
        const cmd = new PutItemCommand({
            TableName: tableName,
            Item: {
                pk: { S: "large-item" },
                data: { S: largeString }
            }
        });
        await executeAgainstBoth(client => client.send(cmd));
    });

    it("PutItem - Type Mismatch on PK", async () => {
        const cmd = new PutItemCommand({
            TableName: tableName,
            Item: {
                pk: { N: "123" }
            }
        });
        await executeAgainstBoth(client => client.send(cmd));
    });

    it("PutItem - PK Size > 2048 bytes", async () => {
        const largePk = "a".repeat(2049);
        const cmd = new PutItemCommand({
            TableName: tableName,
            Item: {
                pk: { S: largePk },
                data: { S: "data" }
            }
        });
        await executeAgainstBoth(client => client.send(cmd));
    });

    it("PutItem - Deeply Nested Map (> 32 levels)", async () => {
        let nestedMap: any = { S: "bottom" };
        for (let i = 0; i < 33; i++) {
            nestedMap = { M: { level: nestedMap } };
        }

        const cmd = new PutItemCommand({
            TableName: tableName,
            Item: {
                pk: { S: "nested" },
                deep: nestedMap
            }
        });
        await executeAgainstBoth(client => client.send(cmd));
    });

    it("PutItem - Empty Map and Empty List (Valid)", async () => {
        const cmd = new PutItemCommand({
            TableName: tableName,
            Item: {
                pk: { S: "empty-structures" },
                emptyMap: { M: {} },
                emptyList: { L: [] }
            }
        });
        await executeAgainstBoth(client => client.send(cmd));
    });
});
