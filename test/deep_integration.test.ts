/**
 * DEEP INTEGRATION TESTS for ShvmDB
 * 
 * Each test is fully self-contained — creates its own table, operates on it,
 * and asserts results, all within one `it()` block to avoid vitest pool-workers
 * isolated storage limitations.
 * 
 * Tests are ordered from simple → deep:
 * 1. Table CRUD
 * 2. Data Operations + Debug Headers
 * 3. Partition Distribution
 * 4. Data Isolation Between Tables
 * 5. Sort Key Operations
 * 6. Schema Validation
 * 7. Deletion & Tombstoning
 * 8. Overwrite / Versioning
 * 9. Unsupported Operations
 * 10. Edge Cases & Error Handling
 * 11. Debug Header Completeness
 */

import { describe, it, expect } from "vitest";
import { TestClient } from "./utils";

// ============================================================================
// 1. TABLE LIFECYCLE
// ============================================================================
describe("1. Table Lifecycle", () => {
    const client = new TestClient();

    it("should create a table and describe it", async () => {
        const tableName = TestClient.uniqueTableName("Create");
        const res = await client.createTable(tableName, { hashKey: "PK", rangeKey: "SK" });
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        expect(body.Table).toBeDefined();
        expect(body.Table.TableName).toBe(tableName);
        expect(body.Table.TableStatus).toBe("ACTIVE");
        expect(body.Table.KeySchema).toHaveLength(2);

        // DescribeTable
        const descRes = await client.describeTable(tableName);
        expect(descRes.status).toBe(200);
        const descBody = await descRes.json() as any;
        expect(descBody.Table.TableName).toBe(tableName);
        expect(descBody.Table.TableStatus).toBe("ACTIVE");
        expect(descBody.Table.KeySchema[0].KeyType).toBe("HASH");
        console.log(`[TEST] Created & described table: ${tableName}`);
    });

    it("should fail to create a duplicate table", async () => {
        const tableName = TestClient.uniqueTableName("Dup");
        const res1 = await client.createTable(tableName, { hashKey: "PK" });
        expect(res1.status).toBe(200);

        const res2 = await client.createTable(tableName, { hashKey: "PK" });
        expect(res2.status).not.toBe(200);
        console.log(`[TEST] Duplicate table rejected, status=${res2.status}`);
    });

    it("should list created tables", async () => {
        const tableName = TestClient.uniqueTableName("List");
        await client.createTable(tableName, { hashKey: "PK" });

        const listRes = await client.listTables(100);
        expect(listRes.status).toBe(200);
        const body = await listRes.json() as any;
        expect(body.TableNames).toContain(tableName);
        console.log(`[TEST] ListTables contains: ${JSON.stringify(body.TableNames)}`);
    });

    it("should delete a table and verify it is gone", async () => {
        const tableName = TestClient.uniqueTableName("Del");
        await client.createTable(tableName, { hashKey: "PK", rangeKey: "SK" });

        const delRes = await client.deleteTable(tableName);
        expect(delRes.status).toBe(200);
        const body = await delRes.json() as any;
        expect(body.Table.TableStatus).toBe("DELETING");

        // Verify gone
        const descRes = await client.describeTable(tableName);
        expect(descRes.status).not.toBe(200);
        console.log(`[TEST] Table deleted: ${tableName}`);
    });

    it("should reject describe on non-existent table", async () => {
        const res = await client.describeTable("NoSuchTable_" + Date.now());
        expect(res.status).toBe(400);
        const body = await res.json() as any;
        expect(body.__type).toBe("ResourceNotFoundException");
    });
});

// ============================================================================
// 2. BASIC CRUD + DEBUG HEADERS
// ============================================================================
describe("2. Basic CRUD with Debug Headers", () => {
    const client = new TestClient();

    it("should PutItem and return debug headers", async () => {
        const tableName = TestClient.uniqueTableName("CRUDPut");
        await client.createTable(tableName, { hashKey: "PK", rangeKey: "SK" });

        const res = await client.putItem(tableName, {
            PK: { S: "user_100" },
            SK: { S: "profile" },
            Name: { S: "Alice" }
        });
        expect(res.status).toBe(200);

        const dbg = TestClient.getDebugHeaders(res);
        console.log("[TEST] PutItem debug headers:", JSON.stringify(dbg));

        expect(dbg["x-shivam-db-partition-id-internal"]).toBeDefined();
        expect(dbg["x-shivam-db-partition-key"]).toContain(tableName);
        expect(dbg["x-shivam-db-partition-key"]).toContain("partition-");
        expect(dbg["x-shivam-db-table"]).toBe(tableName);
        expect(dbg["x-shivam-db-op"]).toBe("PutItem");
        expect(dbg["x-shivam-db-sub-do-reached-ts"]).toBeDefined();
        expect(dbg["x-shivam-db-sub-do-latency-ms"]).toBeDefined();
        expect(dbg["x-shivam-db-leader-do"]).toContain("leader");
        expect(dbg["x-shivam-db-sk"]).toBe("profile");
    });

    it("should PutItem then GetItem correctly (same partition)", async () => {
        const tableName = TestClient.uniqueTableName("CRUDGet");
        await client.createTable(tableName, { hashKey: "PK", rangeKey: "SK" });

        // Put
        const putRes = await client.putItem(tableName, {
            PK: { S: "user_200" },
            SK: { S: "settings" },
            Theme: { S: "dark" }
        });
        const putPid = TestClient.getDebugHeaders(putRes)["x-shivam-db-partition-id-internal"];

        // Get
        const getRes = await client.getItem(tableName, {
            PK: { S: "user_200" },
            SK: { S: "settings" }
        });
        expect(getRes.status).toBe(200);
        const body = await getRes.json() as any;
        expect(body.Item).toBeDefined();
        expect(body.Item.Theme.S).toBe("dark");

        // Same PK should route to same partition
        const getPid = TestClient.getDebugHeaders(getRes)["x-shivam-db-partition-id-internal"];
        expect(getPid).toBe(putPid);

        // Read target should be the leader (no replicas)
        const readTarget = TestClient.getDebugHeaders(getRes)["x-shivam-db-read-target"];
        expect(readTarget).toContain("leader");
        console.log(`[TEST] PK=user_200 -> partition=${putPid}, readTarget=${readTarget}`);
    });

    it("should return empty object when item not found", async () => {
        const tableName = TestClient.uniqueTableName("CRUDMiss");
        await client.createTable(tableName, { hashKey: "PK", rangeKey: "SK" });

        const res = await client.getItem(tableName, {
            PK: { S: "nonexistent_pk_12345" },
            SK: { S: "nope" }
        });
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        expect(body.Item).toBeUndefined();
    });
});

// ============================================================================
// 3. MULTI-PARTITION DISTRIBUTION
// ============================================================================
describe("3. Multi-Partition Distribution", () => {
    const client = new TestClient();

    it("should distribute items across multiple partitions (10 keys)", async () => {
        const tableName = TestClient.uniqueTableName("Dist");
        await client.createTable(tableName, { hashKey: "PK", rangeKey: "SK" });

        const partitionIds = new Set<string>();

        for (let i = 0; i < 10; i++) {
            const pk = `dist_key_${i}_${Math.random().toString(36).slice(2)}`;
            const res = await client.putItem(tableName, {
                PK: { S: pk },
                SK: { S: "data" },
                Val: { S: `item_${i}` }
            });
            expect(res.status).toBe(200);
            partitionIds.add(TestClient.getDebugHeaders(res)["x-shivam-db-partition-id-internal"]);
        }

        console.log(`[TEST] 10 items -> ${partitionIds.size} partitions: ${[...partitionIds].sort((a, b) => +a - +b).join(", ")}`);
        // With 10 random keys mod 100, expect at least 2 different partitions
        expect(partitionIds.size).toBeGreaterThanOrEqual(2);
    });

    it("should route same PK to same partition deterministically", async () => {
        const tableName = TestClient.uniqueTableName("Det");
        await client.createTable(tableName, { hashKey: "PK", rangeKey: "SK" });

        const fixedPK = "deterministic_pk_test_value";

        const res1 = await client.putItem(tableName, {
            PK: { S: fixedPK }, SK: { S: "first" }, Val: { S: "a" }
        });
        const res2 = await client.putItem(tableName, {
            PK: { S: fixedPK }, SK: { S: "second" }, Val: { S: "b" }
        });

        const pid1 = TestClient.getDebugHeaders(res1)["x-shivam-db-partition-id-internal"];
        const pid2 = TestClient.getDebugHeaders(res2)["x-shivam-db-partition-id-internal"];
        expect(pid1).toBe(pid2);
        console.log(`[TEST] Same PK "${fixedPK}" -> partition ${pid1} (verified 2x)`);
    });

    it("partition ID should always be 0-99", async () => {
        const tableName = TestClient.uniqueTableName("Range");
        await client.createTable(tableName, { hashKey: "PK", rangeKey: "SK" });

        for (let i = 0; i < 5; i++) {
            const res = await client.putItem(tableName, {
                PK: { S: `range_${i}_${Date.now()}` }, SK: { S: "t" }, V: { S: "x" }
            });
            const pid = Number(TestClient.getDebugHeaders(res)["x-shivam-db-partition-id-internal"]);
            expect(pid).toBeGreaterThanOrEqual(0);
            expect(pid).toBeLessThan(100);
        }
    });
});

// ============================================================================
// 4. DATA ISOLATION BETWEEN TABLES
// ============================================================================
describe("4. Data Isolation Between Tables", () => {
    const client = new TestClient();

    it("should not leak data from TableA to TableB", async () => {
        const tableA = TestClient.uniqueTableName("IsoA");
        const tableB = TestClient.uniqueTableName("IsoB");

        await client.createTable(tableA, { hashKey: "PK", rangeKey: "SK" });
        await client.createTable(tableB, { hashKey: "PK", rangeKey: "SK" });

        // Insert into TableA
        const putRes = await client.putItem(tableA, {
            PK: { S: "shared_pk" }, SK: { S: "data" }, Payload: { S: "belongs_to_A" }
        });
        expect(putRes.status).toBe(200);

        const dbgA = TestClient.getDebugHeaders(putRes);
        expect(dbgA["x-shivam-db-partition-key"]).toContain(tableA);

        // Try reading from TableB — should NOT find it
        const getRes = await client.getItem(tableB, {
            PK: { S: "shared_pk" }, SK: { S: "data" }
        });
        expect(getRes.status).toBe(200);
        const body = await getRes.json() as any;
        expect(body.Item).toBeUndefined();

        const dbgB = TestClient.getDebugHeaders(getRes);
        expect(dbgB["x-shivam-db-partition-key"]).toContain(tableB);
        // The partition keys should be different because they're scoped to different tables
        expect(dbgA["x-shivam-db-partition-key"]).not.toBe(dbgB["x-shivam-db-partition-key"]);

        console.log(`[TEST] Isolation: A=${dbgA["x-shivam-db-partition-key"]} B=${dbgB["x-shivam-db-partition-key"]}`);
    });

    it("should allow same PK in different tables independently", async () => {
        const tableA = TestClient.uniqueTableName("IndA");
        const tableB = TestClient.uniqueTableName("IndB");

        await client.createTable(tableA, { hashKey: "PK", rangeKey: "SK" });
        await client.createTable(tableB, { hashKey: "PK", rangeKey: "SK" });

        const sharedPK = "cross_table_pk";

        await client.putItem(tableA, {
            PK: { S: sharedPK }, SK: { S: "info" }, Source: { S: "from_A" }
        });
        await client.putItem(tableB, {
            PK: { S: sharedPK }, SK: { S: "info" }, Source: { S: "from_B" }
        });

        // Read from A
        const resA = await client.getItem(tableA, { PK: { S: sharedPK }, SK: { S: "info" } });
        const bodyA = await resA.json() as any;
        expect(bodyA.Item.Source.S).toBe("from_A");

        // Read from B
        const resB = await client.getItem(tableB, { PK: { S: sharedPK }, SK: { S: "info" } });
        const bodyB = await resB.json() as any;
        expect(bodyB.Item.Source.S).toBe("from_B");

        console.log("[TEST] Same PK different tables: isolation verified");
    });
});

// ============================================================================
// 5. SORT KEY (RANGE KEY) OPERATIONS
// ============================================================================
describe("5. Sort Key Operations", () => {
    const client = new TestClient();

    it("should store and retrieve multiple sort keys under same PK", async () => {
        const tableName = TestClient.uniqueTableName("SK");
        await client.createTable(tableName, { hashKey: "PK", rangeKey: "SK" });

        const pk = "user_sk_test";
        const sortKeys = ["profile", "settings", "avatar"];

        // Write all
        for (const sk of sortKeys) {
            const res = await client.putItem(tableName, {
                PK: { S: pk }, SK: { S: sk }, Data: { S: `data_for_${sk}` }
            });
            expect(res.status).toBe(200);
        }

        // Read all back
        for (const sk of sortKeys) {
            const res = await client.getItem(tableName, { PK: { S: pk }, SK: { S: sk } });
            const body = await res.json() as any;
            expect(body.Item).toBeDefined();
            expect(body.Item.Data.S).toBe(`data_for_${sk}`);
        }
        console.log(`[TEST] ${sortKeys.length} sort keys under same PK verified`);
    });

    it("should handle HASH-only table (no range key)", async () => {
        const tableName = TestClient.uniqueTableName("HashOnly");
        const createRes = await client.createTable(tableName, { hashKey: "id" });
        expect(createRes.status).toBe(200);

        await client.putItem(tableName, {
            id: { S: "item_1" }, Name: { S: "Test Item" }
        });

        const getRes = await client.getItem(tableName, { id: { S: "item_1" } });
        const body = await getRes.json() as any;
        expect(body.Item).toBeDefined();
        expect(body.Item.Name.S).toBe("Test Item");
    });
});

// ============================================================================
// 6. SCHEMA VALIDATION
// ============================================================================
describe("6. Schema Validation", () => {
    const client = new TestClient();

    it("should reject PutItem with wrong type for PK", async () => {
        const tableName = TestClient.uniqueTableName("ValType");
        await client.createTable(tableName, { hashKey: "PK", rangeKey: "SK", hashType: "S", rangeType: "S" });

        const res = await client.putItem(tableName, {
            PK: { N: "123" }, SK: { S: "valid" }
        });
        expect(res.status).toBe(400);
        const body = await res.json() as any;
        expect(body.__type).toBe("ValidationException");
    });

    it("should reject PutItem with wrong type for SK", async () => {
        const tableName = TestClient.uniqueTableName("ValSKType");
        await client.createTable(tableName, { hashKey: "PK", rangeKey: "SK", hashType: "S", rangeType: "S" });

        const res = await client.putItem(tableName, {
            PK: { S: "valid" }, SK: { N: "123" }
        });
        expect(res.status).toBe(400);
        const body = await res.json() as any;
        expect(body.__type).toBe("ValidationException");
    });

    it("should reject PutItem with missing PK", async () => {
        const tableName = TestClient.uniqueTableName("ValMiss");
        await client.createTable(tableName, { hashKey: "PK", rangeKey: "SK" });

        const res = await client.putItem(tableName, {
            SK: { S: "only_sk" }
        });
        expect(res.status).toBe(400);
    });

    it("should reject PutItem with missing SK on composite key table", async () => {
        const tableName = TestClient.uniqueTableName("ValMissSK");
        await client.createTable(tableName, { hashKey: "PK", rangeKey: "SK" });

        const res = await client.putItem(tableName, {
            PK: { S: "only_pk" }
        });
        expect(res.status).toBe(400);
    });

    it("should reject GetItem without TableName", async () => {
        const res = await client.dynamoRequest("DynamoDB_20120810.GetItem", {
            Key: { PK: { S: "test" }, SK: { S: "test" } }
        });
        expect(res.status).toBe(400);
    });

    it("should return ResourceNotFoundException for non-existent table", async () => {
        const res = await client.getItem("NoTable_" + Date.now(), {
            PK: { S: "test" }, SK: { S: "test" }
        });
        expect(res.status).toBe(400);
        const body = await res.json() as any;
        expect(body.__type).toBe("ResourceNotFoundException");
    });
});

// ============================================================================
// 7. DELETION & TOMBSTONING
// ============================================================================
describe("7. Deletion & Tombstoning", () => {
    const client = new TestClient();

    it("should delete an item and verify it is gone", async () => {
        const tableName = TestClient.uniqueTableName("Del");
        await client.createTable(tableName, { hashKey: "PK", rangeKey: "SK" });

        // Put
        await client.putItem(tableName, {
            PK: { S: "del_test" }, SK: { S: "item_1" }, Val: { S: "to_delete" }
        });

        // Verify exists
        const getRes1 = await client.getItem(tableName, {
            PK: { S: "del_test" }, SK: { S: "item_1" }
        });
        const body1 = await getRes1.json() as any;
        expect(body1.Item).toBeDefined();

        // Delete
        const delRes = await client.deleteItem(tableName, {
            PK: { S: "del_test" }, SK: { S: "item_1" }
        });
        expect(delRes.status).toBe(200);
        expect(TestClient.getDebugHeaders(delRes)["x-shivam-db-partition-id-internal"]).toBeDefined();

        // Verify gone (leader reads immediately reflect deletes)
        const getRes2 = await client.getItem(tableName, {
            PK: { S: "del_test" }, SK: { S: "item_1" }
        });
        const body2 = await getRes2.json() as any;
        expect(body2.Item).toBeUndefined();
        console.log("[TEST] Item deleted and verified gone");
    });

    it("should handle deleting non-existent item gracefully", async () => {
        const tableName = TestClient.uniqueTableName("DelNone");
        await client.createTable(tableName, { hashKey: "PK", rangeKey: "SK" });

        const res = await client.deleteItem(tableName, {
            PK: { S: "never_existed" }, SK: { S: "phantom" }
        });
        expect(res.status).toBe(200);
    });

    it("should allow re-inserting after deletion (append-only versioning)", async () => {
        const tableName = TestClient.uniqueTableName("Reinsert");
        await client.createTable(tableName, { hashKey: "PK", rangeKey: "SK" });

        const pk = "reinsert_test";
        const sk = "data";

        // Create v1
        await client.putItem(tableName, {
            PK: { S: pk }, SK: { S: sk }, Val: { S: "v1" }
        });

        // Delete
        await client.deleteItem(tableName, { PK: { S: pk }, SK: { S: sk } });

        // Verify gone
        const mid = await client.getItem(tableName, { PK: { S: pk }, SK: { S: sk } });
        expect((await mid.json() as any).Item).toBeUndefined();

        // Re-create with v2
        await client.putItem(tableName, {
            PK: { S: pk }, SK: { S: sk }, Val: { S: "v2_after_delete" }
        });

        // Should get v2
        const final = await client.getItem(tableName, { PK: { S: pk }, SK: { S: sk } });
        const body = await final.json() as any;
        expect(body.Item).toBeDefined();
        expect(body.Item.Val.S).toBe("v2_after_delete");
        console.log("[TEST] Append-only versioning: delete + re-insert verified");
    });
});

// ============================================================================
// 8. OVERWRITE / VERSIONING
// ============================================================================
describe("8. Overwrite & Versioning", () => {
    const client = new TestClient();

    it("should overwrite item with same PK+SK", async () => {
        const tableName = TestClient.uniqueTableName("Overwrite");
        await client.createTable(tableName, { hashKey: "PK", rangeKey: "SK" });

        const pk = "overwrite_pk";
        const sk = "data";

        // Write original
        await client.putItem(tableName, {
            PK: { S: pk }, SK: { S: sk }, Val: { S: "original" }
        });
        const get1 = await client.getItem(tableName, { PK: { S: pk }, SK: { S: sk } });
        expect((await get1.json() as any).Item.Val.S).toBe("original");

        // Overwrite
        await client.putItem(tableName, {
            PK: { S: pk }, SK: { S: sk }, Val: { S: "updated" }, Extra: { S: "new_field" }
        });
        const get2 = await client.getItem(tableName, { PK: { S: pk }, SK: { S: sk } });
        const body = await get2.json() as any;
        expect(body.Item.Val.S).toBe("updated");
        expect(body.Item.Extra.S).toBe("new_field");
        console.log("[TEST] Overwrite verified");
    });
});

// ============================================================================
// 9. UNSUPPORTED OPERATIONS
// ============================================================================
describe("9. Unsupported Operations", () => {
    const client = new TestClient();

    it("Query should return 501", async () => {
        const tableName = TestClient.uniqueTableName("Unsup");
        await client.createTable(tableName, { hashKey: "PK", rangeKey: "SK" });

        const res = await client.dynamoRequest("DynamoDB_20120810.Query", {
            TableName: tableName,
            KeyConditionExpression: "PK = :pk",
            ExpressionAttributeValues: { ":pk": { S: "test" } }
        });
        expect(res.status).toBe(501);
        const body = await res.json() as any;
        expect(body.__type).toBe("NotImplemented");
    });

    it("Scan should return 501", async () => {
        const tableName = TestClient.uniqueTableName("UnsupScan");
        await client.createTable(tableName, { hashKey: "PK" });

        const res = await client.dynamoRequest("DynamoDB_20120810.Scan", {
            TableName: tableName
        });
        expect(res.status).toBe(501);
    });

    it("UpdateItem should return 501", async () => {
        const tableName = TestClient.uniqueTableName("UnsupUpdate");
        await client.createTable(tableName, { hashKey: "PK", rangeKey: "SK" });

        const res = await client.dynamoRequest("DynamoDB_20120810.UpdateItem", {
            TableName: tableName,
            Key: { PK: { S: "test" }, SK: { S: "test" } },
            UpdateExpression: "SET #v = :v",
            ExpressionAttributeNames: { "#v": "val" },
            ExpressionAttributeValues: { ":v": { S: "new" } }
        });
        expect(res.status).toBe(501);
    });

    it("BatchWriteItem should return 501", async () => {
        const tableName = TestClient.uniqueTableName("UnsupBatch");
        await client.createTable(tableName, { hashKey: "PK" });

        const res = await client.dynamoRequest("DynamoDB_20120810.BatchWriteItem", {
            RequestItems: { [tableName]: [] }
        });
        expect(res.status).toBe(501);
    });
});

// ============================================================================
// 10. EDGE CASES & ERROR HANDLING
// ============================================================================
describe("10. Edge Cases", () => {
    const client = new TestClient();

    it("should handle long partition key values", async () => {
        const tableName = TestClient.uniqueTableName("EdgeLong");
        await client.createTable(tableName, { hashKey: "PK", rangeKey: "SK" });

        const longPK = "x".repeat(500);
        const res = await client.putItem(tableName, {
            PK: { S: longPK }, SK: { S: "test" }, Val: { S: "long_pk" }
        });
        expect(res.status).toBe(200);
        expect(TestClient.getDebugHeaders(res)["x-shivam-db-partition-id-internal"]).toBeDefined();
    });

    it("should handle special characters in keys", async () => {
        const tableName = TestClient.uniqueTableName("EdgeSpec");
        await client.createTable(tableName, { hashKey: "PK", rangeKey: "SK" });

        const specialPK = "user@email.com/path?query=1&b=2#frag";
        await client.putItem(tableName, {
            PK: { S: specialPK }, SK: { S: "info/detail" }, Val: { S: "special" }
        });

        const getRes = await client.getItem(tableName, {
            PK: { S: specialPK }, SK: { S: "info/detail" }
        });
        const body = await getRes.json() as any;
        expect(body.Item?.Val?.S).toBe("special");
    });

    it("should handle numeric type keys", async () => {
        const tableName = TestClient.uniqueTableName("EdgeNum");
        await client.createTable(tableName, { hashKey: "id", hashType: "N" });

        await client.putItem(tableName, { id: { N: "42" }, Name: { S: "Numeric PK" } });

        const getRes = await client.getItem(tableName, { id: { N: "42" } });
        const body = await getRes.json() as any;
        expect(body.Item?.Name?.S).toBe("Numeric PK");
    });

    it("should include request timestamp in debug headers", async () => {
        const tableName = TestClient.uniqueTableName("EdgeTS");
        await client.createTable(tableName, { hashKey: "PK", rangeKey: "SK" });

        const before = Date.now();
        const res = await client.putItem(tableName, {
            PK: { S: "ts_test" }, SK: { S: "check" }, V: { S: "timing" }
        });
        const after = Date.now();

        const ts = Number(TestClient.getDebugHeaders(res)["x-shivam-db-request-ts"]);
        expect(ts).toBeGreaterThanOrEqual(before);
        expect(ts).toBeLessThanOrEqual(after);
    });

    it("should reject missing x-amz-target header", async () => {
        const res = await client.fetch("/api", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ TableName: "test" })
        });
        expect(res.status).toBe(400);
    });
});

// ============================================================================
// 11. DEBUG HEADER COMPLETENESS
// ============================================================================
describe("11. Debug Header Completeness", () => {
    const client = new TestClient();

    it("PutItem should have all expected headers", async () => {
        const tableName = TestClient.uniqueTableName("HdrPut");
        await client.createTable(tableName, { hashKey: "PK", rangeKey: "SK" });

        const res = await client.putItem(tableName, {
            PK: { S: "hdr" }, SK: { S: "put" }, V: { S: "x" }
        });
        const dbg = TestClient.getDebugHeaders(res);

        const expected = [
            "x-shivam-db-op",
            "x-shivam-db-request-ts",
            "x-shivam-db-partition-id-internal",
            "x-shivam-db-partition-key",
            "x-shivam-db-table",
            "x-shivam-db-sk",
            "x-shivam-db-leader-do",
            "x-shivam-db-sub-do-reached-ts",
            "x-shivam-db-sub-do-latency-ms",
        ];

        for (const h of expected) {
            expect(dbg[h], `Missing header: ${h}`).toBeDefined();
        }
        console.log("[TEST] PutItem headers complete:", JSON.stringify(dbg, null, 2));
    });

    it("GetItem should have read-target header", async () => {
        const tableName = TestClient.uniqueTableName("HdrGet");
        await client.createTable(tableName, { hashKey: "PK", rangeKey: "SK" });

        await client.putItem(tableName, { PK: { S: "hdr" }, SK: { S: "get" }, V: { S: "x" } });

        const res = await client.getItem(tableName, { PK: { S: "hdr" }, SK: { S: "get" } });
        const dbg = TestClient.getDebugHeaders(res);

        expect(dbg["x-shivam-db-read-target"]).toBeDefined();
        expect(dbg["x-shivam-db-partition-id-internal"]).toBeDefined();
        expect(dbg["x-shivam-db-sub-do-reached-ts"]).toBeDefined();
        console.log("[TEST] GetItem headers:", JSON.stringify(dbg, null, 2));
    });

    it("Control plane ops should not have partition headers", async () => {
        const res = await client.listTables();
        const dbg = TestClient.getDebugHeaders(res);

        expect(dbg["x-shivam-db-op"]).toBe("ListTables");
        expect(dbg["x-shivam-db-partition-id-internal"]).toBeUndefined();
    });

    it("DeleteItem should have partition and latency headers", async () => {
        const tableName = TestClient.uniqueTableName("HdrDel");
        await client.createTable(tableName, { hashKey: "PK", rangeKey: "SK" });

        const res = await client.deleteItem(tableName, { PK: { S: "hdr" }, SK: { S: "del" } });
        const dbg = TestClient.getDebugHeaders(res);

        expect(dbg["x-shivam-db-op"]).toBe("DeleteItem");
        expect(dbg["x-shivam-db-partition-id-internal"]).toBeDefined();
        expect(dbg["x-shivam-db-sub-do-reached-ts"]).toBeDefined();
        expect(dbg["x-shivam-db-sub-do-latency-ms"]).toBeDefined();
    });
});
