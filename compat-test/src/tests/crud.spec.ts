import { describe, it, beforeAll, afterAll } from "vitest";
import { CreateTableCommand, DeleteTableCommand, PutItemCommand, GetItemCommand, DeleteItemCommand } from "@aws-sdk/client-dynamodb";
import { executeAgainstBoth } from "../testHarness";

describe("Item APIs (CRUD)", () => {
    const tableName = `test-crud-${crypto.randomUUID()}`;

    beforeAll(async () => {
        // executeAgainstBoth will run the create table against both
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

    it("PutItem - Basic String", async () => {
        const cmd = new PutItemCommand({
            TableName: tableName,
            Item: {
                pk: { S: "item1" },
                name: { S: "shivam" }
            }
        });
        await executeAgainstBoth(client => client.send(cmd));
    });

    it("GetItem - Basic String", async () => {
        const cmd = new GetItemCommand({
            TableName: tableName,
            Key: {
                pk: { S: "item1" }
            }
        });
        await executeAgainstBoth(client => client.send(cmd));
    });

    it("GetItem - Non-existent Item", async () => {
        const cmd = new GetItemCommand({
            TableName: tableName,
            Key: {
                pk: { S: "does_not_exist" }
            }
        });
        await executeAgainstBoth(client => client.send(cmd));
    });

    it("PutItem - All Core Data Types", async () => {
        const cmd = new PutItemCommand({
            TableName: tableName,
            Item: {
                pk: { S: "item-types" },
                str: { S: "hello" },
                num: { N: "42.5" },
                bin: { B: new Uint8Array([1, 2, 3]) },
                boolTrue: { BOOL: true },
                boolFalse: { BOOL: false },
                nullVal: { NULL: true },
                listVal: { L: [{ S: "a" }, { N: "1" }] },
                mapVal: { M: { key1: { S: "val1" } } },
                strSet: { SS: ["a", "b", "c"] },
                numSet: { NS: ["1.1", "2.2", "3.3"] },
                binSet: { BS: [new Uint8Array([1]), new Uint8Array([2])] }
            }
        });
        await executeAgainstBoth(client => client.send(cmd));

        const getCmd = new GetItemCommand({
            TableName: tableName,
            Key: {
                pk: { S: "item-types" }
            }
        });
        await executeAgainstBoth(client => client.send(getCmd));
    });

    it("DeleteItem - Existing", async () => {
        const cmd = new DeleteItemCommand({
            TableName: tableName,
            Key: {
                pk: { S: "item1" }
            }
        });
        await executeAgainstBoth(client => client.send(cmd));
    });

    it("DeleteItem - Non-existent", async () => {
        const cmd = new DeleteItemCommand({
            TableName: tableName,
            Key: {
                pk: { S: "item999" }
            }
        });
        await executeAgainstBoth(client => client.send(cmd));
    });
});
