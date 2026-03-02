import { expect, test, describe } from "vitest";
import { CreateTableCommand, DeleteTableCommand, DescribeTableCommand, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { executeAgainstBoth } from "../testHarness.js";
import { randomUUID } from "node:crypto";

describe("Table APIs", () => {
    const tableName = `test-table-${randomUUID()}`;

    test("CreateTable", async () => {
        await executeAgainstBoth((client) =>
            client.send(new CreateTableCommand({
                TableName: tableName,
                KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
                AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
                BillingMode: "PAY_PER_REQUEST",
            }))
        );
    });

    test("CreateTable - Duplicate", async () => {
        await executeAgainstBoth((client) =>
            client.send(new CreateTableCommand({
                TableName: tableName,
                KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
                AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
                BillingMode: "PAY_PER_REQUEST",
            }))
        );
    });

    test("DescribeTable", async () => {
        await executeAgainstBoth((client) =>
            client.send(new DescribeTableCommand({
                TableName: tableName,
            }))
        );
    });

    test("DescribeTable - Non-existent", async () => {
        await executeAgainstBoth((client) =>
            client.send(new DescribeTableCommand({
                TableName: `non-existent-${randomUUID()}`,
            }))
        );
    });

    test("ListTables", async () => {
        await executeAgainstBoth((client) =>
            client.send(new ListTablesCommand({}))
        );
    });

    test("DeleteTable", async () => {
        await executeAgainstBoth((client) =>
            client.send(new DeleteTableCommand({
                TableName: tableName,
            }))
        );
    });

    test("DeleteTable - Non-existent", async () => {
        await executeAgainstBoth((client) =>
            client.send(new DeleteTableCommand({
                TableName: `non-existent-${randomUUID()}`,
            }))
        );
    });

    test("CreateTable - Invalid KeySchema", async () => {
        await executeAgainstBoth((client) =>
            client.send(new CreateTableCommand({
                TableName: `invalid-${randomUUID()}`,
                KeySchema: [],
                AttributeDefinitions: [],
                BillingMode: "PAY_PER_REQUEST",
            }))
        );
    });
});
