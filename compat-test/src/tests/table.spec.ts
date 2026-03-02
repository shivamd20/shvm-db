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

    test("ListTables - Basic", async () => {
        await executeAgainstBoth((client) =>
            client.send(new ListTablesCommand({}))
        );
    });

    test("ListTables - Pagination with Limit", async () => {
        // We ensure there's at least one table by creating one.
        // It's hard to test exact counts against oracle because other tests run, 
        // but we can test that Limit works and we get a LastEvaluatedTableName if there are more tables than Limit
        await executeAgainstBoth(async (client) => {
            const tableA = `test-list-table-${randomUUID()}`;
            const tableB = `test-list-table-${randomUUID()}`;

            await client.send(new CreateTableCommand({
                TableName: tableA,
                KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
                AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
                BillingMode: "PAY_PER_REQUEST",
            }));
            await client.send(new CreateTableCommand({
                TableName: tableB,
                KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
                AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
                BillingMode: "PAY_PER_REQUEST",
            }));

            const res1 = await client.send(new ListTablesCommand({ Limit: 1 }));

            // Should return at least 1 table, and have LastEvaluatedTableName since we have >= 2 tables
            let nextTablesResult;
            if (res1.LastEvaluatedTableName) {
                nextTablesResult = await client.send(new ListTablesCommand({
                    Limit: 1,
                    ExclusiveStartTableName: res1.LastEvaluatedTableName
                }));
            }

            // Clean up
            await client.send(new DeleteTableCommand({ TableName: tableA }));
            await client.send(new DeleteTableCommand({ TableName: tableB }));

            return {
                res1NamesLength: res1.TableNames?.length,
                res1HasLastEval: !!res1.LastEvaluatedTableName,
                res2NamesLength: nextTablesResult?.TableNames?.length,
            };
        });
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
